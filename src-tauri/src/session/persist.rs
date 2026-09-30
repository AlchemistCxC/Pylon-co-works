//! 会话持久化域：恢复历史会话 / 会话清单。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use super::*;
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionLoadResult {
    response: serde_json::Value,
    replay: Vec<serde_json::Value>,
    replay_metadata: crate::acp::ReplayMetadata,
    canonical_revision: i64,
    replay_journal_status: &'static str,
    authority: &'static str,
    journal_coverage: &'static str,
    collection: ReplayCollection,
    import: Option<ReplayImport>,
    diagnostics: Vec<serde_json::Value>,
    /// #99：冷挂载 turn 快照（turnState/terminalCause/sequence/lastError/
    /// replayLoading）——前端恢复只凭本响应，不依赖一次性 Tauri event。
    turn: Option<serde_json::Value>,
    /// #442 Step1：最新回合边界（kind + 两端时间戳，camelCase wire
    /// `turnBoundary`）。账本有记录即权威（journal 终态行的落盘时序不再影响
    /// 结论——前端「或」判定的时序裂缝解法）；账本为空（重启后的历史会话）
    /// 走 journal tail 判据合成（照抄前端 `latestTurnBoundary`，ADR-0029）。
    /// None = 无会话映射或 journal 探测失败（前端回退现有判定轨）。
    turn_boundary: Option<pylon_session::TurnBoundary>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayCollection {
    complete: bool,
    truncated: bool,
    dropped_count: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayImport {
    import_id: String,
    status: &'static str,
    trust: &'static str,
}

/// Stable, machine-readable journal outcome used by the replay trace.  The
/// projection commit is performed by the frontend coordinator and is recorded
/// in its paired `load-commit` trace; this value describes the backend journal
/// stage only.
fn replay_journal_commit_outcome(status: &str) -> &'static str {
    match status {
        "imported" => "recovery-import-committed",
        "already-imported" => "recovery-import-already-present",
        "local-authoritative" => "local-journal-wins",
        "incomplete-not-imported" => "incomplete-preserved-runtime",
        "empty" => "empty",
        _ => "journal-observed",
    }
}

fn replay_load_error_code(error: &crate::acp::AcpError) -> &'static str {
    // #317 批次二 2c：词汇表单源化到 AcpError::code()（本函数保留为回放语义命名点）。
    error.code()
}

/// #442 Step1：账本记录 → `turnBoundary`（账本存在即权威：有 terminal 即收敛、
/// 无即在途，journal 终态行的落盘时序不参与结论——这正是前端跨源「或」判定
/// 被迫存在的时序裂缝，账本路径下按构造消除）。
fn ledger_turn_boundary(turn: &crate::acp::turn_ledger::TurnRecord) -> pylon_session::TurnBoundary {
    match &turn.terminal {
        Some(terminal) => pylon_session::TurnBoundary {
            kind: pylon_session::TurnBoundaryKind::Terminal,
            started_at_ms: Some(turn.started_at_ms),
            ended_at_ms: Some(terminal.settled_at_ms),
        },
        None => pylon_session::TurnBoundary {
            kind: pylon_session::TurnBoundaryKind::Open,
            started_at_ms: Some(turn.started_at_ms),
            ended_at_ms: None,
        },
    }
}

/// #442 Step1：journal tail 判据合成 `turnBoundary`（账本为空的回退数据面：
/// 重启后的历史会话、或本进程从未 prompt 过该 source）。查询失败降级为字段
/// 缺省（前端回退现有判定轨），不阻塞 load 响应。
async fn journal_turn_boundary(
    state: &AppState,
    owner_key: &str,
) -> Option<pylon_session::TurnBoundary> {
    let event_service = crate::session::event_service_of(state).ok()?;
    match event_service
        .turn_boundary_rows(
            owner_key.to_string(),
            pylon_session::turn_boundary::BOUNDARY_TAIL_CAP,
        )
        .await
    {
        Ok(rows) => pylon_session::turn_boundary::derive_turn_boundary(&rows),
        Err(error) => {
            tracing::warn!(
                owner = %owner_key,
                error = %error,
                "turnBoundary journal probe failed; omitting field (frontend keeps its fallback track)"
            );
            None
        }
    }
}

/// load_persisted_session 各失败臂共用的收敛：先回滚本次临时 slot，回滚成功
/// 返回原错误（调用方 `return Err(...)` 上抛），回滚自身失败则上抛回滚错误
/// （与原 `restore_previous_slot(...)?` 的传播序一致：回滚失败优先于原错误）。
/// #261：五处 `rollback + return` 样板收敛到单点。
fn rollback_load_slot_else(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
    previous: Option<SessionInfo>,
    original: PylonError,
) -> PylonError {
    match restore_previous_slot(runtime, source, peri_id, generation, previous) {
        Ok(()) => original,
        Err(restore_error) => restore_error,
    }
}

/// P3（W3 重构批次）：persist / revive 两条 load 链共享骨架的载荷类型。
/// `LoadedReplay` 以同形字段（events/metadata）承接 `pylon_acp::replay::ReplayBatch`
/// （该类型未在 crate 边界再导出，不可命名），消费方字段路径不变。
pub(super) struct LoadedReplay {
    pub(super) events: Vec<serde_json::Value>,
    pub(super) metadata: crate::acp::ReplayMetadata,
}

/// [`run_load_with_replay_capture`] 的结果分类。`previous` 归还调用方，供各自
/// 的错误策略（persist = 回滚失败优先上抛；revive = `let _` 忽略回滚错误）消费。
pub(super) enum ReplayLoadOutcome {
    Loaded {
        response: serde_json::Value,
        replay: LoadedReplay,
        previous: Option<SessionInfo>,
    },
    /// 同 owner 已有 load（ReplayLoadInProgress 等无副作用拒绝）；槽位已由
    /// helper 回滚（失败仅记录日志）。
    CaptureRejected { error: crate::acp::AcpError },
    /// load 失败；**槽位未回滚**——两侧回滚时序不同（persist 在 trace 之后、
    /// revive 在内层 generation 检查之后），由调用方按既有次序自行回滚。
    LoadFailed {
        error: crate::acp::AcpError,
        previous: Option<SessionInfo>,
    },
}

/// [`run_load_with_replay_capture`] 入参装配。`log_label` 仅用于 capture 被拒时
/// 回滚失败日志的域标签（persist = "replay"、revive = "revive"，与拆分前逐字一致）。
pub(super) struct ReplayLoadArgs<'a> {
    pub(super) runtime: &'a AgentRuntime,
    pub(super) source: &'a str,
    pub(super) peri_id: &'a str,
    pub(super) generation: u64,
    pub(super) cwd: &'a str,
    pub(super) mcp_servers: Vec<serde_json::Value>,
    pub(super) mode: crate::agent_config::McpServersMode,
    pub(super) loading_session: SessionInfo,
    pub(super) log_label: &'a str,
}

/// P3（W3 重构批次）：persist（`load_persisted_session`）与 revive（create.rs
/// `revive_session_slot`）两条 load 链的同构骨架——「loading 临时槽插入 →
/// begin_replay_capture（锁内原子登记）→ 锁外 load_session_with_replay 等待」
/// 三步逐行等价收敛到单点。两侧**错误策略是契约差异，不在本 helper 内合并**：
/// - persist 侧：capture 被拒 → 上抛原错误；load 失败 → `rollback_load_slot_else`（回滚失败优先于原错误）。
/// - revive 侧：capture 被拒 / load 失败 → 降级 `Ok(None)` 新建；回滚失败仅记录，外层 generation 臂用 `let _` 忽略回滚错误（既有语义，非遗漏）。
///
/// capture 被拒的「回滚 + 失败日志」两侧逐字相同（仅域标签不同），由本 helper
/// 承担；slot 插入失败（`?`）两侧同为 Err 上抛。
pub(super) async fn run_load_with_replay_capture(
    args: ReplayLoadArgs<'_>,
) -> Result<ReplayLoadOutcome, PylonError> {
    let ReplayLoadArgs {
        runtime,
        source,
        peri_id,
        generation,
        cwd,
        mcp_servers,
        mode,
        loading_session,
        log_label,
    } = args;
    let previous = replace_session_slot(
        runtime,
        source,
        loading_session,
        true,
        crate::agent::runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    // A-02/#349 B1：锁内原子建立 replay capture，等待在锁外进行——回放最长 30s，
    // 不阻塞其他命令。若同 owner 已有 load，拒绝新请求并撤销本次临时 slot，避免
    // 失败请求覆盖首个 load 的绑定/状态（ReplayLoadInProgress 是无副作用的拒绝路径）。
    let handles = match runtime.acp.lock().await.begin_replay_capture(peri_id) {
        Ok(handles) => handles,
        Err(error) => {
            if let Err(restore_error) =
                restore_previous_slot(runtime, source, peri_id, generation, previous)
            {
                tracing::error!(
                    source,
                    error = %restore_error,
                    "failed to roll back rejected {log_label} load slot"
                );
            }
            return Ok(ReplayLoadOutcome::CaptureRejected { error });
        }
    };
    // 回放收集与响应等待在锁外进行：load 响应是确定性边界。
    let load_result =
        crate::acp::load_session_with_replay(handles, peri_id, cwd, mcp_servers, mode).await;
    Ok(match load_result {
        Ok((response, batch)) => ReplayLoadOutcome::Loaded {
            response,
            replay: LoadedReplay {
                events: batch.events,
                metadata: batch.metadata,
            },
            previous,
        },
        Err(error) => ReplayLoadOutcome::LoadFailed { error, previous },
    })
}

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
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
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
            mut response,
            replay,
            previous,
        }) => {
            if let Err(error) = state.ensure_generation(&runtime, generation) {
                return Err(rollback_load_slot_else(
                    &runtime,
                    &source,
                    &peri_id,
                    generation,
                    previous,
                    error.into(),
                ));
            }
            let owner_key = owner.key()?;
            let journal_result: Result<(i64, &'static str), PylonError> = async {
                if replay.metadata.complete {
                    let ingest = crate::session::event_service_of(state.inner())?
                        .ingest_complete_replay(
                            owner.clone(),
                            Some(peri_id.clone()),
                            generation,
                            replay.events.clone(),
                        )
                        .await?;
                    Ok((ingest.revision, ingest.status))
                } else {
                    let events = crate::session::event_service_of(state.inner())?;
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
                        &runtime, &source, &peri_id, generation, previous, error,
                    ))
                }
            };
            let persisted_state_result: Result<Option<serde_json::Value>, PylonError> = async {
                crate::session::message_service_of(state.inner())?
                    .get_session_state(owner.clone())
                    .await
                    .map_err(Into::into)
            }
            .await;
            let persisted_state = match persisted_state_result {
                Ok(state) => state,
                Err(error) => {
                    return Err(rollback_load_slot_else(
                        &runtime, &source, &peri_id, generation, previous, error,
                    ))
                }
            };
            let apply_result =
                state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
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
                    restore_session_state(session, &mut response);
                });
            if let Err(error) = apply_result {
                return Err(rollback_load_slot_else(
                    &runtime,
                    &source,
                    &peri_id,
                    generation,
                    previous,
                    error.into(),
                ));
            }
            let attached = crate::session::store::mark_attached_if_current(
                &runtime, &source, &peri_id, generation, generation,
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
                state.inner(),
                &runtime,
                &source,
                &peri_id,
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
            let (turn_snapshot, turn_boundary) = match runtime.cold_mount_facts(&source).await {
                Some((snapshot, record)) => {
                    let boundary = match record {
                        Some(turn) => Some(ledger_turn_boundary(&turn)),
                        None => journal_turn_boundary(state.inner(), &owner_key).await,
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
        Ok(ReplayLoadOutcome::CaptureRejected { error }) => Err(error.into()),
        Ok(ReplayLoadOutcome::LoadFailed { error, previous }) => {
            // Failure paths still emit a bounded trace.  Collection counters are
            // explicitly zero because the collector does not claim a complete
            // batch when timeout/EOF/RPC error prevents observing the boundary.
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
            Err(rollback_load_slot_else(
                &runtime,
                &source,
                &peri_id,
                generation,
                previous,
                PylonError::from(error),
            ))
        }
        // 槽位插入失败（原 `?` 传播语义，收敛为 match 臂后逐位一致）。
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) async fn list_persisted_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let cwd = state.get_active_agent().ok().and_then(|a| a.cwd);
    let mut params = serde_json::json!({});
    if let Some(c) = cwd {
        params["cwd"] = serde_json::Value::String(c);
    }
    let response = state
        .inner()
        .acp_rpc(&runtime, acp::METHOD_SESSION_LIST, params)
        .await?;
    state.ensure_generation(&runtime, generation)?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::{replay_journal_commit_outcome, replay_load_error_code};

    #[test]
    fn replay_trace_journal_outcome_is_machine_readable() {
        assert_eq!(
            replay_journal_commit_outcome("imported"),
            "recovery-import-committed"
        );
        assert_eq!(
            replay_journal_commit_outcome("local-authoritative"),
            "local-journal-wins"
        );
        assert_eq!(
            // #425 件2：词表与 event_repo/service.rs 实际产出对齐——死词
            // `already-present`/`reconciled` 已摘，活词以 `already-imported` 断言。
            replay_journal_commit_outcome("already-imported"),
            "recovery-import-already-present"
        );
        assert_eq!(
            replay_journal_commit_outcome("incomplete-not-imported"),
            "incomplete-preserved-runtime"
        );
        assert_eq!(replay_journal_commit_outcome("empty"), "empty");
    }

    #[test]
    fn replay_trace_error_code_does_not_include_remote_error_text() {
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::Rpc(
                "{\"message\":\"secret\"}".to_string()
            )),
            "rpc_error"
        );
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::ConnectionClosed),
            "connection_closed"
        );
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::ReplayTimeout { seconds: 30 }),
            "replay_timeout"
        );
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::ReplayLagged { count: 7 }),
            "replay_lag"
        );
        assert_eq!(
            replay_load_error_code(&crate::acp::AcpError::ReplayStreamClosed),
            "replay_transport_error"
        );
    }

    /// #442 Step1：账本记录 → `turnBoundary` 的 wire 映射契约——有 terminal 即
    /// `terminal`（两端时间戳 = 记录 startedAtMs + settledAtMs），无即在途
    /// `open`（只给起点）。账本存在即权威，journal 行不参与该分支。
    #[test]
    fn ledger_turn_boundary_maps_record_to_wire_boundary() {
        use crate::acp::turn_ledger::{
            TurnKey, TurnPhase, TurnRecord, TurnTerminal, TurnTerminalCause,
        };

        fn record(terminal: Option<TurnTerminal>) -> TurnRecord {
            TurnRecord {
                key: TurnKey {
                    local_session_id: "local:s".to_string(),
                    remote_session_id: "remote-1".to_string(),
                    generation: 1,
                    turn_id: 7,
                }
                .snapshot(),
                phase: if terminal.is_some() {
                    TurnPhase::Terminal
                } else {
                    TurnPhase::Prompting
                },
                started_at_ms: 100,
                terminal,
                last_ingress_seq: 0,
                saw_text: false,
                saw_tool: false,
                saw_thinking: false,
            }
        }

        let open = super::ledger_turn_boundary(&record(None));
        assert_eq!(
            serde_json::to_value(&open).unwrap(),
            serde_json::json!({"kind": "open", "startedAtMs": 100})
        );

        let settled = super::ledger_turn_boundary(&record(Some(TurnTerminal {
            cause: TurnTerminalCause::Completed,
            settled_at_ms: 250,
            detail: None,
        })));
        assert_eq!(
            serde_json::to_value(&settled).unwrap(),
            serde_json::json!({"kind": "terminal", "startedAtMs": 100, "endedAtMs": 250})
        );
    }
}
