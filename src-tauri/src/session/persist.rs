//! 会话持久化域：恢复历史会话 / 会话清单。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use super::*;
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionLoadResult {
    response: serde_json::Value,
    replay: Vec<serde_json::Value>,
}

#[tauri::command]
pub(crate) async fn load_persisted_session(
    state: tauri::State<'_, AppState>,
    source: String,
    peri_id: String,
    cwd: Option<String>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _creation_guard = runtime.session_creation.lock().await;
    let generation = state.current_generation(&runtime);
    let cwd = cwd.unwrap_or_else(|| state.agent_cwd());
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
    loading_session.replay_loading = true;
    let previous = replace_session_slot(
        &runtime,
        &source,
        loading_session,
        true,
        crate::agent_runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    // O3：锁内仅提取回放句柄，等待在锁外进行——回放最长 30s，不阻塞其他命令。
    let handles = runtime.acp.lock().await.replay_handles();
    let load_result = crate::acp::load_session_with_replay(
        handles,
        &peri_id,
        &cwd,
        mcp_servers,
        state.protocol_for_runtime(&runtime).mcp_servers,
    )
    .await;
    match load_result {
        Ok((response, replay)) => {
            if let Err(error) = state.ensure_generation(&runtime, generation) {
                restore_previous_slot(&runtime, &source, &peri_id, generation, previous)?;
                return Err(error.into());
            }
            state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
                session.apply_session_response(&response);
                session.replay_loading = false;
            })?;
            serde_json::to_value(PersistedSessionLoadResult { response, replay })
                .map_err(|error| PylonError::from(error.to_string()))
        }
        Err(error) => {
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
