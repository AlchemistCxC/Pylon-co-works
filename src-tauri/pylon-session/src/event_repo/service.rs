//! 事件仓库 service：spawn_blocking 边界 + DTO 透传（镜像 MessageService）。

use std::path::Path;
use std::sync::Arc;

use super::normalize::{mark_replay_import, normalize_kernel_event, parse_canonical_event};
use super::repo::{EventRepo, RollupTrimReport};
use super::row::{
    CanonicalEventRawExport, CanonicalEventRow, EventAppendResult, EventPage, EventSearchOwner,
    KernelEventInput, ReplayJournalIngestResult,
};
use super::EventError;
use crate::owner::DurableSessionOwner;

/// 事件仓库 service：spawn_blocking 边界 + DTO 透传（镜像 MessageService）。
pub struct EventService {
    pub(super) repo: Arc<EventRepo>,
}

impl EventService {
    /// 打开（或创建）生产仓库并迁移到最新 schema。调用方须先创建 DB 父目录；
    /// 失败返回 Err——启动路径不得静默回退。
    pub fn open_db(path: &Path) -> Result<EventService, EventError> {
        let repo = EventRepo::open(path)?;
        Ok(EventService {
            repo: Arc::new(repo),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存服务
    pub fn in_memory() -> Result<EventService, EventError> {
        let repo = EventRepo::open_in_memory()?;
        Ok(EventService {
            repo: Arc::new(repo),
        })
    }

    /// 校验 + 批量 append（spawn_blocking 边界）。输入为前端 EVT-01 schema JSON。
    pub async fn append_events(
        &self,
        input: Vec<serde_json::Value>,
        expected_revision: Option<i64>,
    ) -> Result<EventAppendResult, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let events = input
                .iter()
                .map(parse_canonical_event)
                .collect::<Result<Vec<_>, _>>()?;
            repo.append_events(&events, expected_revision)
        })
        .await
        .map_err(|error| {
            EventError::Unavailable(format!("event repo append task failed: {error}"))
        })?
    }

    /// Kernel ingest boundary：sequence/revision 在 repository transaction 内分配，
    /// 返回 committed row，供 dispatcher 在 durable append 后发布 projection。
    pub async fn ingest_event(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        raw_payload: serde_json::Value,
    ) -> Result<EventAppendResult, EventError> {
        self.ingest_events(
            owner,
            remote_session_id,
            client_generation,
            vec![raw_payload],
        )
        .await
    }

    /// Kernel batch ingest boundary：同一 owner 的多条 live raw payload 共享一次
    /// repository transaction，仍逐条 normalize/append，并返回实际提交的行（含 terminal
    /// 触发的 turn.unit）。调用方负责在窗口/消息边界 flush；单事件入口委托到这里以保证
    /// 两条路径永远共享同一 sequence、tombstone 和 rollup 语义。
    pub async fn ingest_events(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        raw_payloads: Vec<serde_json::Value>,
    ) -> Result<EventAppendResult, EventError> {
        let client_generation = i64::try_from(client_generation)
            .map_err(|_| EventError::Invalid("client generation exceeds i64".into()))?;
        let inputs = raw_payloads
            .into_iter()
            .map(|raw_payload| KernelEventInput {
                owner: owner.clone(),
                remote_session_id: remote_session_id.clone(),
                client_generation,
                received_at: chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                raw_payload,
                recovery_import: false,
            })
            .collect();
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.ingest_kernel_events(inputs))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("kernel event ingest task failed: {error}"))
            })?
    }

    /// Import a complete session/load replay into the single owner journal. Only an empty journal
    /// may be imported. Any trusted local observation wins; a revision race is treated as local
    /// authority (or an idempotent unverified import), never as permission to append a snapshot.
    pub async fn ingest_complete_replay(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        raw_events: Vec<serde_json::Value>,
    ) -> Result<ReplayJournalIngestResult, EventError> {
        let client_generation = i64::try_from(client_generation)
            .map_err(|_| EventError::Invalid("client generation exceeds i64".into()))?;
        let received_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let owner_key = owner
                .key()
                .map_err(|error| EventError::Invalid(error.to_string()))?;
            if repo.has_authoritative_local_events(&owner_key)? {
                return Ok(ReplayJournalIngestResult {
                    events: Vec::new(),
                    revision: repo.revision(&owner_key)?,
                    status: "local-authoritative",
                });
            }
            let replay_events = raw_events
                .into_iter()
                .map(|raw| mark_replay_import(&owner, raw))
                .collect::<Vec<_>>();
            if replay_events.is_empty() {
                let owner_key = owner
                    .key()
                    .map_err(|error| EventError::Invalid(error.to_string()))?;
                let revision = repo.revision(&owner_key)?;
                return Ok(ReplayJournalIngestResult {
                    events: Vec::new(),
                    revision,
                    status: if revision == 0 {
                        "empty"
                    } else {
                        "already-imported"
                    },
                });
            }
            let mut events = Vec::with_capacity(replay_events.len());
            for (index, raw_payload) in replay_events.into_iter().enumerate() {
                events.push(normalize_kernel_event(
                    KernelEventInput {
                        owner: owner.clone(),
                        remote_session_id: remote_session_id.clone(),
                        client_generation,
                        received_at: received_at.clone(),
                        raw_payload,
                        recovery_import: true,
                    },
                    i64::try_from(index + 1).map_err(|_| {
                        EventError::Invalid("replay event count exceeds i64".into())
                    })?,
                )?);
            }
            match repo.append_events(&events, Some(0)) {
                Ok(result) => Ok(ReplayJournalIngestResult {
                    events: result.events,
                    revision: result.revision,
                    status: "imported",
                }),
                Err(EventError::RevisionConflict { .. }) => {
                    let local_authority = repo.has_authoritative_local_events(&owner_key)?;
                    Ok(ReplayJournalIngestResult {
                        events: Vec::new(),
                        revision: repo.revision(&owner_key)?,
                        status: if local_authority {
                            "local-authoritative"
                        } else {
                            "already-imported"
                        },
                    })
                }
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| {
            EventError::Unavailable(format!("replay event ingest task failed: {error}"))
        })?
    }

    /// owner 当前 revision（MAX(sequence)，空 = 0）。
    pub async fn revision(&self, owner_key: String) -> Result<i64, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.revision(&owner_key))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo revision task failed: {error}"))
            })?
    }

    /// Read-only authority probe used before deciding how an incomplete replay may be surfaced.
    /// It deliberately ignores recovery-import rows: only durable local observations establish
    /// the local journal as the load authority.
    pub async fn has_authoritative_local_events(
        &self,
        owner_key: String,
    ) -> Result<bool, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.has_authoritative_local_events(&owner_key))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo authority task failed: {error}"))
            })?
    }

    /// 游标分页读取（最新页 before_seq=null；limit 缺省 100）。
    pub async fn list_events(
        &self,
        owner_key: String,
        before_sequence: Option<i64>,
        limit: u32,
    ) -> Result<EventPage, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.list_events(&owner_key, before_sequence, limit))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo list task failed: {error}"))
            })?
    }

    /// #51 收口：写入侧幂等判定的读支撑——owner journal 里最新一条指定类型事件。
    pub async fn latest_event_of_type(
        &self,
        owner_key: String,
        event_type: &'static str,
    ) -> Result<Option<CanonicalEventRow>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.latest_event_of_type(&owner_key, event_type))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo latest task failed: {error}"))
            })?
    }

    /// #81 L2：compact 读（单元 + 未覆盖行；文档投影/搜索的读取入口）。
    pub async fn load_events_compact(
        &self,
        owner_key: String,
    ) -> Result<Vec<CanonicalEventRow>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.load_events_compact(&owner_key))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo compact task failed: {error}"))
            })?
    }

    /// #81 L3：裁剪迁移（应用关闭时调用；budget_ms 控制单次预算，可续跑）。
    pub async fn rollup_trim(
        &self,
        budget_ms: Option<u64>,
    ) -> Result<RollupTrimReport, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.rollup_trim(budget_ms))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo trim task failed: {error}"))
            })?
    }

    /// #81 L3：剩余未裁剪单元数（策略关闭时的报告数据源）。
    pub async fn count_remaining_rollup_units(&self) -> Result<i64, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.count_remaining_rollup_units())
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo trim count task failed: {error}"))
            })?
    }

    pub async fn export_raw_event(
        &self,
        event_id: String,
    ) -> Result<Option<CanonicalEventRawExport>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.export_raw_event(&event_id))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event raw export task failed: {error}"))
            })?
    }

    /// B6：跨 owner 内容搜索候选（前端消息级精确过滤的第二阶段数据源）。
    pub async fn search_owners(
        &self,
        query: String,
        limit: u32,
    ) -> Result<Vec<EventSearchOwner>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.search_owners(&query, limit))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo search task failed: {error}"))
            })?
    }
}
