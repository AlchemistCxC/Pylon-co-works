//! 运行时日志命令（R1 拆分自 lib.rs；行为零变化）。

use crate::error::PylonError;
use crate::runtime_log;
use crate::AppState;

#[tauri::command]
pub(crate) async fn list_runtime_logs(
    state: tauri::State<'_, AppState>,
    query: Option<runtime_log::RuntimeLogQuery>,
) -> Result<Vec<runtime_log::RuntimeLogEntry>, PylonError> {
    Ok(state.runtime_logs.list(&query.unwrap_or_default()))
}

#[tauri::command]
pub(crate) async fn clear_runtime_logs(
    state: tauri::State<'_, AppState>,
) -> Result<(), PylonError> {
    state.runtime_logs.clear();
    Ok(())
}

#[tauri::command]
pub(crate) async fn push_frontend_log(
    state: tauri::State<'_, AppState>,
    level: String,
    source: Option<String>,
    session: Option<String>,
    message: String,
    fields: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<runtime_log::RuntimeLogEntry, PylonError> {
    Ok(state.runtime_logs.push(
        crate::time::Timestamp::now(),
        level,
        source.unwrap_or_else(|| "frontend".into()),
        session,
        message,
        fields.unwrap_or_default(),
    ))
}
