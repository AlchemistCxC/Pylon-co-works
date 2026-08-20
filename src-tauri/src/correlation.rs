//! OBS-02：身份 correlation contract（方案书 §5.2 的 Rust 实现）。
//!
//! 统一所有日志和事件中的 identity——禁止只记录 `source` 或只记录 `sessionId`。
//! 连接级字段（agentId/provider/source/clientGeneration）在连接建立时固定；
//! 会话级字段（localSessionId/remoteSessionId/periId/requestId/toolCallId）
//! 按需填充（wire trace 从报文提取远端侧；localSessionId 由上层会话映射供给）。
//!
//! 纪律（方案书 §5.2 注意）：
//! - `source` 不是 owner：同名 source 可存在于不同 Agent → 必须与 agentId +
//!   clientGeneration 合看，不能只凭 source 定位。
//! - remote session id 不是 local session id：两者分字段，绝不复用一个字段。
//! - generation 在 runtime replacement 时递增（由调用方把连接所属代际传入，
//!   不能只依赖时间）。
//! - 新字段一律 `Option` + `skip_serializing_if`：旧 UI 不认识新字段时缺失
//!   不影响既有字段解析，日志命令不得因缺字段失败。

use serde::{Deserialize, Serialize};

/// 统一身份 correlation context（方案书 §5.2 `RuntimeCorrelation`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCorrelation {
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// transport（如 `subprocess`）。**不是 owner**——只与 agentId+generation 合看。
    pub source: String,
    /// Pylon 侧本地会话键（profileId+agentId+localSessionId，OWNER-01）。
    /// transport 边界不可知，由上层会话映射供给（OBS-03/05）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_session_id: Option<String>,
    /// Agent 侧远端会话 id（wire 的 `sessionId`，session/new 返回、后续 RPC 寻址）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_session_id: Option<String>,
    /// session/update 事件里 Agent 上报的会话 id（Peri 侧视角）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peri_id: Option<String>,
    /// 连接所属 client 代际（runtime replacement 时必须递增）。
    pub client_generation: u64,
    /// session/request_permission 请求 id（wire 的 `id`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl RuntimeCorrelation {
    /// 从 AgentDef 构造连接级 identity（client_generation 由调用方传入，
    /// 见 lifecycle::do_connect_and_replace 的代际递增语义）。
    pub fn from_agent(agent: &crate::agent_config::AgentDef, client_generation: u64) -> Self {
        Self {
            agent_id: agent.name.clone(),
            provider: agent.provider.clone(),
            source: agent.transport.clone(),
            local_session_id: None,
            remote_session_id: None,
            peri_id: None,
            client_generation,
            request_id: None,
            tool_call_id: None,
        }
    }
}
