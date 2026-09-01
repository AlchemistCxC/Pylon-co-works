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

/// 创建并激活指定 URL 的内部标签。与点击 target=_blank 的路径共用同一 manager，
/// 供 Agent 控制面在不模拟鼠标的情况下打开页面。
#[tauri::command]
pub(crate) async fn browser_open_tab(
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .open_tab(&url)
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

/// 读取活动页面的有限文本/链接快照（不包含 cookie、存储或请求头）。
#[tauri::command]
pub(crate) async fn browser_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    state
        .browser
        .page_snapshot()
        .await
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

/// Start an explicit download from the active Browser WebView.  The manager repeats
/// URL/filename validation at the native boundary.
#[tauri::command]
pub(crate) async fn browser_download(
    state: tauri::State<'_, AppState>,
    url: String,
    filename: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    state
        .browser
        .download(&url, filename)
        .await
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_click(
    state: tauri::State<'_, AppState>,
    selector: Option<String>,
    text: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    if selector.as_deref().unwrap_or_default().trim().is_empty()
        && text.as_deref().unwrap_or_default().trim().is_empty()
    {
        return Err(PylonError::Protocol("selector 或 text 至少提供一个".to_string()));
    }
    state
        .browser
        .click(selector, text)
        .await
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_type(
    state: tauri::State<'_, AppState>,
    text: String,
    selector: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    if text.is_empty() {
        return Err(PylonError::Protocol("text 不能为空".to_string()));
    }
    state
        .browser
        .type_text(text, selector)
        .await
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_press(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<serde_json::Value, PylonError> {
    if key.trim().is_empty() {
        return Err(PylonError::Protocol("key 不能为空".to_string()));
    }
    state
        .browser
        .press(key)
        .await
        .map_err(|e| PylonError::Protocol(e.to_string()))
}

#[tauri::command]
pub(crate) async fn browser_scroll(
    state: tauri::State<'_, AppState>,
    delta_x: Option<i32>,
    delta_y: Option<i32>,
) -> Result<serde_json::Value, PylonError> {
    state
        .browser
        .scroll(delta_x.unwrap_or(0), delta_y.unwrap_or(600))
        .await
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

/// 同步 Browser Sheet keep-alive 的原生 WebView 可见性。
#[tauri::command]
pub(crate) async fn browser_set_visible(
    state: tauri::State<'_, AppState>,
    visible: bool,
) -> Result<BrowserSnapshot, PylonError> {
    state
        .browser
        .set_visible(visible)
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
