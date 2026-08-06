//! Inspector/会话清单域：load_sessions / session_inspector / 聚合 payload。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use super::*;

#[tauri::command]
pub(crate) async fn load_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
    // 方案 7：typed DTO + 稳定排序（source）——wire 字段/形状不变，HashMap
    // 遍历顺序不再影响数组顺序。
    let mut rows: Vec<SessionListRow> = sessions
        .iter()
        .map(|(source, info)| SessionListRow {
            source: source.clone(),
            peri_id: info.peri_id.clone(),
            persona: info.persona.clone(),
            cwd: info.cwd.clone(),
            title: info.title.clone(),
            mode: info.mode.clone(),
            config_options: info.config_options.clone(),
            model: info.model.clone(),
            tokens_in: info.tokens_in,
            tokens_out: info.tokens_out,
            tokens_total: info.tokens_total,
            context_size: info.context_size,
        })
        .collect();
    rows.sort_by(|a, b| a.source.cmp(&b.source));
    Ok(rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or(serde_json::Value::Null))
        .collect())
}

/// B2 Inspector 完整版：全量（所有 runtime）聚合 + per-agent runtimes 增量 +
/// workspace 增量。v1 顶层契约（agent/summary/sessions）保持形状，语义升级为全局：
/// - summary/sessions 合并所有 runtime（session 行新增 agentId 区分来源）
/// - runtimes[]：每个 agent 的运行时状态与聚合数
/// - workspace{}：source → {path, exists, readable}（复用 workspace::workspace_root）
pub(crate) fn build_full_inspector_payload(
    entries: &[(String, HashMap<String, SessionInfo>, AgentRuntimeState)],
    active_id: &str,
) -> serde_json::Value {
    let mut all_sessions: Vec<(String, String, &SessionInfo)> = Vec::new();
    let mut total_tokens: u64 = 0;
    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;
    let mut active_count: usize = 0;
    let mut workspace = serde_json::Map::new();
    // O29：cwd → workspace_root 结果缓存，同一 cwd 只计算一次（跨 runtime/source 去重）。
    let mut workspace_cache: HashMap<String, serde_json::Value> = HashMap::new();
    let mut runtimes: Vec<serde_json::Value> = Vec::new();

    for (agent_id, sessions, runtime_state) in entries {
        let mut session_count = 0usize;
        let mut runtime_tokens: u64 = 0;
        let mut runtime_active: usize = 0;
        for (source, session) in sessions {
            session_count += 1;
            runtime_tokens += session.tokens_total;
            total_tokens += session.tokens_total;
            total_in += session.tokens_in;
            total_out += session.tokens_out;
            if session.has_first_prompt {
                runtime_active += 1;
                active_count += 1;
            }
            all_sessions.push((agent_id.clone(), source.clone(), session));
            // O29：同一 cwd 只计算一次 workspace_root；按 source 逐项写入（值相同）。
            let value = workspace_cache
                .entry(session.cwd.clone())
                .or_insert_with(|| {
                    let root = workspace::workspace_root(
                        source.clone(),
                        std::path::Path::new(&session.cwd),
                    );
                    serde_json::to_value(root).unwrap_or(serde_json::Value::Null)
                })
                .clone();
            workspace.insert(source.clone(), value);
        }
        runtimes.push(serde_json::json!({
            "agentId": agent_id,
            "status": runtime_state.status.as_str(),
            "lastError": runtime_state.last_error,
            "lastConnectedAt": runtime_state.last_connected_at,
            "sessionCount": session_count,
            "activeCount": runtime_active,
            "tokensTotal": runtime_tokens,
        }));
    }

    // 方案 7：typed DTO + 稳定排序（agentId, source, periId）——wire 字段/形状
    // 不变（含 agentId 区分来源），HashMap 遍历顺序不再影响数组顺序。
    let mut session_rows: Vec<InspectorSessionRow> = all_sessions
        .iter()
        .map(|(agent_id, source, s)| InspectorSessionRow {
            agent_id: agent_id.clone(),
            source: source.clone(),
            peri_id: s.peri_id.clone(),
            title: s.title.clone(),
            model: s.model.clone(),
            mode: s.mode.clone(),
            tokens_in: s.tokens_in,
            tokens_out: s.tokens_out,
            tokens_total: s.tokens_total,
            context_size: s.context_size,
            cwd: s.cwd.clone(),
        })
        .collect();
    session_rows.sort_by(|a, b| {
        a.agent_id
            .cmp(&b.agent_id)
            .then(a.source.cmp(&b.source))
            .then(a.peri_id.cmp(&b.peri_id))
    });
    let session_rows: Vec<serde_json::Value> = session_rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or(serde_json::Value::Null))
        .collect();

    serde_json::json!({
        "agent": {
            "id": active_id,
            "status": entries.iter().find(|(id, _, _)| id == active_id)
                .map(|(_, _, rs)| rs.status.as_str())
                .unwrap_or("disconnected"),
            "lastError": entries.iter().find(|(id, _, _)| id == active_id)
                .and_then(|(_, _, rs)| rs.last_error.clone()),
            "lastConnectedAt": entries.iter().find(|(id, _, _)| id == active_id)
                .and_then(|(_, _, rs)| rs.last_connected_at),
        },
        "summary": {
            "sessionCount": all_sessions.len(),
            "activeCount": active_count,
            "tokensTotal": total_tokens,
            "tokensIn": total_in,
            "tokensOut": total_out,
        },
        "sessions": session_rows,
        "workspace": serde_json::Value::Object(workspace),
        "runtimes": runtimes,
    })
}

#[tauri::command]
pub(crate) async fn session_inspector(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    // B2 完整版：遍历所有 runtime（含无会话的），全局聚合 + workspace/runtimes 增量。
    let entries: Vec<(String, HashMap<String, SessionInfo>, AgentRuntimeState)> = state
        .inner()
        .runtimes
        .all_with_ids()
        .into_iter()
        .map(|(agent_id, runtime)| {
            let sessions = runtime
                .sessions
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default();
            let runtime_state = runtime
                .agent_runtime
                .lock()
                .map(|v| v.clone())
                .unwrap_or_default();
            (agent_id, sessions, runtime_state)
        })
        .collect();
    let active_id = state
        .active_agent
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    Ok(build_full_inspector_payload(&entries, &active_id))
}
