//! Agent 浏览器能力（issue #82）：策略、claim、ref 注册表、设置与审计。
//!
//! 模块边界：本目录只承载 Agent 驱动浏览器所需的决策与状态；页面操作最终仍
//! 落到 [`crate::browser::BrowserManager`] 的子 WebView 上。策略在本目录单点
//! 强制（`policy.rs`），MCP 桥与 pylon_cli 工具字典两条通道都绕不开。

pub(crate) mod audit;
pub(crate) mod cdp;
pub(crate) mod claim;
pub(crate) mod driver;
pub(crate) mod hub;
pub(crate) mod policy;
pub(crate) mod refs;
pub(crate) mod settings;

/// 页面加载钩子：BrowserManager 导航完成时以 tab_id 回调（ref 失效等）。
pub(crate) type PageLoadHook = std::sync::Arc<dyn Fn(u64) + Send + Sync>;
