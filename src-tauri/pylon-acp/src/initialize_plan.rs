//! B2：initialize 与 session/new 的纯计划层。
//!
//! client/engine 只消费计划，不再各自拼握手参数：`build_initialize_plan`
//! 由协议配置（用户 agents.yaml）+ provider 策略（catalog）产出
//! [`InitializePlan`]，wire 上的三段（protocolVersion / clientCapabilities /
//! clientInfo）只在这一处成形；caps 声明非法在这里 fail-closed，不会以
//! 一份不完整的 capability 文档继续握手。
//!
//! session 建立侧：[`SessionNewPlan`] 收拢 session/new 参数（MCP 模式语义
//! 保持在 `session_new_params`），[`EstablishmentChannel`] 通道类型由
//! `negotiated::NegotiatedCapabilitySnapshot::establishment_channels` 按
//! 「catalog 声明顺序 ∩ 服务端能力」的交集规则产出——声明了 resume 但服务端
//! 没广告，或反之，都不产生 resume 通道；`new` 是 ACP 必备通道，恒在最后。

use crate::error::{AcpError, AgentConnectFailure};
use pylon_core::agent_config::{AcpProtocolConfig, McpServersMode};

/// #348 A6：Pylon 接受的 ACP `protocolVersion` 白名单（fail-closed）。
///
/// Pylon 只有 v1 wire 实现（代码 100% 走 `agent_client_protocol_schema::v1`，
/// 未启用 `unstable_protocol_v2`）；官方将 V2 定性为 unstable draft 且必须
/// 显式选择。`validate_protocol_version` 只验「agent 回显 == 请求」，拦不住
/// 「请求 2、agent 回 2」的互相确认；本集合在计划层拦住「发出 Pylon 无实现
/// 的版本号」。将来启用 v2 时只扩这一处。
const SUPPORTED_PROTOCOL_VERSIONS: &[u16] = &[1];

/// initialize 握手计划：三段参数的不可变成形。
#[derive(Debug, Clone, PartialEq)]
pub struct InitializePlan {
    pub protocol_version: u16,
    pub client_capabilities: serde_json::Value,
    pub client_info: serde_json::Value,
}

/// 由协议配置 + provider 策略构造 initialize 计划。
///
/// 非法 clientCapabilities 声明 → `agent_client_capabilities_invalid`
/// （A3 裁定：显式 YAML 与 catalog 声明非法都当场失败，不静默回退默认）。
/// `policy`：宿主门解析结论（YAML+env 单一解析，见
/// [`crate::host_tools::HostToolsPolicy::resolve`]）——**广告侧与 dispatcher
/// 门禁侧必须消费同一份结论**（#316 P1：env 回退若只被门禁消费，会出现
/// 「广告 fs 但每发必拒」的同源破窗）。
pub fn build_initialize_plan(
    protocol: &AcpProtocolConfig,
    provider: Option<&str>,
    policy: crate::host_tools::HostToolsPolicy,
) -> Result<InitializePlan, AcpError> {
    let invalid = |message: String| {
        AcpError::Connect(Box::new(AgentConnectFailure::preflight(
            "agent_client_capabilities_invalid",
            message,
        )))
    };
    let mut client_capabilities = protocol
        .initialize_caps_for_provider(provider)
        .map_err(invalid)?;
    // #348 A6：protocolVersion 接受集合断言——集合外的用户配置当场失败，
    // 不再静默发出（稳定码沿用 `agent_client_capabilities_invalid`，不扩词表）。
    let requested_protocol_version = protocol.protocol_version();
    if !SUPPORTED_PROTOCOL_VERSIONS.contains(&requested_protocol_version) {
        return Err(invalid(format!(
            "acp.protocol_version = {requested_protocol_version} 不在 Pylon 支持集合 \
             {SUPPORTED_PROTOCOL_VERSIONS:?} 内（Pylon 当前仅有 v1 wire 实现）"
        )));
    }
    // 显式 YAML 覆盖此前不经任何形状校验：`initialize_caps: 42` 会把标量
    // clientCapabilities 发上 wire。顶层必须是 object（B2 fail-closed）。
    if !client_capabilities.is_object() {
        return Err(invalid(
            "acp.initialize_caps 必须是 object（clientCapabilities 的各能力键均为 object）"
                .to_string(),
        ));
    }
    // #316：宿主门声明注入——「广告 ⇔ dispatcher 门禁」同源（门开注入官方
    // 形状，门关裁剪残留声明）。显式 initialize_caps 覆盖制契约不变：声明了
    // 就整体自担（fs/terminal 键需自含），不追加不裁剪。
    if protocol.initialize_caps.is_none() {
        apply_host_gates(&mut client_capabilities, policy);
        // #316：elicitation 标准 form 模式广告（GUI 表单卡随本 issue 上线，
        // 能力与 UI 同步交付）。url 模式不支持故不广告——官方语义：未广告的
        // mode 视为不支持，agent 不得发起。
        if let Some(obj) = client_capabilities.as_object_mut() {
            obj.insert("elicitation".into(), serde_json::json!({"form": {}}));
        }
    }
    Ok(InitializePlan {
        protocol_version: protocol.protocol_version(),
        client_capabilities,
        client_info: protocol.client_info(),
    })
}

/// #316：按宿主门在 clientCapabilities 上注入/裁剪 fs 与 terminal 声明。
/// 官方形状：`fs:{readTextFile:true,writeTextFile:true}`（object 值）与
/// `terminal:true`（顶层布尔）。Host 与 Unrestricted 广告面相同，差异只在
/// fs 执行沙箱（dispatcher 侧 strict 判定）。
fn apply_host_gates(caps: &mut serde_json::Value, policy: crate::host_tools::HostToolsPolicy) {
    let Some(obj) = caps.as_object_mut() else {
        return;
    };
    use pylon_core::agent_config::HostToolsMode;
    match policy.fs {
        HostToolsMode::Agent => {
            obj.remove("fs");
        }
        HostToolsMode::Host | HostToolsMode::Unrestricted => {
            obj.insert(
                "fs".into(),
                serde_json::json!({"readTextFile": true, "writeTextFile": true}),
            );
        }
    }
    match policy.terminal {
        pylon_core::agent_config::HostToolsMode::Agent => {
            obj.remove("terminal");
        }
        _ => {
            obj.insert("terminal".into(), serde_json::Value::Bool(true));
        }
    }
}

impl InitializePlan {
    /// wire 上的 initialize params（三段顺序固定，便于 golden trace 逐字节比对）。
    pub fn params(&self) -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": self.protocol_version,
            "clientCapabilities": self.client_capabilities,
            "clientInfo": self.client_info,
        })
    }
}

/// session/new 计划：cwd + MCP 载荷 + MCP 模式（Always/OmitIfEmpty）。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionNewPlan {
    pub cwd: String,
    pub mcp_servers: Vec<serde_json::Value>,
    pub mcp_mode: McpServersMode,
}

pub fn build_session_new_plan(
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
    pub fn params(&self) -> Result<serde_json::Value, String> {
        crate::session_new_params(&self.cwd, self.mcp_servers.clone(), self.mcp_mode)
    }
}

/// 会话建立通道（revive 链的原子单位）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstablishmentChannel {
    Resume,
    Load,
    New,
}

// 「catalog 声明顺序 ∩ 服务端能力」的交集规则自 #98 起真源收敛到
// [`crate::negotiated::NegotiatedCapabilitySnapshot::establishment_channels`]：
// session 建立、重连 continuity probe、agent_status 快照消费同一份协商结论，
// 任何调用方不再各自拼接 capability path。本模块只保留通道类型与计划层。

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn protocol() -> AcpProtocolConfig {
        AcpProtocolConfig::default()
    }

    /// 计划的 wire 形状：默认 caps + #316 宿主门注入（默认 fs 开/terminal 关）。
    #[test]
    fn initialize_plan_params_match_the_inline_wire_shape() {
        let config = protocol();
        let plan =
            build_initialize_plan(&config, None, crate::host_tools::HostToolsPolicy::default())
                .unwrap();
        let mut caps = config.initialize_caps_for_provider(None).unwrap();
        caps["fs"] = json!({"readTextFile": true, "writeTextFile": true});
        caps["elicitation"] = json!({"form": {}});
        let expected = json!({
            "protocolVersion": config.protocol_version(),
            "clientCapabilities": caps,
            "clientInfo": config.client_info(),
        });
        assert_eq!(plan.params(), expected);
    }

    /// #316：默认门控 = fs 广告（host 沙箱）+ terminal 不广告。
    #[test]
    fn default_host_gates_advertise_fs_but_not_terminal() {
        let config = protocol();
        let plan =
            build_initialize_plan(&config, None, crate::host_tools::HostToolsPolicy::default())
                .unwrap();
        let caps = &plan.params()["clientCapabilities"];
        assert_eq!(
            caps["fs"],
            json!({"readTextFile": true, "writeTextFile": true})
        );
        assert!(caps.get("terminal").is_none());
    }

    /// #316：显式 initialize_caps 覆盖制——不追加也不裁剪（声明整体自担）。
    #[test]
    fn explicit_caps_skip_host_gate_injection() {
        let mut config = protocol();
        config.initialize_caps = Some(json!({"tokenStats": true}));
        // 门虽为 host，但显式 caps 路径跳过注入——不得冒出 fs 键。
        config.host_tools = Some(pylon_core::agent_config::HostToolsMode::Host);
        let plan =
            build_initialize_plan(&config, None, crate::host_tools::HostToolsPolicy::default())
                .unwrap();
        assert_eq!(
            plan.params()["clientCapabilities"],
            json!({"tokenStats": true})
        );
    }

    /// #316：terminal 门开启时注入官方布尔；fs 门 agent 时裁剪残留声明。
    #[test]
    fn host_gates_inject_terminal_and_strip_closed_fs() {
        let mut config = protocol();
        config.host_terminal = Some(pylon_core::agent_config::HostToolsMode::Host);
        let policy = crate::host_tools::HostToolsPolicy {
            fs: pylon_core::agent_config::HostToolsMode::Host,
            terminal: pylon_core::agent_config::HostToolsMode::Host,
        };
        let plan = build_initialize_plan(&config, None, policy).unwrap();
        let caps = &plan.params()["clientCapabilities"];
        assert_eq!(caps["terminal"], json!(true));

        let mut caps = json!({"fs": {"readTextFile": true}});
        apply_host_gates(&mut caps, crate::host_tools::HostToolsPolicy::closed());
        assert!(caps.get("fs").is_none(), "门关必须裁剪声明（同源防漂移）");
    }

    /// 非法 caps 声明在计划层 fail-closed（稳定错误码）。
    #[test]
    fn initialize_plan_fails_closed_on_invalid_caps() {
        let mut config = protocol();
        config.initialize_caps = Some(json!(42));
        let AcpError::Connect(failure) =
            build_initialize_plan(&config, None, crate::host_tools::HostToolsPolicy::default())
                .unwrap_err()
        else {
            panic!("非法 caps 必须映射为 Connect 失败");
        };
        assert_eq!(failure.code, "agent_client_capabilities_invalid");
    }

    /// #348 A6：protocolVersion 接受集合 fail-closed——集合外的用户配置当场
    /// 拒绝（此前静默发出 Pylon 无实现的版本号）；集合内与缺省照常放行。
    #[test]
    fn initialize_plan_rejects_unsupported_protocol_version() {
        let mut config = protocol();
        config.protocol_version = Some(2);
        let AcpError::Connect(failure) =
            build_initialize_plan(&config, None, crate::host_tools::HostToolsPolicy::default())
                .unwrap_err()
        else {
            panic!("集合外 protocol_version 必须映射为 Connect 失败");
        };
        assert_eq!(failure.code, "agent_client_capabilities_invalid");

        config.protocol_version = Some(1);
        assert!(build_initialize_plan(
            &config,
            None,
            crate::host_tools::HostToolsPolicy::default()
        )
        .is_ok());
        config.protocol_version = None;
        assert!(build_initialize_plan(
            &config,
            None,
            crate::host_tools::HostToolsPolicy::default()
        )
        .is_ok());
    }

    fn registry(capabilities: serde_json::Value) -> crate::CapabilityRegistry {
        crate::CapabilityRegistry::from_initialize_response(&json!({
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

    /// 计划层引用的 [`crate::negotiated`] 快照与旧内联交集同结论（金丝雀）：
    /// 嵌套 object 广告产生通道、标量不算能力。矩阵全量语义见 negotiated.rs 测试。
    #[test]
    fn snapshot_establishment_channels_match_the_inline_intersection() {
        use crate::negotiated::NegotiatedCapabilitySnapshot;
        let full = registry(json!({"sessionCapabilities": {"resume": {}, "loadSession": {}}}));
        let declared = vec!["resume".to_string(), "load".to_string(), "new".to_string()];
        let snapshot = NegotiatedCapabilitySnapshot::from_parts(
            &full,
            &declared,
            0,
            &std::collections::BTreeSet::new(),
        );
        assert_eq!(
            snapshot.establishment_channels().unwrap(),
            vec![
                EstablishmentChannel::Resume,
                EstablishmentChannel::Load,
                EstablishmentChannel::New
            ]
        );
        // 标量不算 object capability（fail-closed 同旧实现）。
        let scalar = registry(json!({"sessionCapabilities": {"resume": true, "loadSession": {}}}));
        let snapshot = NegotiatedCapabilitySnapshot::from_parts(
            &scalar,
            &declared,
            0,
            &std::collections::BTreeSet::new(),
        );
        assert_eq!(
            snapshot.establishment_channels().unwrap(),
            vec![EstablishmentChannel::Load, EstablishmentChannel::New]
        );
    }
}
