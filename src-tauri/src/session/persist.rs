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
        "already-imported" | "already-present" | "reconciled" => {
            "recovery-import-already-present"
        }
        "local-authoritative" => "local-journal-wins",
        "incomplete-not-imported" => "incomplete-preserved-runtime",
        "empty" => "empty",
        _ => "journal-observed",
    }
}

fn replay_load_error_code(error: &crate::acp::AcpError) -> &'static str {
    match error {
        crate::acp::AcpError::ConnectionClosed => "connection_closed",
        crate::acp::AcpError::WriteTimeout => "write_timeout",
        crate::acp::AcpError::RpcTimeout => "rpc_timeout",
        crate::acp::AcpError::ReplayLoadInProgress => "replay_load_in_progress",
        crate::acp::AcpError::Rpc(_) => "rpc_error",
        crate::acp::AcpError::Connect(_) => "connect_error",
        crate::acp::AcpError::Child(_) => "transport_error",
    }
}

#[tauri::command]
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
    let previous = replace_session_slot(
        &runtime,
        &source,
        loading_session,
        true,
        crate::agent_runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    // A-02：锁内原子建立 replay capture，等待在锁外进行——回放最长 30s，不阻塞其他命令。
    let handles = runtime.acp.lock().await.begin_replay_capture(&peri_id)?;
    let load_result = crate::acp::load_session_with_replay(
        handles,
        &peri_id,
        &cwd,
        mcp_servers,
        state.protocol_for_runtime(&runtime).mcp_servers,
    )
    .await;
    match load_result {
        Ok((mut response, replay)) => {
            if let Err(error) = state.ensure_generation(&runtime, generation) {
                restore_previous_slot(&runtime, &source, &peri_id, generation, previous)?;
                return Err(error.into());
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
                    let status = if events.has_authoritative_local_events(owner_key.clone()).await? {
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
                    restore_previous_slot(&runtime, &source, &peri_id, generation, previous)?;
                    return Err(error);
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
                    restore_previous_slot(&runtime, &source, &peri_id, generation, previous)?;
                    return Err(error);
                }
            };
            let apply_result =
                state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
                    session.apply_session_response(&response);
                    if let Some(persisted) = &persisted_state {
                        if let Some(object) = persisted.as_object() {
                            for (key, value) in object {
                                session.snapshots.insert(key.clone(), value.clone());
                            }
                        }
                    }
                    session.replay_loading = false;
                    restore_session_state(session, &mut response);
                });
            if let Err(error) = apply_result {
                restore_previous_slot(&runtime, &source, &peri_id, generation, previous)?;
                return Err(error.into());
            }
            let attached = crate::session_store::mark_attached_if_current(
                &runtime, &source, &peri_id, generation, generation,
            )
            .map_err(|error| PylonError::Protocol(error.to_string()))?;
            if !attached {
                return Err(PylonError::Protocol(format!(
                    "stale session mapping for source: {source}"
                )));
            }
            let authority = match replay_journal_status {
                "local-authoritative" => "local-journal",
                "imported" | "already-imported" | "already-present" | "reconciled" => "recovery-import",
                _ if canonical_revision > 0 => "recovery-import",
                _ => "empty",
            };
            let journal_coverage = match replay_journal_status {
                "local-authoritative" => "local-observed",
                "imported" | "already-imported" | "already-present" | "reconciled" => "unverified-import",
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
                "already-imported" | "already-present" => Some(ReplayImport {
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
            })
            .map_err(|error| PylonError::from(error.to_string()))
        }
        Err(error) => {
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
            restore_previous_slot(&runtime, &source, &peri_id, generation, previous)?;
            Err(PylonError::from(error))
        }
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
            replay_journal_commit_outcome("reconciled"),
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
    }
}
