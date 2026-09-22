// #245：原 crate 根的 agent_detection.rs / agent_runtime.rs 归入本目录。
// 职责边界不变：detection 是 GUI 侧检测命令层（TTL 缓存/取消），runtime 是
// 多 agent 运行时状态机；纯探测逻辑仍在 pylon-core，不得反向依赖本 crate。
pub mod detection;
pub(crate) mod runtime;
