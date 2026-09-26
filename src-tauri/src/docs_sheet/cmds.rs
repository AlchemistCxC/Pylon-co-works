//! 文档 Sheet 命令（#371）：只做参数透传 + manager 调用 + 错误映射，与浏览器命令层同型。

use crate::browser::BrowserBounds;
use crate::docs_sheet::DocsSheetSnapshot;
use crate::error::PylonError;
use crate::AppState;

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn docs_sheet_status(
    state: tauri::State<'_, AppState>,
) -> Result<DocsSheetSnapshot, PylonError> {
    state
        .docs_sheet
        .snapshot()
        .map_err(PylonError::Protocol)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn docs_sheet_start(
    state: tauri::State<'_, AppState>,
    bounds: BrowserBounds,
) -> Result<DocsSheetSnapshot, PylonError> {
    state
        .docs_sheet
        .start(bounds)
        .map_err(PylonError::Protocol)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn docs_sheet_set_bounds(
    state: tauri::State<'_, AppState>,
    bounds: BrowserBounds,
) -> Result<(), PylonError> {
    state
        .docs_sheet
        .set_bounds(bounds)
        .map_err(PylonError::Protocol)
}

/// 同步 Docs Sheet keep-alive 的原生 WebView 可见性。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn docs_sheet_set_visible(
    state: tauri::State<'_, AppState>,
    visible: bool,
) -> Result<DocsSheetSnapshot, PylonError> {
    state
        .docs_sheet
        .set_visible(visible)
        .map_err(PylonError::Protocol)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn docs_sheet_back(
    state: tauri::State<'_, AppState>,
) -> Result<DocsSheetSnapshot, PylonError> {
    state
        .docs_sheet
        .go_back()
        .map_err(PylonError::Protocol)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn docs_sheet_forward(
    state: tauri::State<'_, AppState>,
) -> Result<DocsSheetSnapshot, PylonError> {
    state
        .docs_sheet
        .go_forward()
        .map_err(PylonError::Protocol)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn docs_sheet_reload(
    state: tauri::State<'_, AppState>,
) -> Result<DocsSheetSnapshot, PylonError> {
    state
        .docs_sheet
        .reload()
        .map_err(PylonError::Protocol)
}

/// 回文档站首页（VitePress 内部路由不触发 webview 导航，历史语义覆盖不了「回家」）。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn docs_sheet_home(
    state: tauri::State<'_, AppState>,
) -> Result<DocsSheetSnapshot, PylonError> {
    state
        .docs_sheet
        .go_home()
        .map_err(PylonError::Protocol)
}

/// 关 sheet=销毁子 WebView（WebView2 子进程随之回收）。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn docs_sheet_close(
    state: tauri::State<'_, AppState>,
) -> Result<DocsSheetSnapshot, PylonError> {
    state
        .docs_sheet
        .close()
        .map_err(PylonError::Protocol)
}
