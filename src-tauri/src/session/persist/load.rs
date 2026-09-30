//! `load_persisted_session` 命令正身（#486 项3 自 persist/mod.rs 拆出）。
//!
//! 编排层只保留 capture 三终态的分派；Loaded 臂（~200 行：journal 导入、store
//! 应用、attach、trace/快照组装）与 LoadFailed 臂（有界 trace + 回滚）拆为
//! 本文件的两个子函数。语句次序、日志键序与回滚时序逐字保留（行为不变）。

use super::{
    journal_turn_boundary, ledger_turn_boundary, replay_journal_commit_outcome,
    replay_load_error_code, rollback_load_slot_else, run_load_with_replay_capture, LoadedReplay,
    PersistedSessionLoadResult, ReplayCollection, ReplayImport, ReplayLoadArgs, ReplayLoadOutcome,
};
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::session::model::SessionInfo;
use crate::session::owner::DurableSessionOwner;
use crate::session::AppState;
use std::sync::Arc;

/// Loaded 臂正身：代际复核 → journal 导入/权威判定 → store 快照应用 → attach →
/// 选择器面入 journal → replay trace + turn 快照 → wire 结果组装。
/// 所有失败路径经 `rollback_load_slot_else` 回滚（回滚失败优先于原错误，既有语义）。
#[allow(clippy::too_many_arguments)]
async fn finish_loaded_load(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    peri_id: &str,
    generation: u64,
    owner: &DurableSessionOwner,
    mut response: serde_json::Value,
    replay: LoadedReplay,
    previous: Option<SessionInfo>,
) -> Result<serde_json::Value, PylonError> {
    if let Err(error) = state.ensure_generation(runtime, generation) {
        return Err(rollback_load_slot_else(
            runtime,
            source,
            peri_id,
            generation,
            previous,
            error.into(),
        ));
    }
    let owner_key = owner.key()?;
    let journal_result: Result<(i64, &'static str), PylonError> = async {
        if replay.metadata.complete {
            let ingest = crate::session::event_service_of(state)?
                .ingest_complete_replay(
                    owner.clone(),
                    Some(peri_id.to_string()),
                    generation,
                    replay.events.clone(),
                )
                .await?;
            Ok((ingest.revision, ingest.status))
        } else {
            let events = crate::session::event_service_of(state)?;
            let revision = events.revision(owner_key.clone()).await?;
            let status = if events
                .has_authoritative_local_events(owner_key.clone())
                .await?
            {
                "local-authoritative"
            } else {
                "incomplete-not-imported"
            };
            Ok((revision, status))
        }
    }
    .await;
    let (canonical_revision, replay_journal_status) = match journal_result {
        Ok(result) => result,
        Err(error) => {
            return Err(rollback_load_slot_else(
                runtime, source, peri_id, generation, previous, error,
            ))
        }
    };
    let persisted_state_result: Result<Option<serde_json::Value>, PylonError> = async {
        crate::session::message_service_of(state)?
            .get_session_state(owner.clone())
            .await
            .map_err(Into::into)
    }
    .await;
    let persisted_state = match persisted_state_result {
        Ok(state) => state,
        Err(error) => {
            return Err(rollback_load_slot_else(
                runtime, source, peri_id, generation, previous, error,
            ))
        }
    };
    let apply_result =
        state.with_session_if_matches(runtime, source, peri_id, generation, |session| {
            session.apply_session_response(&response);
            if let Some(persisted) = &persisted_state {
                if let Some(object) = persisted.as_object() {
                    if let Some(value) = object.get("commands") {
                        session.commands_snapshot = Some(value.clone());
                    }
                    if let Some(value) = object.get("usage") {
                        session.usage_snapshot = Some(value.clone());
                    }
                    if let Some(value) = object.get("mode").and_then(|v| v.as_str()) {
                        session.mode = Some(value.to_string());
                    }
                }
            }
            session.replay_loading = false;
            super::restore_session_state(session, &mut response);
        });
    if let Err(error) = apply_result {
        return Err(rollback_load_slot_else(
            runtime,
            source,
            peri_id,
            generation,
            previous,
            error.into(),
        ));
    }
    let attached = crate::session::store::mark_attached_if_current(
        runtime, source, peri_id, generation, generation,
    )
    .map_err(|error| PylonError::Protocol(error.to_string()))?;
    if !attached {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    // #51：恢复期选择器面入 journal（与 create_session_slot 建立期写入对称）
    // ——重启后打开历史会话时，document.session.options（中控区 model/
    // reasoning/mode 候选）由 journal 重放恢复；load 响应本身只进 store 层。
    let load_options = crate::session::create::response_projection_options(&response);
    let _ = crate::session::create::ingest_established_config_options_event(
        state,
        runtime,
        source,
        peri_id,
        generation,
        &load_options,
    )
    .await;
    let authority = match replay_journal_status {
        "local-authoritative" => "local-journal",
        "imported" | "already-imported" => "recovery-import",
        _ if canonical_revision > 0 => "recovery-import",
        _ => "empty",
    };
    let journal_coverage = match replay_journal_status {
        "local-authoritative" => "local-observed",
        "imported" | "already-imported" => "unverified-import",
        _ if canonical_revision > 0 => "unverified-import",
        _ => "empty",
    };
    let collection = ReplayCollection {
        complete: replay.metadata.complete,
        truncated: replay.metadata.truncated,
        dropped_count: replay.metadata.dropped_count,
    };
    let import = match replay_journal_status {
        "imported" => Some(ReplayImport {
            import_id: format!("{}:{}:{}", owner.agent_id, owner.local_session_id, peri_id),
            status: "imported",
            trust: "unverified",
        }),
        "already-imported" => Some(ReplayImport {
            import_id: format!("{}:{}:{}", owner.agent_id, owner.local_session_id, peri_id),
            status: "already-imported",
            trust: "unverified",
        }),
        _ => None,
    };
    // A-04/C0-FAIL：backend and frontend traces share owner + generation.
    // The frontend's paired `load-commit` entry adds projection outcome;
    // this entry records the transport capture and journal commit facts.
    tracing::info!(
        target: "replay_trace",
        owner = %owner_key,
        load_generation = generation,
        capture_lp = "active-replay-registry",
        response_boundary = replay.metadata.boundary.kind,
        observed_count = replay.metadata.boundary.observed_count,
        retained_count = replay.events.len() as u64,
        dropped_count = replay.metadata.dropped_count,
        authority,
        canonical_revision,
        journal_status = replay_journal_status,
        commit_outcome = replay_journal_commit_outcome(replay_journal_status),
        projection_commit = "deferred-to-frontend-coordinator",
        "session/load replay trace"
    );
    let diagnostics = if replay.metadata.complete {
        Vec::new()
    } else {
        vec![serde_json::json!({
            "code": "replay_incomplete",
            "owner": owner_key,
            "provider": owner.agent_id,
            "stage": "session/load",
            "revision": canonical_revision,
            "recoverability": "retry-or-export",
        })]
    };
    // #99：冷挂载 turn 快照——在 replay_loading 清位后从后端权威状态
    // （turn 账本 + ingress 序列 cursor + lastError）合成。
    // #442 Step1：turnBoundary 与快照出自同一份账本读（cold_mount_facts）；
    // 账本为空时走 journal tail 判据（`journal_turn_boundary`）。
    let (turn_snapshot, turn_boundary) = match runtime.cold_mount_facts(source).await {
        Some((snapshot, record)) => {
            let boundary = match record {
                Some(turn) => Some(ledger_turn_boundary(&turn)),
                None => journal_turn_boundary(state, &owner_key).await,
            };
            (Some(snapshot), boundary)
        }
        None => (None, None),
    };
    serde_json::to_value(PersistedSessionLoadResult {
        response,
        replay: replay.events,
        replay_metadata: replay.metadata,
        canonical_revision,
        replay_journal_status,
        authority,
        journal_coverage,
        collection,
        import,
        diagnostics,
        turn: turn_snapshot,
        turn_boundary,
    })
    .map_err(|error| PylonError::from(error.to_string()))
}

/// LoadFailed 臂正身：失败路径仍发有界 trace（各计数显式归零——采集器未观测到
/// 边界时不声称完整批次），随后按既有次序回滚槽位（回滚失败优先于原错误）。
fn trace_and_rollback_failed_load(
    owner: &DurableSessionOwner,
    generation: u64,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    peri_id: &str,
    error: crate::acp::AcpError,
    previous: Option<SessionInfo>,
) -> PylonError {
    let owner_key = owner
        .key()
        .unwrap_or_else(|_| "<invalid-owner>".to_string());
    tracing::warn!(
        target: "replay_trace",
        owner = %owner_key,
        load_generation = generation,
        capture_lp = "active-replay-registry",
        response_boundary = "not-observed",
        observed_count = 0_u64,
        retained_count = 0_u64,
        dropped_count = 0_u64,
        authority = "none",
        canonical_revision = 0_i64,
        journal_status = "load-error",
        commit_outcome = "load-error",
        projection_commit = "not-started",
        error_code = replay_load_error_code(&error),
        "session/load replay trace"
    );
    rollback_load_slot_else(
        runtime,
        source,
        peri_id,
        generation,
        previous,
        PylonError::from(error),
    )
}

/// ACP-01/恢复历史会话命令（原 persist/mod.rs :235-532；编排层三终态分派）。
#[tauri::command]
#[allow(clippy::await_holding_invalid_type)] // session_creation 跨 await：load/恢复与并发建立串行（同 new_session）
pub(crate) async fn load_persisted_session(
    state: tauri::State<'_, AppState>,
    owner: DurableSessionOwner,
    peri_id: String,
    cwd: Option<String>,
    workspace_id: Option<String>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, PylonError> {
    owner.validate()?;
    let agent_id = owner.agent_id.clone();
    let source = owner.local_session_id.clone();
    // OWNER-02（§5.8）：显式 agentId 路由到 owner runtime——恢复历史会话时本地映射
    // 尚不存在（load 本身建立会话槽位），故不要求会话已存在；不存在 owner runtime →
    // agent_runtime_unavailable，绝不 fallback active runtime。
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    let _creation_guard = runtime.session_creation.lock().await;
    let generation = state.current_generation(&runtime);
    // CWD-03：Workspace 绑定优先（root_path 单一来源）；未绑定走 cwd 缺省链。
    let (cwd, workspace_id) =
        crate::workspaces::resolve_session_cwd(state.inner(), cwd, workspace_id)?;
    // mcp_servers 必须随 session/load 发送：ACP schema 1.4 该字段无 default，
    // Hermes（Pydantic）缺失即拒绝；Peri 容忍。无配置时 validate 产出空数组。
    let mcp_servers = crate::mcp::validate_and_serialize(mcp_servers)?;
    // 与 new_session / send_message 自动创建一致，恢复历史会话也受上限约束；
    // 同 source 重载（替换）不占新名额（R32：检查与插入统一在槽位辅助内）。
    let mut loading_session = SessionInfo::new(
        peri_id.clone(),
        String::new(),
        cwd.clone(),
        true,
        generation,
    );
    loading_session.profile_id = Some(owner.profile_id.clone());
    // CWD-03：恢复历史会话沿用 workspace 绑定（None = legacy 未绑定，root 解析回退 cwd）。
    loading_session.workspace_id = workspace_id;
    loading_session.replay_loading = true;
    // P3（W3 重构批次）：loading 槽插入 → capture → 锁外 load 三步收敛到共享
    // helper（create.rs revive_session_slot 同构骨架）；persist 侧错误策略保持
    // 原样——capture 被拒上抛原错误；load 失败经 rollback_load_slot_else
    // （回滚失败优先于原错误）。
    match run_load_with_replay_capture(ReplayLoadArgs {
        runtime: &runtime,
        source: &source,
        peri_id: &peri_id,
        generation,
        cwd: &cwd,
        mcp_servers,
        mode: state.protocol_for_runtime(&runtime).mcp_servers,
        loading_session,
        log_label: "replay",
    })
    .await
    {
        Ok(ReplayLoadOutcome::Loaded {
            response,
            replay,
            previous,
        }) => {
            finish_loaded_load(
                state.inner(),
                &runtime,
                &source,
                &peri_id,
                generation,
                &owner,
                response,
                replay,
                previous,
            )
            .await
        }
        Ok(ReplayLoadOutcome::CaptureRejected { error }) => Err(error.into()),
        Ok(ReplayLoadOutcome::LoadFailed { error, previous }) => {
            Err(trace_and_rollback_failed_load(
                &owner, generation, &runtime, &source, &peri_id, error, previous,
            ))
        }
        // 槽位插入失败（原 `?` 传播语义，收敛为 match 臂后逐位一致）。
        Err(error) => Err(error),
    }
}
