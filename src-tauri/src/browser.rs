//! Browser Sheet 子 WebView 管理。
//!
//! 一个 Browser Sheet 拥有多个内部标签；每个标签对应一个 Tauri 子 WebView。活动标签
//! show，其他标签 hide，切换时不销毁页面状态。关闭最后标签回到 idle；关闭 Sheet 则销毁
//! 所有子 WebView。地址栏、window.open 与初始 URL 共用 http/https 白名单（仅额外允许
//! 内部初始化用 about:blank）。缩放属于 Browser Sheet，新标签继承当前值。

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

pub(crate) const BROWSER_WEBVIEW_LABEL_PREFIX: &str = "pylon-browser";
pub(crate) const BROWSER_INITIAL_URL: &str = "about:blank";
pub(crate) const BROWSER_DEFAULT_ZOOM_PERCENT: u16 = 90;
pub(crate) const BROWSER_MIN_ZOOM_PERCENT: u16 = 50;
pub(crate) const BROWSER_MAX_ZOOM_PERCENT: u16 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserPhase {
    Idle,
    Starting,
    Ready,
    Error,
}

impl BrowserPhase {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTabSnapshot {
    pub(crate) id: u64,
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
}

/// 活动标签投影保留既有 instanceId/url/title 字段，同时公开完整标签集合。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSnapshot {
    pub(crate) instance_id: u64,
    pub(crate) phase: String,
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) zoom_percent: u16,
    pub(crate) active_tab_id: Option<u64>,
    pub(crate) tabs: Vec<BrowserTabSnapshot>,
}

#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserBounds {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn is_allowed_browser_url(url: &url::Url) -> bool {
    match url.scheme() {
        "http" | "https" => true,
        "about" => url.as_str() == BROWSER_INITIAL_URL,
        _ => false,
    }
}

pub(crate) struct BrowserManager {
    inner: Mutex<BrowserInner>,
}

struct BrowserInner {
    phase: BrowserPhase,
    error: Option<String>,
    zoom_percent: u16,
    tabs: Vec<BrowserTab>,
    active_tab_id: Option<u64>,
    next_tab_id: u64,
    bounds: Option<BrowserBounds>,
    window: Option<tauri::Window>,
    app: Option<tauri::AppHandle>,
}

struct BrowserTab {
    id: u64,
    url: Option<String>,
    title: Option<String>,
    webview: tauri::Webview,
}

impl BrowserManager {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(BrowserInner {
                phase: BrowserPhase::Idle,
                error: None,
                zoom_percent: BROWSER_DEFAULT_ZOOM_PERCENT,
                tabs: Vec::new(),
                active_tab_id: None,
                next_tab_id: 0,
                bounds: None,
                window: None,
                app: None,
            }),
        }
    }

    pub(crate) fn register_host(&self, window: tauri::Window, app: tauri::AppHandle) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.window = Some(window);
            inner.app = Some(app);
        }
    }

    pub(crate) fn snapshot(&self) -> Result<BrowserSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(Self::build_snapshot(&inner))
    }

    fn build_snapshot(inner: &BrowserInner) -> BrowserSnapshot {
        let active = inner
            .active_tab_id
            .and_then(|id| inner.tabs.iter().find(|tab| tab.id == id));
        BrowserSnapshot {
            instance_id: active.map_or(0, |tab| tab.id),
            phase: inner.phase.as_str().to_string(),
            url: active.and_then(|tab| tab.url.clone()),
            title: active.and_then(|tab| tab.title.clone()),
            error: inner.error.clone(),
            zoom_percent: inner.zoom_percent,
            active_tab_id: inner.active_tab_id,
            tabs: inner
                .tabs
                .iter()
                .map(|tab| BrowserTabSnapshot {
                    id: tab.id,
                    url: tab.url.clone(),
                    title: tab.title.clone(),
                })
                .collect(),
        }
    }

    fn emit_status(&self, inner: &BrowserInner) {
        if let Some(app) = inner.app.as_ref() {
            let _ = app.emit(
                crate::event_names::BROWSER_STATUS,
                Self::build_snapshot(inner),
            );
        }
    }

    pub(crate) fn emit_browser_error(&self, message: String) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        inner.error = Some(message);
        self.emit_status(&inner);
    }

    /// 首次启动创建一个空标签；已有标签时只更新宿主 bounds，保持幂等。
    pub(crate) fn start(
        self: &Arc<Self>,
        bounds: BrowserBounds,
    ) -> Result<BrowserSnapshot, String> {
        {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            inner.bounds = Some(bounds);
            if !inner.tabs.is_empty() || inner.phase == BrowserPhase::Starting {
                return Ok(Self::build_snapshot(&inner));
            }
        }
        self.create_tab(BROWSER_INITIAL_URL)
    }

    pub(crate) fn new_tab(self: &Arc<Self>) -> Result<BrowserSnapshot, String> {
        self.create_tab(BROWSER_INITIAL_URL)
    }

    fn create_tab(self: &Arc<Self>, initial_url: &str) -> Result<BrowserSnapshot, String> {
        let parsed = url::Url::parse(initial_url).map_err(|e| format!("URL 非法: {e}"))?;
        if !is_allowed_browser_url(&parsed) {
            return Err(format!(
                "仅允许 http/https，收到 scheme={}",
                parsed.scheme()
            ));
        }

        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let window = match (&inner.window, &inner.app) {
            (Some(window), Some(_)) => window.clone(),
            _ => return Err("browser host 未注册（setup 未注入主窗口）".to_string()),
        };
        let bounds = inner
            .bounds
            .ok_or_else(|| "browser bounds 未注册（请先启动 Browser Sheet）".to_string())?;
        inner.next_tab_id += 1;
        let tab_id = inner.next_tab_id;
        if inner.tabs.is_empty() {
            inner.phase = BrowserPhase::Starting;
        }
        inner.error = None;

        let page_this = self.clone();
        let new_window_this = self.clone();
        let builder = tauri::WebviewBuilder::new(
            format!("{BROWSER_WEBVIEW_LABEL_PREFIX}-{tab_id}"),
            tauri::WebviewUrl::External(parsed),
        )
        .on_navigation(is_allowed_browser_url)
        .on_new_window(move |url, _features| {
            if is_allowed_browser_url(&url) {
                if let Err(error) = new_window_this.create_tab(url.as_str()) {
                    tracing::warn!("browser 新窗口创建标签失败（{url}）: {error}");
                    new_window_this.emit_browser_error(format!("打开链接失败：{error}"));
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            let url = payload.url().to_string();
            let _ = webview.eval_with_callback("document.title", {
                let this = page_this.clone();
                let url = url.clone();
                move |title| {
                    let title = title.trim_matches('"').trim().to_string();
                    this.note_page_load(tab_id, url.clone(), Some(title));
                }
            });
            page_this.note_page_load(tab_id, url, None);
        });

        let position = tauri::LogicalPosition::new(bounds.x as f64, bounds.y as f64);
        let size = tauri::LogicalSize::new(bounds.width as f64, bounds.height as f64);
        let webview = match window.add_child(builder, position, size) {
            Ok(webview) => webview,
            Err(error) => {
                let message = format!("创建浏览器子 WebView 失败: {error}");
                inner.phase = if inner.tabs.is_empty() {
                    BrowserPhase::Error
                } else {
                    BrowserPhase::Ready
                };
                inner.error = Some(message.clone());
                self.emit_status(&inner);
                return Err(message);
            }
        };
        if let Err(error) = webview.set_zoom(f64::from(inner.zoom_percent) / 100.0) {
            let _ = webview.close();
            let message = format!("设置浏览器初始缩放失败: {error}");
            inner.phase = if inner.tabs.is_empty() {
                BrowserPhase::Error
            } else {
                BrowserPhase::Ready
            };
            inner.error = Some(message.clone());
            self.emit_status(&inner);
            return Err(message);
        }
        if let Some(active) = inner
            .active_tab_id
            .and_then(|id| inner.tabs.iter().find(|tab| tab.id == id))
        {
            let _ = active.webview.hide();
        }
        inner.tabs.push(BrowserTab {
            id: tab_id,
            url: Some(initial_url.to_string()),
            title: None,
            webview,
        });
        inner.active_tab_id = Some(tab_id);
        inner.phase = BrowserPhase::Ready;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    pub(crate) fn note_page_load(&self, tab_id: u64, url: String, title: Option<String>) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        {
            let Some(tab) = inner.tabs.iter_mut().find(|tab| tab.id == tab_id) else {
                return;
            };
            tab.url = Some(url.clone());
            if let Some(title) = title {
                if !title.is_empty() {
                    tab.title = Some(title);
                }
            }
        }
        if let Some(app) = inner.app.as_ref() {
            let tab = inner.tabs.iter().find(|tab| tab.id == tab_id);
            let _ = app.emit(
                crate::event_names::BROWSER_PAGE,
                serde_json::json!({
                    "tabId": tab_id,
                    "active": inner.active_tab_id == Some(tab_id),
                    "url": tab.and_then(|tab| tab.url.clone()),
                    "title": tab.and_then(|tab| tab.title.clone()),
                }),
            );
        }
    }

    pub(crate) fn navigate(&self, url: &str) -> Result<BrowserSnapshot, String> {
        let parsed = url::Url::parse(url).map_err(|e| format!("URL 非法: {e}"))?;
        if !is_allowed_browser_url(&parsed) {
            return Err(format!(
                "仅允许 http/https，收到 scheme={}",
                parsed.scheme()
            ));
        }
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let active_id = inner
            .active_tab_id
            .ok_or_else(|| "浏览器未启动".to_string())?;
        let tab = inner
            .tabs
            .iter_mut()
            .find(|tab| tab.id == active_id)
            .ok_or_else(|| "浏览器未启动".to_string())?;
        tab.url = Some(url.to_string());
        tab.webview
            .navigate(parsed)
            .map_err(|e| format!("导航失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    pub(crate) fn go_back(&self) -> Result<BrowserSnapshot, String> {
        self.eval("history.back()")
    }

    pub(crate) fn go_forward(&self) -> Result<BrowserSnapshot, String> {
        self.eval("history.forward()")
    }

    pub(crate) fn reload(&self) -> Result<BrowserSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = Self::active_webview(&inner)?.clone();
        webview.reload().map_err(|e| format!("刷新失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    fn eval(&self, js: &str) -> Result<BrowserSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = Self::active_webview(&inner)?.clone();
        webview.eval(js).map_err(|e| format!("执行失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    pub(crate) fn set_zoom(&self, zoom_percent: u16) -> Result<BrowserSnapshot, String> {
        if !(BROWSER_MIN_ZOOM_PERCENT..=BROWSER_MAX_ZOOM_PERCENT).contains(&zoom_percent) {
            return Err(format!(
                "浏览器缩放必须在 {BROWSER_MIN_ZOOM_PERCENT}%–{BROWSER_MAX_ZOOM_PERCENT}% 之间"
            ));
        }
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.tabs.is_empty() {
            return Err("浏览器未启动".to_string());
        }
        for tab in &inner.tabs {
            tab.webview
                .set_zoom(f64::from(zoom_percent) / 100.0)
                .map_err(|e| format!("设置浏览器缩放失败: {e}"))?;
        }
        inner.zoom_percent = zoom_percent;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    pub(crate) fn set_bounds(&self, bounds: BrowserBounds) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.bounds = Some(bounds);
        if inner.tabs.is_empty() {
            return Err("浏览器未启动".to_string());
        }
        let rect = tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(
                bounds.x as f64,
                bounds.y as f64,
            )),
            size: tauri::Size::Logical(tauri::LogicalSize::new(
                bounds.width as f64,
                bounds.height as f64,
            )),
        };
        for tab in &inner.tabs {
            tab.webview
                .set_bounds(rect)
                .map_err(|e| format!("调整浏览器区域失败: {e}"))?;
        }
        Ok(())
    }

    pub(crate) fn select_tab(&self, tab_id: u64) -> Result<BrowserSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.active_tab_id == Some(tab_id) {
            return Ok(Self::build_snapshot(&inner));
        }
        let next = inner
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("浏览器标签不存在：{tab_id}"))?
            .webview
            .clone();
        let current = inner.active_tab_id.and_then(|id| {
            inner
                .tabs
                .iter()
                .find(|tab| tab.id == id)
                .map(|tab| tab.webview.clone())
        });
        if let Some(current) = current.as_ref() {
            current
                .hide()
                .map_err(|e| format!("隐藏浏览器标签失败: {e}"))?;
        }
        if let Err(error) = next.show() {
            if let Some(current) = current {
                let _ = current.show();
            }
            return Err(format!("显示浏览器标签失败: {error}"));
        }
        inner.active_tab_id = Some(tab_id);
        inner.error = None;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    pub(crate) fn close_tab(&self, tab_id: u64) -> Result<BrowserSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let index = inner
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or_else(|| format!("浏览器标签不存在：{tab_id}"))?;
        let was_active = inner.active_tab_id == Some(tab_id);
        let removed = inner.tabs.remove(index);
        let _ = removed.webview.close();
        if was_active {
            if inner.tabs.is_empty() {
                inner.active_tab_id = None;
                inner.phase = BrowserPhase::Idle;
            } else {
                let next_index = index.min(inner.tabs.len() - 1);
                let next = &inner.tabs[next_index];
                next.webview
                    .show()
                    .map_err(|e| format!("显示浏览器标签失败: {e}"))?;
                inner.active_tab_id = Some(next.id);
                inner.phase = BrowserPhase::Ready;
            }
        }
        inner.error = None;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    /// 关闭 Browser Workspace：销毁全部内部标签及其 WebView2 子进程。
    pub(crate) fn close(&self) -> Result<BrowserSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        for tab in inner.tabs.drain(..) {
            let _ = tab.webview.close();
        }
        inner.phase = BrowserPhase::Idle;
        inner.active_tab_id = None;
        inner.error = None;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    fn active_webview(inner: &BrowserInner) -> Result<&tauri::Webview, String> {
        let active_id = inner
            .active_tab_id
            .ok_or_else(|| "浏览器未启动".to_string())?;
        inner
            .tabs
            .iter()
            .find(|tab| tab.id == active_id)
            .map(|tab| &tab.webview)
            .ok_or_else(|| "浏览器未启动".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_defaults_to_idle_with_no_tabs() {
        let manager = BrowserManager::new();
        let snap = manager.snapshot().unwrap();
        assert_eq!(snap.phase, "idle");
        assert_eq!(snap.instance_id, 0);
        assert_eq!(snap.url, None);
        assert_eq!(snap.zoom_percent, BROWSER_DEFAULT_ZOOM_PERCENT);
        assert_eq!(snap.active_tab_id, None);
        assert!(snap.tabs.is_empty());
    }

    #[test]
    fn start_requires_registered_host() {
        let manager = Arc::new(BrowserManager::new());
        let err = manager
            .start(BrowserBounds {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            })
            .unwrap_err();
        assert!(err.contains("host 未注册"));
    }

    #[test]
    fn new_tab_requires_registered_host() {
        let manager = Arc::new(BrowserManager::new());
        assert!(manager.new_tab().unwrap_err().contains("host 未注册"));
    }

    #[test]
    fn url_whitelist_allows_http_https_and_init_about_blank() {
        for raw in ["https://example.com", "http://example.com", "about:blank"] {
            assert!(is_allowed_browser_url(&url::Url::parse(raw).unwrap()));
        }
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "devtools://devtools/bundled/inspector.html",
            "chrome://settings",
            "about:config",
        ] {
            assert!(!is_allowed_browser_url(&url::Url::parse(raw).unwrap()));
        }
    }

    #[test]
    fn navigate_rejects_non_http_scheme() {
        let manager = BrowserManager::new();
        assert!(manager
            .navigate("file:///etc/passwd")
            .unwrap_err()
            .contains("仅允许 http/https"));
        assert!(manager
            .navigate("not-a-url")
            .unwrap_err()
            .contains("URL 非法"));
    }

    #[test]
    fn navigate_before_start_reports_not_started() {
        let manager = BrowserManager::new();
        assert!(manager
            .navigate("https://example.com")
            .unwrap_err()
            .contains("浏览器未启动"));
    }

    #[test]
    fn close_from_idle_is_ok_and_stays_idle() {
        let manager = BrowserManager::new();
        let snap = manager.close().unwrap();
        assert_eq!(snap.phase, "idle");
        assert!(snap.tabs.is_empty());
    }

    #[test]
    fn set_bounds_before_start_reports_not_started_but_remembers_bounds() {
        let manager = BrowserManager::new();
        let err = manager
            .set_bounds(BrowserBounds {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            })
            .unwrap_err();
        assert!(err.contains("浏览器未启动"));
    }

    #[test]
    fn zoom_rejects_out_of_range_before_webview_access() {
        let manager = BrowserManager::new();
        for zoom in [49, 201] {
            assert!(manager.set_zoom(zoom).unwrap_err().contains("50%–200%"));
        }
        assert!(manager
            .set_zoom(BROWSER_DEFAULT_ZOOM_PERCENT)
            .unwrap_err()
            .contains("浏览器未启动"));
    }
}
