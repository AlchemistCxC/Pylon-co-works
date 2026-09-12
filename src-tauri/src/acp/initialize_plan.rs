//! B2：initialize 与 session/new 的纯计划层。
//!
//! client/engine 只消费计划，不再各自拼握手参数：`build_initialize_plan`
//! 由协议配置（用户 agents.yaml）+ provider 策略（catalog）产出
//! [`InitializePlan`]，wire 上的三段（protocolVersion / clientCapabilities /
//! clientInfo）只在这一处成形；caps 声明非法在这里 fail-closed，不会以
//! 一份不完整的 capability 文档继续握手。
//!
//! session 建立侧：[`SessionNewPlan`] 收拢 session/new 参数（MCP 模式语义
//! 保持在 `session_new_params`），[`EstablishmentChannel`] +
//! [`session_establishment_channels`] 把「catalog 声明顺序 ∩ 服务端能力」的
//! 交集规则做成纯函数——声明了 resume 但服务端没广告，或反之，都不产生
//! resume 通道；`new` 是 ACP 必备通道，恒在最后。

use crate::acp::error::{AcpError, AgentConnectFailure};
use crate::agent_config::{AcpProtocolConfig, McpServersMode};

/// initialize 握手计划：三段参数的不可变成形。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct InitializePlan {
    pub protocol_version: u16,
    pub client_capabilities: serde_json::Value,
    pub client_info: serde_json::Value,
}

/// 由协议配置 + provider 策略构造 initialize 计划。
///
/// 非法 clientCapabilities 声明 → `agent_client_capabilities_invalid`
/// （A3 裁定：显式 YAML 与 catalog 声明非法都当场失败，不静默回退默认）。
pub(crate) fn build_initialize_plan(
    protocol: &AcpProtocolConfig,
    provider: Option<&str>,
) -> Result<InitializePlan, AcpError> {
    let invalid = |message: String| {
        AcpError::Connect(Box::new(AgentConnectFailure::preflight(
            "agent_client_capabilities_invalid",
            message,
        )))
    };
    let client_capabilities = protocol
        .initialize_caps_for_provider(provider)
        .map_err(invalid)?;
    // 显式 YAML 覆盖此前不经任何形状校验：`initialize_caps: 42` 会把标量
    // clientCapabilities 发上 wire。顶层必须是 object（B2 fail-closed）。
    if !client_capabilities.is_object() {
        return Err(invalid(
            "acp.initialize_caps 必须是 object（clientCapabilities 的各能力键均为 object）"
                .to_string(),
        ));
    }
    Ok(InitializePlan {
        protocol_version: protocol.protocol_version(),
        client_capabilities,
        client_info: protocol.client_info(),
    })
}

impl InitializePlan {
    /// wire 上的 initialize params（三段顺序固定，便于 golden trace 逐字节比对）。
    pub(crate) fn params(&self) -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": self.protocol_version,
            "clientCapabilities": self.client_capabilities,
            "clientInfo": self.client_info,
        })
    }
}

/// session/new 计划：cwd + MCP 载荷 + MCP 模式（Always/OmitIfEmpty）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SessionNewPlan {
    pub cwd: String,
    pub mcp_servers: Vec<serde_json::Value>,
    pub mcp_mode: McpServersMode,
}

pub(crate) fn build_session_new_plan(
    cwd: String,
    mcp_servers: Vec<serde_json::Value>,
    mcp_mode: McpServersMode,
) -> SessionNewPlan {
    SessionNewPlan {
        cwd,
        mcp_servers,
        mcp_mode,
    }
}

impl SessionNewPlan {
    /// wire 上的 session/new params（MCP 键语义由 `session_new_params` 持有）。
    pub(crate) fn params(&self) -> Result<serde_json::Value, String> {
        crate::acp::session_new_params(&self.cwd, self.mcp_servers.clone(), self.mcp_mode)
    }
}

/// 会话建立通道（revive 链的原子单位）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EstablishmentChannel {
    Resume,
    Load,
    New,
}

/// 会话建立通道 = catalog 声明顺序 ∩ 服务端能力交集，按声明顺序排列。
///
/// - `resume` 通道：声明 ∧ 服务端 `sessionCapabilities.resume` 为 object；
/// - `load` 通道：声明 ∧ 服务端 `sessionCapabilities.loadSession` 为 object；
/// - `new` 通道：ACP 必备，声明即可（catalog 校验已保证 order 以 new 收尾）。
///
/// 广告侧经 [`crate::acp::CapabilityRegistry::supports_object`]（initialize
/// 协商的 typed fail-closed 视图）——不在此重新解析 raw JSON。未知声明名 →
/// Err（fail-closed：拼错的 policy 必须在计划层显形，而不是被静默丢弃后以
/// 一条看似合法的短链继续）。
pub(crate) fn session_establishment_channels(
    declared_order: &[&str],
    registry: &crate::acp::CapabilityRegistry,
) -> Result<Vec<EstablishmentChannel>, String> {
    let mut channels = Vec::new();
    for declared in declared_order {
        match *declared {
            "resume" => {
                if registry.supports_object(&["sessionCapabilities", "resume"]) {
                    channels.push(EstablishmentChannel::Resume);
                }
            }
            "load" => {
                if registry.supports_object(&["sessionCapabilities", "loadSession"]) {
                    channels.push(EstablishmentChannel::Load);
                }
            }
            "new" => channels.push(EstablishmentChannel::New),
            other => {
                return Err(format!(
                    "sessionEstablishment 声明了未知通道：{other}（合法值：resume/load/new）"
                ))
            }
        }
    }
    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn protocol() -> AcpProtocolConfig {
        AcpProtocolConfig::default()
    }

    /// 计划的 wire 形状与 client 旧内联拼装逐字节一致（golden 前提）。
    #[test]
    fn initialize_plan_params_match_the_inline_wire_shape() {
        let config = protocol();
        let plan = build_initialize_plan(&config, None).unwrap();
        let expected = json!({
            "protocolVersion": config.protocol_version(),
            "clientCapabilities": config.initialize_caps_for_provider(None).unwrap(),
            "clientInfo": config.client_info(),
        });
        assert_eq!(plan.params(), expected);
    }

    /// 非法 caps 声明在计划层 fail-closed（稳定错误码）。
    #[test]
    fn initialize_plan_fails_closed_on_invalid_caps() {
        let mut config = protocol();
        config.initialize_caps = Some(json!(42));
        let AcpError::Connect(failure) = build_initialize_plan(&config, None).unwrap_err() else {
            panic!("非法 caps 必须映射为 Connect 失败");
        };
        assert_eq!(failure.code, "agent_client_capabilities_invalid");
    }

    fn registry(capabilities: serde_json::Value) -> crate::acp::CapabilityRegistry {
        crate::acp::CapabilityRegistry::from_initialize_response(&json!({
            "agentCapabilities": capabilities
        }))
        .unwrap()
    }

    /// session/new 计划透传 MCP 模式语义（Always 恒发 / OmitIfEmpty 空省键）。
    #[test]
    fn session_new_plan_preserves_mcp_mode_semantics() {
        let always = build_session_new_plan("C:/work".into(), Vec::new(), McpServersMode::Always);
        assert_eq!(always.params().unwrap().get("mcpServers"), Some(&json!([])));
        let omit =
            build_session_new_plan("C:/work".into(), Vec::new(), McpServersMode::OmitIfEmpty);
        assert!(omit.params().unwrap().get("mcpServers").is_none());
    }

    /// 交集矩阵：声明 ∧ 广告才产生通道；new 恒在；未知声明 fail-closed。
    #[test]
    fn establishment_channels_are_the_declared_advertised_intersection() {
        let full = registry(json!({"sessionCapabilities": {"resume": {}, "loadSession": {}}}));
        assert_eq!(
            session_establishment_channels(&["resume", "load", "new"], &full).unwrap(),
            vec![
                EstablishmentChannel::Resume,
                EstablishmentChannel::Load,
                EstablishmentChannel::New
            ]
        );

        // 服务端只广告 load：resume 不产生（声明了也不行——这就是交集）。
        let load_only = registry(json!({"sessionCapabilities": {"loadSession": {}}}));
        assert_eq!(
            session_establishment_channels(&["resume", "load", "new"], &load_only).unwrap(),
            vec![EstablishmentChannel::Load, EstablishmentChannel::New]
        );

        // 服务端什么都没广告：只剩 new（ACP 必备通道）。
        let bare = registry(json!({}));
        assert_eq!(
            session_establishment_channels(&["resume", "load", "new"], &bare).unwrap(),
            vec![EstablishmentChannel::New]
        );

        // 声明不含 resume：即使服务端广告了 resume 也不产生（双向交集）。
        assert_eq!(
            session_establishment_channels(&["load", "new"], &full).unwrap(),
            vec![EstablishmentChannel::Load, EstablishmentChannel::New]
        );

        // 广告值必须是 object：标量不算能力。
        let scalar = registry(json!({"sessionCapabilities": {"resume": true, "loadSession": {}}}));
        assert_eq!(
            session_establishment_channels(&["resume", "load", "new"], &scalar).unwrap(),
            vec![EstablishmentChannel::Load, EstablishmentChannel::New]
        );

        // 未知声明名 fail-closed。
        assert!(session_establishment_channels(&["resume", "fork", "new"], &full).is_err());
    }
}
