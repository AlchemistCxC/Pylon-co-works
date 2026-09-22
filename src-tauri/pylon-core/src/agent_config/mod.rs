//! agents.yaml 的 AgentDef 值类型与协议默认值常量（#247 自宿主 agent_config/types.rs
//! 归位——AgentDef 是 catalog/detection/launch plan/hermes 的共同输入，与 pylon-core
//! 同域；load/patch 等编排层留在宿主）。
use std::path::PathBuf;

pub mod types;

pub use types::*;

// #247：配置定位（env 覆盖 + exe 同目录回退）随值类型同域；宿主 atomic_write 的
// 读写编排经重导出继续消费。
pub fn config_path() -> Option<PathBuf> {
    std::env::var_os("PYLON_AGENTS_CONFIG").map(PathBuf::from)
}

pub fn effective_config_path() -> Option<PathBuf> {
    if let Some(path) = config_path() {
        return Some(path);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let nearby = dir.join("agents.yaml");
            if nearby.is_file() {
                return Some(nearby);
            }
        }
    }
    None
}


/// G1-05：DEFAULT_* 前缀统一；值不变。超时访问器（prompt_timeout/
/// cancel_settle_timeout）在 AcpProtocolConfig（agent_config.rs），
/// DEFAULT_* 为"无声明=现状"默认值的唯一事实源。
pub const DEFAULT_PROMPT_TIMEOUT_SECS: u64 = 300;

/// R-t5 闲置窗口缺省（秒）。**刻意与 prompt 预算解耦**：这个窗口判的是"完全无输出"的
/// 停摆，不是"一个提示步骤的预算"。
///
/// 为什么从 prompt 预算里拆出来（2026-09-20 用户裁决）：agent 在等待**用户**动作时也表现为
/// 无输出（权限请求弹出后静默等点击），把它按"停摆"判死会截断一个实际上正常的回合——真机
/// 实测一次 472s 的截断正卡在等权限答复上。取 600s 给一个够长的动作缓冲，同时仍能收敛掉
/// 真正卡死的回合。首 token 窗口不跟着放宽（见 `first_token_timeout`），"从未启动"仍按短判据。
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 600;
/// Maximum time to wait for Peri's final prompt response after sending cancel.
pub const DEFAULT_CANCEL_SETTLE_TIMEOUT_SECS: u64 = 30;
/// Maximum size for a single attachment.
pub const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
/// Maximum number of attachments in one prompt.
pub const DEFAULT_MAX_ATTACHMENTS: usize = 8;
