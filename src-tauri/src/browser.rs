//! 浏览器会话管理（Phase 4，WebView 方案 §6.0，用户拍板：子 WebView 内嵌 + 关 sheet=关进程）。
//!
//! Tauri 子 WebView（Windows WebView2=Chromium）嵌在 BrowserSheet 面板位置；
//! 关闭 sheet → `browser_close` → `Webview::close()` 销毁子 WebView，渲染进程树随之回收。
//! 命令只做参数校验 + manager 调用；状态机 idle→starting→ready→error，close 回 idle。
//! 单实例：重复 start 幂等返回同一 instanceId；generation 丢弃旧实例迟到回调。
//! 安全：navigate 只放行 http/https（on_navigation 二次拦截非 http(s)/about 跳转）。

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

pub(crate) const BROWSER_WEBVIEW_LABEL: &str = "pylon-browser";
pub(crate) const BROWSER_INITIAL_URL: &str = "about:blank";

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

/// 浏览器快照（wire camelCase：instanceId/phase/url/title/error）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSnapshot {
    pub(crate) instance_id: u64,
    pub(crate) phase: String,
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) error: Option<String>,
}

/// 面板 bounds（前端上报 BrowserSheet 面板相对窗口的 rect）。
#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserBounds {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) struct BrowserManager {
    inner: Mutex<BrowserInner>,
}

struct BrowserInner {
    phase: BrowserPhase,
    instance_id: u64,
    url: Option<String>,
    title: Option<String>,
    error: Option<String>,
    webview: Option<tauri::Webview>,
    window: Option<tauri::Window>,
    app: Option<tauri::AppHandle>,
    generation: u64,
}

impl BrowserManager {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(BrowserInner {
                phase: BrowserPhase::Idle,
                instance_id: 0,
                url: None,
                title: None,
                error: None,
                webview: None,
                window: None,
                app: None,
                generation: 0,
            }),
        }
    }

    /// setup() 注入主窗口 + AppHandle（add_child / emit 需要）。
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
        BrowserSnapshot {
            instance_id: inner.instance_id,
            phase: inner.phase.as_str().to_string(),
            url: inner.url.clone(),
            title: inner.title.clone(),
            error: inner.error.clone(),
        }
    }

    fn emit_status(&self, inner: &BrowserInner) {
        if let Some(app) = inner.app.as_ref() {
            let _ = app.emit(crate::event_names::BROWSER_STATUS, Self::build_snapshot(inner));
        }
    }

    /// browser_start：在面板 bounds 处创建子 WebView；幂等（已启动返回当前实例）。
    pub(crate) fn start(self: &Arc<Self>, bounds: BrowserBounds) -> Result<BrowserSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.phase == BrowserPhase::Ready || inner.phase == BrowserPhase::Starting {
            return Ok(Self::build_snapshot(&inner));
        }
        let window = match (&inner.window, &inner.app) {
            (Some(window), Some(_)) => window.clone(),
            _ => return Err("browser host 未注册（setup 未注入主窗口）".to_string()),
        };
        inner.generation += 1;
        let generation = inner.generation;
        inner.instance_id = generation;
        inner.phase = BrowserPhase::Starting;
        inner.error = None;
        let this = self.clone();
        let builder = tauri::WebviewBuilder::new(
            BROWSER_WEBVIEW_LABEL,
            tauri::WebviewUrl::External(
                url::Url::parse(BROWSER_INITIAL_URL).expect("about:blank 恒可解析"),
            ),
        )
            // 二次拦截：非 http(s)/about 跳转（file://、devtools:// 等拒绝）
            .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
            .on_page_load(move |webview, payload| {
                let url = payload.url().to_string();
                // 尝试取标题（eval_with_callback 在受限环境可能失败，静默降级）
                let _ = webview.eval_with_callback("document.title", {
                    let this = this.clone();
                    let url = url.clone();
                    move |title| {
                        let title = title.trim_matches('"').trim().to_string();
                        this.note_page_load(generation, url.clone(), Some(title));
                    }
                });
                this.note_page_load(generation, url.clone(), None);
            });
        let position = tauri::LogicalPosition::new(bounds.x as f64, bounds.y as f64);
        let size = tauri::LogicalSize::new(bounds.width as f64, bounds.height as f64);
        let webview = match window.add_child(builder, position, size) {
            Ok(webview) => webview,
            Err(error) => {
                let message = format!("创建浏览器子 WebView 失败: {error}");
                inner.phase = BrowserPhase::Error;
                inner.error = Some(message.clone());
                self.emit_status(&inner);
                return Err(message);
            }
        };
        inner.webview = Some(webview);
        inner.phase = BrowserPhase::Ready;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }

    /// on_page_load 回调：更新 url/title + emit pylon:browser-page（generation 丢弃旧实例迟到）。
    pub(crate) fn note_page_load(&self, generation: u64, url: String, title: Option<String>) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        if generation != inner.generation {
            return;
        }
        inner.url = Some(url.clone());
        if let Some(title) = title {
            if !title.is_empty() {
                inner.title = Some(title);
            }
        }
        let snapshot = Self::build_snapshot(&inner);
        if let Some(app) = inner.app.as_ref() {
            let _ = app.emit(
                crate::event_names::BROWSER_PAGE,
                serde_json::json!({
                    "instanceId": snapshot.instance_id,
                    "url": snapshot.url,
                    "title": snapshot.title,
                }),
            );
        }
    }

    /// browser_navigate：http/https 白名单 + 导航。
    pub(crate) fn navigate(&self, url: &str) -> Result<BrowserSnapshot, String> {
        let parsed = url::Url::parse(url).map_err(|e| format!("URL 非法: {e}"))?;
        match parsed.scheme() {
            "http" | "https" => {}
            other => return Err(format!("仅允许 http/https，收到 scheme={other}")),
        }
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = inner
            .webview
            .as_ref()
            .ok_or_else(|| "浏览器未启动".to_string())?
            .clone();
        inner.url = Some(url.to_string());
        webview.navigate(parsed).map_err(|e| format!("导航失败: {e}"))?;
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
        let webview = inner
            .webview
            .as_ref()
            .ok_or_else(|| "浏览器未启动".to_string())?
            .clone();
        webview.reload().map_err(|e| format!("刷新失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    fn eval(&self, js: &str) -> Result<BrowserSnapshot, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = inner
            .webview
            .as_ref()
            .ok_or_else(|| "浏览器未启动".to_string())?
            .clone();
        webview.eval(js).map_err(|e| format!("执行失败: {e}"))?;
        Ok(Self::build_snapshot(&inner))
    }

    /// 面板移动/窗口缩放时前端上报 bounds，重新定位子 WebView。
    pub(crate) fn set_bounds(&self, bounds: BrowserBounds) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let webview = inner
            .webview
            .as_ref()
            .ok_or_else(|| "浏览器未启动".to_string())?
            .clone();
        let rect = tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(bounds.x as f64, bounds.y as f64)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(bounds.width as f64, bounds.height as f64)),
        };
        webview.set_bounds(rect).map_err(|e| format!("调整浏览器区域失败: {e}"))
    }

    /// 关 sheet=关进程：销毁子 WebView（WebView2 子进程树随之退出），回 idle。
    pub(crate) fn close(&self) -> Result<BrowserSnapshot, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if let Some(webview) = inner.webview.take() {
            let _ = webview.close();
        }
        inner.phase = BrowserPhase::Idle;
        inner.url = None;
        inner.title = None;
        inner.error = None;
        inner.instance_id = 0;
        let snapshot = Self::build_snapshot(&inner);
        self.emit_status(&inner);
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_defaults_to_idle() {
        let manager = BrowserManager::new();
        let snap = manager.snapshot().unwrap();
        assert_eq!(snap.phase, "idle");
        assert_eq!(snap.instance_id, 0);
        assert_eq!(snap.url, None);
    }

    #[test]
    fn start_requires_registered_host() {
        let manager = Arc::new(BrowserManager::new());
        let err = manager.start(BrowserBounds { x: 0, y: 0, width: 100, height: 100 }).unwrap_err();
        assert!(err.contains("host 未注册"), "未注入主窗口必须报错（真实创建需真机）");
    }

    #[test]
    fn navigate_rejects_non_http_scheme() {
        let manager = BrowserManager::new();
        let err = manager.navigate("file:///etc/passwd").unwrap_err();
        assert!(err.contains("仅允许 http/https"), "file:// 必须拒绝（{err}）");
        let err = manager.navigate("chrome://settings").unwrap_err();
        assert!(err.contains("仅允许 http/https"), "chrome:// 必须拒绝");
        let err = manager.navigate("not-a-url").unwrap_err();
        assert!(err.contains("URL 非法"), "非法 URL 必须报错");
    }

    #[test]
    fn navigate_before_start_reports_not_started() {
        let manager = BrowserManager::new();
        let err = manager.navigate("https://example.com").unwrap_err();
        assert!(err.contains("浏览器未启动"));
    }

    #[test]
    fn close_from_idle_is_ok_and_stays_idle() {
        let manager = BrowserManager::new();
        let snap = manager.close().unwrap();
        assert_eq!(snap.phase, "idle");
        assert_eq!(snap.instance_id, 0);
    }

    #[test]
    fn note_page_load_ignores_stale_generation() {
        let manager = BrowserManager::new();
        // generation=0 初始：note(0) 更新；note(1)（未来实例）应被忽略——先走一次 close 使
        // generation 语义生效需真实 start；此处锁定"generation 不匹配即忽略"的纯逻辑路径：
        manager.note_page_load(0, "https://a.example".to_string(), None);
        let snap = manager.snapshot().unwrap();
        assert_eq!(snap.url.as_deref(), Some("https://a.example"), "同代必须更新");
        // 模拟旧代（generation 0 已被消费，管理器当前代仍为 0 → 同代更新；构造不同代需
        // 真实 start，故以 close 后 note 旧代验证忽略语义）
        manager.note_page_load(1, "https://stale.example".to_string(), None);
        assert_eq!(manager.snapshot().unwrap().url.as_deref(), Some("https://a.example"), "不同代必须忽略");
    }

    #[test]
    fn set_bounds_before_start_reports_not_started() {
        let manager = BrowserManager::new();
        let err = manager.set_bounds(BrowserBounds { x: 0, y: 0, width: 10, height: 10 }).unwrap_err();
        assert!(err.contains("浏览器未启动"));
    }
}
