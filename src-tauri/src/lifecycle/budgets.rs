//! 生命周期域时间预算常量归口（R.5-1 选项 b：宿主内落点，零行为变化的纯搬家）。
//!
//! # 三形状词法（新增预算必须声明形状与测量者）
//!
//! - **TotalDeadline**：绝对 deadline，测量含全部子阶段（如连接测试 15s 包裹全程）。
//! - **StageBudget**：每阶段 `min(声明预算, 剩余总预算)`（如检测版本探测 2s ∧ 剩余）。
//! - **Ttl**：缓存有效期（如检测快照 Success/Unknown/Failure = 600/60/15s）。
//!
//! # 归口边界（三类预算不同源，不假统一）
//!
//! - 本文件只收宿主 lifecycle 的 UX 上限秒数常量；
//! - 协议派生预算（`rpc_timeout`/prompt 族，agents.yaml 可配）的默认值唯一事实源在
//!   `pylon-core::agent_config`（`AgentDef` 值类型与协议默认值常量的既有归宿）；
//! - 检测预算（总预算 8s / 版本探测 2s / 并发 4）由 `AgentDetectionLimits` 注入，
//!   定义在 `pylon-core::agent_detection::types`；
//! - pylon-acp 域预算（EXEC_BUSY 退避 1s、replay deadline、CLI kernel 30s/300s）
//!   留在各自模块，不属于生命周期域。
//!
//! | 预算 | 值 | 形状 | 消费点 |
//! |---|---|---|---|
//! | `AGENT_VALIDATION_TIMEOUT_SECS` | 15s | TotalDeadline（tokio::timeout 包全程） | `connection_test` 两命令 |
//! | `SESSION_PROBE_HARD_CAP_SECS` | 30s | TotalDeadline（`min(rpc_timeout, 本值)`，全候选共享 deadline） | `session_probe` |

/// 隔离连接测试总预算（秒）：`test_agent_connection` / `test_agent_candidate`
/// 的 tokio::timeout 包裹值（「连接测试从开始到返回不超过 15 秒」的上限契约）。
pub(crate) const AGENT_VALIDATION_TIMEOUT_SECS: u64 = 15;

/// 会话 continuity probe 预算硬顶（秒）：实际预算 = `min(rpc_timeout, 本值)`，
/// 单一 deadline 由全部候选共享（并发 4 有界 probe）。
pub(crate) const SESSION_PROBE_HARD_CAP_SECS: u64 = 30;
