//! 浏览器命令（Phase 4，WebView 方案 §6.0）：只做参数校验 + manager 调用 + 错误映射。

use crate::browser::{BrowserBounds, BrowserSnapshot};
use crate::error::PylonError;
use crate::AppState;

#[tauri::command]
pub(crate) async fn browser_start(
    state: tauri::State<'_, AppState>,
    bounds: BrowserBounds,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .start(bounds)
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_new_tab(
    state: tauri::State<'_, AppState>,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .new_tab()
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_select_tab(
    state: tauri::State<'_, AppState>,
    tab_id: u64,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .select_tab(tab_id)
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_close_tab(
    state: tauri::State<'_, AppState>,
    tab_id: u64,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .close_tab(tab_id)
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_status(
    state: tauri::State<'_, AppState>,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .snapshot()
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_navigate(
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .navigate(&url)
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_back(
    state: tauri::State<'_, AppState>,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .go_back()
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_forward(
    state: tauri::State<'_, AppState>,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .go_forward()
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_reload(
    state: tauri::State<'_, AppState>,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .reload()
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_set_zoom(
    state: tauri::State<'_, AppState>,
    zoom_percent: u16,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .set_zoom(zoom_percent)
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_set_bounds(
    state: tauri::State<'_, AppState>,
    bounds: BrowserBounds,
) -> Result<(), PylonError> {
    state
        .browser
        .set_bounds(bounds)
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

/// 关 sheet=关进程：销毁子 WebView（WebView2 子进程树随之退出）。
#[tauri::command]
pub(crate) async fn browser_close(
    state: tauri::State<'_, AppState>,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .close()
        .map_err(|e| PylonError::Protocol(e.to_string()))
}
