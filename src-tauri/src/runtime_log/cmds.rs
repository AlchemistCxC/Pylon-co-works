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

/// B2：RuntimeSheet 挂载时开 live 推送、卸载时关。ringbuffer 记录不受影响，
/// list_runtime_logs pull 兜底始终可用。
#[tauri::command]
pub(crate) async fn set_runtime_log_live(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), PylonError> {
    state.runtime_logs.set_live(enabled);
    Ok(())
}

#[tauri::command]
pub(crate) async fn push_frontend_log(
    state: tauri::State<'_, AppState>,
    level: String,
    _source: Option<String>,
    session: Option<String>,
    message: String,
    fields: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<runtime_log::RuntimeLogEntry, PylonError> {
    // R8（P2-3）：前端日志收紧——source 固定为 "frontend"（忽略前端传入，防伪造
    // source 污染过滤），message/fields 限长，每秒限流（超限丢弃并返回错误）。
    let now = crate::time::Timestamp::now().as_u64();
    {
        let mut throttle = state
            .frontend_log_throttle
            .lock()
            .map_err(|error| error.to_string())?;
        if !runtime_log::frontend_log_allowed(&mut throttle, now) {
            return Err(PylonError::Protocol(format!(
                "frontend log rate limited（每秒 {} 条上限，本条日志已丢弃）",
                runtime_log::FRONTEND_LOG_RATE_LIMIT
            )));
        }
    }
    Ok(state.runtime_logs.push_with_context(
        crate::time::Timestamp::now(),
        level,
        "frontend",
        session,
        runtime_log::truncate_frontend_message(&message),
        runtime_log::truncate_frontend_fields(fields.unwrap_or_default()),
        None,
        runtime_log::RuntimeLogContext {
            category: Some(runtime_log::LOG_CATEGORY_FRONTEND.to_string()),
            raw_available: Some(true),
            ..Default::default()
        },
    ))
}
