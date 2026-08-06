//! 事件名常量表：Tauri WebView 事件与 gateway 平台投递的唯一事件名来源。
//! wire 契约权威：docs/后端给前端的所有可暴露接口.md §4。
//! 2026-08-03 战役决策：统一 `pylon:` 前缀（peri:* → pylon:*，直接改名，无双发过渡）。
//! 命名规则：`pylon:主题`，主题 kebab-case，与既有 pylon:permission-request / pylon:runtime-log 一致。
//! 前端注意：`pylon:agent-switched`/`pylon:model-error` 等是前端自行 dispatch 的
//! window CustomEvent（src/App.tsx:64 等），与后端 Tauri 事件是不同通道，无冲突。
//! 新增事件必须在本表登记（纪律：不得绕过常量表硬编码，E11）。

/// Agent 生命周期状态（AgentStatusPayload，§4.5）。
pub(crate) const AGENT_STATUS: &str = "pylon:agent-status";
/// session/update 全量透传（§4.1；载荷注入 source；agent_message_chunk 提取平台文本）。
pub(crate) const SESSION_UPDATE: &str = "pylon:update";
/// 回合完成（§4.2，{source, data:{stopReason}}）。
pub(crate) const SESSION_DONE: &str = "pylon:done";
/// 回合失败（§4.3，{source, error}）。
pub(crate) const SESSION_ERROR: &str = "pylon:error";
/// 用户消息回显（§4.4，{source, content, replay?, injectActivated?}；不投平台）。
pub(crate) const USER_ECHO: &str = "pylon:user";
/// 工具权限请求（§4.6，B9；edit/default 模式挂起时推送）。
pub(crate) const PERMISSION_REQUEST: &str = "pylon:permission-request";
/// 运行日志实时推送（§4.7，RuntimeLogEntry 已脱敏）。
pub(crate) const RUNTIME_LOG: &str = "pylon:runtime-log";
/// 进程内广播伪通知：ACP stdout EOF（非 WebView 事件，dispatcher 主循环消费）。
/// acp.rs 以 `pub use` 别名暴露为 NOTIF_AGENT_CRASHED（保持既有引用不变）——
/// 重导出要求本常量 pub（crate 为 cdylib，无外部 Rust API 面，pub 无泄漏）。
pub const AGENT_CRASHED: &str = "pylon:agent-crashed";
/// 浏览器 phase 迁移（Phase 4 WebView 方案，§6.0）。
pub(crate) const BROWSER_STATUS: &str = "pylon:browser-status";
/// 浏览器 url/title 变化（on_page_load 触发，§6.0）。
pub(crate) const BROWSER_PAGE: &str = "pylon:browser-page";
