
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;


/// 启动/加载配置的领域错误（R7/P2-1）。Display 透传原文案（前端/日志依赖文案
/// 不变），code() 提供机器可读细分（前端分支依据，稳定不拼写变更）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// 配置文件读取失败（含完整路径；诊断 DTO 出口由 startup::sanitize_message 脱敏）。
    #[error("{0}")]
    Read(String),
    /// YAML 语法/结构解析失败。
    #[error("{0}")]
    Parse(String),
    /// 单个 agent 语义校验失败（空 name/exe、非法 env/transport、acp 段非法等）。
    #[error("{0}")]
    InvalidAgent(String),
    /// 其他配置级错误（空 agents 表、默认 agent 冲突等）。
    #[error("{0}")]
    Invalid(String),
    /// 配置不可写（embedded 无外部写入目标；后端施工计划书 Phase 3 §5.4）。
    #[error("config_read_only: 当前为嵌入配置，无外部写入目标")]
    ReadOnly,
    /// 配置写入失败（临时文件/同步/rename 等）。
    #[error("config_write_error: {0}")]
    Write(String),
    /// 配置文件在读取与提交之间已被其他写入者修改。
    #[error("config_revision_conflict: 期望 {expected}，实际 {actual}")]
    Conflict { expected: String, actual: String },
    /// 外部配置写入必须显式携带最近一次 snapshot 的 revision，禁止盲写。
    #[error("config_revision_required: 写入外部配置前必须先读取配置快照")]
    RevisionRequired,
    /// 配置备份失败；主文件不得被替换。
    #[error("config_backup_error: {0}")]
    Backup(String),
    /// 跨进程配置 lease 已被占用。
    #[error("config_lock_busy: {0}")]
    LockBusy(String),
    /// 候选配置删除当前 active agent（保护语义，与 reload_agents 一致）。
    #[error("config_active_agent_protected: {0}")]
    ActiveAgentProtected(String),
    /// 磁盘已提交但内存域 reload 未完成（禁止返回成功）。
    #[error("config_not_applied: {0}")]
    NotApplied(String),
}

impl ConfigError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Read(_) => "config_read_error",
            Self::Parse(_) => "config_parse_error",
            Self::InvalidAgent(_) => "config_invalid_agent",
            Self::Invalid(_) => "config_error",
            Self::ReadOnly => "config_read_only",
            Self::Write(_) => "config_write_error",
            Self::Conflict { .. } => "config_revision_conflict",
            Self::RevisionRequired => "config_revision_required",
            Self::Backup(_) => "config_backup_error",
            Self::LockBusy(_) => "config_lock_busy",
            Self::ActiveAgentProtected(_) => "config_active_agent_protected",
            Self::NotApplied(_) => "config_not_applied",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AgentConfigFile {
    /// E1：agents 先以宽松值解析，再在 parse() 内逐 agent 反序列化——
    /// 非法字段（负数值/未知枚举/类型错误）的报错带 agent id 上下文。
    pub(crate) agents: HashMap<String, serde_yml::Value>,
    /// 外置工具归一化字典（provider → tools）。缺省为空表，前端可继续使用内置 fallback。
    #[serde(default)]
    pub(crate) tool_dictionary: HashMap<String, Vec<ToolDictEntry>>,
}

/// 工具归一化字典条目（agents.yaml `tool_dictionary.<provider>[]`）。
/// 字段语义与前端 toolRegistry 对齐：name/aliases/kind/action/summary_fields/output_label。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolDictEntry {
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    pub kind: String,
    pub action: String,
    #[serde(default)]
    pub summary_fields: Vec<String>,
    #[serde(default)]
    pub output_label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentDef {
    pub name: String,
    /// Protocol/implementation category, separate from the configured agent instance id.
    #[serde(default)]
    pub provider: Option<String>,
    pub transport: String,
    pub exe: String,
    /// 进程级原始参数（如入口子命令 `acp`），原样拼在 exe 后。
    #[serde(default, deserialize_with = "string_or_scalar_seq")]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// O27：env 值宽松化——number/bool 标量自动转字符串（`PORT: 8080` 不再整份拒绝）。
    #[serde(default, deserialize_with = "string_or_scalar")]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub default: bool,
    /// 核验修复：切 model 走 unstable session/set_model（Hermes 系）而非
    /// set_config_option("model")（Peri 系）。默认 false = 官方路径。
    /// agents.yaml 对 Hermes 类 agent 配置 `set_model_api: true`。
    #[serde(default)]
    pub set_model_api: bool,
    /// 结构化 acp 参数：初始模型，展开为 `--model <value>` 追加在 args 后。
    #[serde(default)]
    pub model: Option<String>,
    /// Hermes profile 固定（release-issues #1 方案 G 演进）：值为 profile 名称
    /// （如 `profile-a`，经 Hermes 根目录解析为 `<home>/profiles/<name>`）或
    /// profile 目录路径（绝对路径原样使用，相对路径按配置目录解析）。
    /// 设置后启动 ACP 子进程时注入 `HERMES_HOME=<profile 目录>`，确保 Hermes
    /// 加载该 profile 的 provider/密钥，而不是继承启动器环境或 active_profile
    /// 机制（当前机器 active_profile=profile-x 会导致 401）。缺省不注入（现状行为）。
    #[serde(default)]
    pub hermes_profile: Option<String>,
    /// 结构化 acp 参数：附加任意参数（如 `--verbose`），追加在 args 后。
    #[serde(default)]
    pub acp_args: Vec<String>,
    /// per-agent ACP 协议行为配置（差异适配字典外置；缺省 = 官方 schema 行为）。
    #[serde(default)]
    pub acp: Option<AcpProtocolConfig>,
}

/// per-agent ACP 协议行为配置（agents.yaml `acp:` 段）。
///
/// 覆盖制：字段缺省 = 当前行为默认值（DEFAULT_* 常量，值 = 重构前硬编码现值），
/// 有声明 = 覆盖。默认路径 wire 逐字节不变；新配置仅当用户声明才改变 wire。
/// 差异适配（D 系列）与硬编码（H2-H12）全部收敛于此，事实源见
/// docs/refactor/07-ACP协议全貌.md §5。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AcpProtocolConfig {
    /// D2 切 model 途径：config_option(默认) | set_model | none。
    /// 双格式兼容：bool true=set_model / false=config_option（自定义反序列化器
    /// [`deserialize_set_model_api`]）。None = 未声明——回退 AgentDef 顶层 legacy
    /// `set_model_api` 布尔（parse() 时合并解析，见 [`AgentDef::protocol`]）。
    #[serde(default, deserialize_with = "deserialize_set_model_api")]
    pub set_model_api: Option<SetModelApi>,
    /// D3 session/close：None|true = 总是尝试 RPC + -32601 防御降级（现状）；
    /// false = 跳过 RPC 直接本地清理（旧 Hermes 声明式配置）。
    /// G2（W2 链 E）消费：close_session/check_session_expiry/未结算 close/replaced close
    /// 四处经 [`Self::close_via_rpc`] 判定。
    #[serde(default)]
    pub session_close: Option<bool>,
    /// D4 mcpServers 字段形态：always(默认，恒发字段，现状) | omit_if_empty
    /// （v2 语义，空则省略——07 文档 §8.2）。
    /// G2（W2 链 E）消费：session_new/load 调用点传 `protocol().mcp_servers`。
    #[serde(default, deserialize_with = "deserialize_mcp_servers_mode")]
    pub mcp_servers: McpServersMode,
    /// D1 initialize 请求的 clientCapabilities 覆盖（任意 JSON，原样进 wire）。
    /// None = 统一默认（tokenStats + _meta.peri.*，Hermes 忽略无害）。
    #[serde(default)]
    pub initialize_caps: Option<serde_json::Value>,
    /// H3 initialize protocolVersion；None = 1。
    #[serde(default)]
    pub protocol_version: Option<u16>,
    /// H4 initialize clientInfo；None = {"name":"Pylon","version":"0.1.0"}。
    #[serde(default)]
    pub client_info: Option<serde_json::Value>,
    /// H5 单步闲置超时的缺省值（秒）；None = 300。每个分析/思考/工具步骤
    /// 都重新获得该时间窗口，不设置整轮回合的绝对墙钟上限。
    #[serde(default)]
    pub prompt_timeout_secs: Option<u64>,
    /// H6 cancel settle 超时（秒）；None = 30。
    #[serde(default)]
    pub cancel_settle_timeout_secs: Option<u64>,
    /// R-t5 闲置超时（秒）；None = prompt_timeout（300）。回合内距最后一次活动
    /// （文本 chunk / thinking / 工具事件 / usage 任一）超过此值仍无终态 →
    /// 判死 cancel。活动即续命：只要持续产出，回合永不因"总时长"被截。
    #[serde(default)]
    pub idle_timeout_secs: Option<u64>,
    /// R-t5 首 token 超时（秒）；None = idle_timeout。发出后到首次活动的最长等待，
    /// 治"静默失败"（如 Hermes+opencode.ai 错误 profile 导致 session/prompt 无声）。
    #[serde(default)]
    pub first_token_timeout_secs: Option<u64>,
    /// H8/H9 通用 RPC 超时（秒，complete + session/load 回放共用）；None = 30。
    #[serde(default)]
    pub rpc_timeout_secs: Option<u64>,
    /// H10 单条 prompt 附件数上限；None = 8。
    #[serde(default)]
    pub max_attachments: Option<usize>,
    /// H11 单附件大小上限（字节）；None = 10MB。
    #[serde(default)]
    pub max_attachment_bytes: Option<u64>,
    /// H12 session/load 回放收集上限；None = 10_000。
    #[serde(default)]
    pub replay_max_events: Option<usize>,
}

/// D2 切 model 途径（枚举化替代顶层 bool；双格式反序列化兼容 bool|string）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SetModelApi {
    /// set_config_option("model")（Peri 官方路径；默认）。
    #[default]
    ConfigOption,
    /// session/set_model（Hermes unstable 扩展，官方 schema 1.4 无此类型）。
    SetModel,
    /// 禁用切 model（model 键路由返回 Disabled）。
    None,
}

impl SetModelApi {
    /// key=="model" 特判收敛于此（session.rs:1556 现状 bool 路由的声明式替代）：
    /// SetModel → model 键走 set_model；其余键一律 config_option；None → model 键禁用。
    /// G2（W2 链 E）消费：set_config_option 三路路由。
    pub fn route(self, key: &str) -> ModelSwitchTarget {
        match self {
            Self::SetModel if key == "model" => ModelSwitchTarget::SetModel,
            Self::None if key == "model" => ModelSwitchTarget::Disabled,
            _ => ModelSwitchTarget::ConfigOption,
        }
    }
}

/// D2 路由结果（G2 set_config_option 三路匹配消费；G1 链内无消费点，W2 移交）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSwitchTarget {
    ConfigOption,
    SetModel,
    Disabled,
}

/// D4 mcpServers 字段形态（07 文档 §8.2：v2 已改"空则省略"，与官方化方向对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum McpServersMode {
    /// 恒发 mcpServers 字段（现状 wire；Hermes 必填 List 兼容）。
    #[default]
    Always,
    /// 空数组时省略字段（v2 语义）。E4 警告：声明 omit_if_empty 且无配置时省字段
    /// ——Hermes（Pydantic 必填）会拒绝 session/new；配置与 agent 能力匹配是
    /// 用户责任，默认 Always = 现状 wire，安全。
    OmitIfEmpty,
}

/// H10/H11 附件限制值对象（prompt_blocks 参数化载体）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentLimits {
    pub max_attachments: usize,
    pub max_attachment_bytes: u64,
}

impl Default for AttachmentLimits {
    fn default() -> Self {
        Self {
            max_attachments: crate::acp::DEFAULT_MAX_ATTACHMENTS,
            max_attachment_bytes: crate::acp::DEFAULT_MAX_ATTACHMENT_BYTES,
        }
    }
}

impl AttachmentLimits {
    /// 从 AgentDef 的协议配置解析附件限制（缺省 = 现状常量值）。
    pub fn from_agent(agent: &AgentDef) -> Self {
        agent.protocol().attachment_limits()
    }
}

/// H8/H9 通用 RPC 超时默认值（秒；complete + session/load 回放共用，现值 30）。
pub const DEFAULT_RPC_TIMEOUT_SECS: u64 = 30;
/// H12 session/load 回放收集上限默认值（现值 10_000）。
pub const DEFAULT_REPLAY_MAX_EVENTS: usize = 10_000;
/// H3 initialize protocolVersion 默认值（schema 稳定值 1）。
pub const DEFAULT_PROTOCOL_VERSION: u16 = 1;

/// 空 acp 段的协议配置（[`AgentDef::protocol`] 的缺省值；全部默认 = 重构前现状行为）。
pub static DEFAULT_ACCPROTOCOL: AcpProtocolConfig = AcpProtocolConfig {
    set_model_api: Some(SetModelApi::ConfigOption),
    session_close: None,
    mcp_servers: McpServersMode::Always,
    initialize_caps: None,
    protocol_version: None,
    client_info: None,
    prompt_timeout_secs: None,
    cancel_settle_timeout_secs: None,
    idle_timeout_secs: None,
    first_token_timeout_secs: None,
    rpc_timeout_secs: None,
    max_attachments: None,
    max_attachment_bytes: None,
    replay_max_events: None,
};

impl AcpProtocolConfig {
    /// D2 已解析的切 model 途径：acp 段声明优先；未声明回退 ConfigOption
    /// （生产解析路径 parse() 已合并顶层 legacy bool，此兜底仅覆盖直构场景）。
    /// G2（W2 链 E）消费：`protocol().set_model_api().route(&key)`。
    pub fn set_model_api(&self) -> SetModelApi {
        self.set_model_api.unwrap_or(SetModelApi::ConfigOption)
    }

    /// D3 是否尝试 session/close RPC（false = 跳过 RPC 直接本地清理；缺省 true）。
    /// G2（W2 链 E）消费：close 四处消费点。
    pub fn close_via_rpc(&self) -> bool {
        self.session_close.unwrap_or(true)
    }

    /// H5 单步闲置超时缺省值（秒，缺省 300）。G2（W2 链 E）消费时作为
    /// `idle_timeout` 的回退值。
    pub fn prompt_timeout(&self) -> u64 {
        self.prompt_timeout_secs
            .unwrap_or(crate::acp::DEFAULT_PROMPT_TIMEOUT_SECS)
    }

    /// R-t5 闲置超时（秒，缺省 = prompt_timeout）。距最后一次活动超过此值仍无终态 → 判死。
    /// 活动即续命：持续产出的回合永不因"总时长"被截。
    pub fn idle_timeout(&self) -> u64 {
        self.idle_timeout_secs
            .unwrap_or_else(|| self.prompt_timeout())
    }

    /// R-t5 首 token 超时（秒，缺省 = idle_timeout）。发出后到首次活动的最长等待。
    pub fn first_token_timeout(&self) -> u64 {
        self.first_token_timeout_secs
            .unwrap_or_else(|| self.idle_timeout())
    }

    /// H6 cancel settle 超时（秒，缺省 30）。G2（W2 链 E）消费。
    pub fn cancel_settle_timeout(&self) -> u64 {
        self.cancel_settle_timeout_secs
            .unwrap_or(crate::acp::DEFAULT_CANCEL_SETTLE_TIMEOUT_SECS)
    }

    /// H8/H9 通用 RPC 超时（秒，缺省 30；complete + 回放共用）。
    pub fn rpc_timeout(&self) -> u64 {
        self.rpc_timeout_secs.unwrap_or(DEFAULT_RPC_TIMEOUT_SECS)
    }

    /// H10/H11 附件限制（缺省 8 / 10MB）。
    pub fn attachment_limits(&self) -> AttachmentLimits {
        AttachmentLimits {
            max_attachments: self
                .max_attachments
                .unwrap_or(crate::acp::DEFAULT_MAX_ATTACHMENTS),
            max_attachment_bytes: self
                .max_attachment_bytes
                .unwrap_or(crate::acp::DEFAULT_MAX_ATTACHMENT_BYTES),
        }
    }

    /// H12 session/load 回放收集上限（缺省 10_000）。
    pub fn replay_max(&self) -> usize {
        self.replay_max_events.unwrap_or(DEFAULT_REPLAY_MAX_EVENTS)
    }

    /// H3 initialize protocolVersion（缺省 1）。
    pub fn protocol_version(&self) -> u16 {
        self.protocol_version.unwrap_or(DEFAULT_PROTOCOL_VERSION)
    }

    /// H4 initialize clientInfo（缺省 Pylon 0.1.0）。
    pub fn client_info(&self) -> serde_json::Value {
        self.client_info.clone().unwrap_or_else(default_client_info)
    }

    /// D1 initialize clientCapabilities（缺省统一默认 caps，见 [`default_initialize_caps`]）。
    pub fn initialize_caps(&self) -> serde_json::Value {
        self.initialize_caps
            .clone()
            .unwrap_or_else(default_initialize_caps)
    }
}

/// D2 双格式反序列化：bool（true=set_model / false=config_option）或字符串
/// （"set_model"/"config_option"/"none"）。未知值拒绝（E1：报错指明字段与可选值；
/// agent id 上下文由 parse() 的逐 agent 反序列化包装补充）。
pub(crate) fn deserialize_set_model_api<'de, D>(deserializer: D) -> Result<Option<SetModelApi>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let value = serde_yml::Value::deserialize(deserializer)?;
    match value {
        serde_yml::Value::Bool(true) => Ok(Some(SetModelApi::SetModel)),
        serde_yml::Value::Bool(false) => Ok(Some(SetModelApi::ConfigOption)),
        serde_yml::Value::String(text) => match text.as_str() {
            "set_model" => Ok(Some(SetModelApi::SetModel)),
            "config_option" => Ok(Some(SetModelApi::ConfigOption)),
            "none" => Ok(Some(SetModelApi::None)),
            other => Err(D::Error::custom(format!(
                "unknown acp.set_model_api value: {other:?}（可选 set_model/config_option/none 或 true/false）"
            ))),
        },
        other => Err(D::Error::custom(format!(
            "invalid acp.set_model_api value: {other:?}（可选 set_model/config_option/none 或 true/false）"
        ))),
    }
}

/// D4 mcp_servers 字段形态反序列化：字符串 "always" | "omit_if_empty"。
pub(crate) fn deserialize_mcp_servers_mode<'de, D>(deserializer: D) -> Result<McpServersMode, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;
    let value = String::deserialize(deserializer)?;
    match value.as_str() {
        "always" => Ok(McpServersMode::Always),
        "omit_if_empty" => Ok(McpServersMode::OmitIfEmpty),
        other => Err(D::Error::custom(format!(
            "unknown acp.mcp_servers value: {other:?}（可选 always/omit_if_empty）"
        ))),
    }
}

/// D1 统一默认 clientCapabilities（现值：tokenStats + _meta.peri.*，Hermes 忽略无害；
/// `_meta.peri.*` 是 Peri wire 契约，不得从默认 caps 移除——07 文档 §4.3）。
pub(crate) fn default_initialize_caps() -> serde_json::Value {
    serde_json::json!({
        "tokenStats": true,
        "_meta": {
            "peri.tokenStats": true,
            "peri.skillNames": true,
            "peri.replay": true
        }
    })
}

/// H4 默认 clientInfo（现值 {"name":"Pylon","version":"0.1.0"}）。
pub(crate) fn default_client_info() -> serde_json::Value {
    serde_json::json!({"name": "Pylon", "version": "1.0.0"})
}

/// E1：acp 段取值校验——数值字段必须 > 0（负数在反序列化层已被 u64 拒绝，
/// 此处拦截 0 并指明 agent id；风格对齐 route.rs reset 校验）。
pub(crate) const MAX_PROMPT_TIMEOUT_SECS: u64 = 3600;
pub(crate) const MAX_CANCEL_SETTLE_TIMEOUT_SECS: u64 = 300;
pub(crate) const MAX_IDLE_TIMEOUT_SECS: u64 = 3600;
pub(crate) const MAX_FIRST_TOKEN_TIMEOUT_SECS: u64 = 3600;
pub(crate) const MAX_RPC_TIMEOUT_SECS: u64 = 300;
pub(crate) const MAX_ATTACHMENTS: usize = 64;
pub(crate) const MAX_ATTACHMENT_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_REPLAY_EVENTS: usize = 100_000;
pub(crate) const MAX_INITIALIZE_VALUE_BYTES: usize = 256 * 1024;
pub(crate) const WARN_PROMPT_TIMEOUT_SECS: u64 = 900;
pub(crate) const WARN_ATTACHMENT_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const WARN_REPLAY_EVENTS: usize = 50_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentConfigDiagnostic {
    pub agent_id: String,
    pub code: &'static str,
    pub field: &'static str,
    pub message: String,
}

pub(crate) fn config_diagnostics(agents: &HashMap<String, AgentDef>) -> Vec<AgentConfigDiagnostic> {
    let mut diagnostics = Vec::new();
    let mut ids = agents.keys().collect::<Vec<_>>();
    ids.sort();
    for id in ids {
        let protocol = agents[id].protocol();
        for (field, value, threshold) in [
            (
                "prompt_timeout_secs",
                protocol.prompt_timeout_secs.map(|value| value as u128),
                WARN_PROMPT_TIMEOUT_SECS as u128,
            ),
            (
                "max_attachment_bytes",
                protocol.max_attachment_bytes.map(|value| value as u128),
                WARN_ATTACHMENT_BYTES as u128,
            ),
            (
                "replay_max_events",
                protocol.replay_max_events.map(|value| value as u128),
                WARN_REPLAY_EVENTS as u128,
            ),
        ] {
            if value.is_some_and(|value| value > threshold) {
                diagnostics.push(AgentConfigDiagnostic {
                    agent_id: id.clone(),
                    code: "config_high_resource_limit",
                    field,
                    message: format!(
                        "agent {id} 的 acp.{field} 高于建议阈值 {threshold}；配置可保存，但可能降低稳定性"
                    ),
                });
            }
        }
    }
    diagnostics
}

pub(crate) fn validate_acp_section(id: &str, acp: &AcpProtocolConfig) -> Result<(), ConfigError> {
    for (field, value) in [
        ("initialize_caps", acp.initialize_caps.as_ref()),
        ("client_info", acp.client_info.as_ref()),
    ] {
        if let Some(value) = value {
            let size = serde_json::to_vec(value)
                .map_err(|error| {
                    ConfigError::InvalidAgent(format!(
                        "agent {id} 的 acp.{field} 无法序列化: {error}"
                    ))
                })?
                .len();
            if size > MAX_INITIALIZE_VALUE_BYTES {
                return Err(ConfigError::InvalidAgent(format!(
                    "agent {id} 的 acp.{field} 序列化后 {size} bytes，超过 hard max {MAX_INITIALIZE_VALUE_BYTES}"
                )));
            }
        }
    }
    let numeric = [
        (
            "prompt_timeout_secs",
            acp.prompt_timeout_secs.map(|v| v as u128),
        ),
        (
            "cancel_settle_timeout_secs",
            acp.cancel_settle_timeout_secs.map(|v| v as u128),
        ),
        (
            "idle_timeout_secs",
            acp.idle_timeout_secs.map(|v| v as u128),
        ),
        (
            "first_token_timeout_secs",
            acp.first_token_timeout_secs.map(|v| v as u128),
        ),
        ("rpc_timeout_secs", acp.rpc_timeout_secs.map(|v| v as u128)),
        ("max_attachments", acp.max_attachments.map(|v| v as u128)),
        (
            "max_attachment_bytes",
            acp.max_attachment_bytes.map(|v| v as u128),
        ),
        (
            "replay_max_events",
            acp.replay_max_events.map(|v| v as u128),
        ),
    ];
    let maxima: [(&str, u128); 8] = [
        ("prompt_timeout_secs", MAX_PROMPT_TIMEOUT_SECS as u128),
        (
            "cancel_settle_timeout_secs",
            MAX_CANCEL_SETTLE_TIMEOUT_SECS as u128,
        ),
        ("idle_timeout_secs", MAX_IDLE_TIMEOUT_SECS as u128),
        (
            "first_token_timeout_secs",
            MAX_FIRST_TOKEN_TIMEOUT_SECS as u128,
        ),
        ("rpc_timeout_secs", MAX_RPC_TIMEOUT_SECS as u128),
        ("max_attachments", MAX_ATTACHMENTS as u128),
        ("max_attachment_bytes", MAX_ATTACHMENT_BYTES as u128),
        ("replay_max_events", MAX_REPLAY_EVENTS as u128),
    ];
    for ((field, value), (_, maximum)) in numeric.into_iter().zip(maxima) {
        if let Some(value) = value {
            if value == 0 {
                return Err(ConfigError::InvalidAgent(format!(
                    "agent {id} 的 acp.{field} 非法: 0（必须大于 0）"
                )));
            }
            if value > maximum {
                return Err(ConfigError::InvalidAgent(format!(
                    "agent {id} 的 acp.{field} 超过 hard max {maximum}"
                )));
            }
        }
    }
    Ok(())
}

impl AgentDef {
    /// Stable hash of the effective process/protocol definition. Registry entries are already
    /// path-resolved by `parse_agents`; callers constructing definitions directly should resolve
    /// them first. Display-only fields (`name`, `default`) intentionally do not participate.
    pub fn runtime_fingerprint(&self) -> String {
        fn field(hasher: &mut Sha256, name: &str, value: &str) {
            hasher.update((name.len() as u64).to_le_bytes());
            hasher.update(name.as_bytes());
            hasher.update((value.len() as u64).to_le_bytes());
            hasher.update(value.as_bytes());
        }
        fn json(hasher: &mut Sha256, value: &serde_json::Value) {
            match value {
                serde_json::Value::Null => hasher.update(b"null"),
                serde_json::Value::Bool(value) => {
                    hasher.update(if *value { &b"true"[..] } else { &b"false"[..] })
                }
                serde_json::Value::Number(value) => field(hasher, "number", &value.to_string()),
                serde_json::Value::String(value) => field(hasher, "string", value),
                serde_json::Value::Array(values) => {
                    hasher.update(b"array");
                    hasher.update((values.len() as u64).to_le_bytes());
                    for value in values {
                        json(hasher, value);
                    }
                }
                serde_json::Value::Object(values) => {
                    hasher.update(b"object");
                    let mut keys = values.keys().collect::<Vec<_>>();
                    keys.sort();
                    for key in keys {
                        field(hasher, "key", key);
                        json(hasher, &values[key]);
                    }
                }
            }
        }

        let mut hasher = Sha256::new();
        field(&mut hasher, "transport", &self.transport);
        field(&mut hasher, "exe", &self.exe);
        field(&mut hasher, "cwd", self.cwd.as_deref().unwrap_or(""));
        for argument in self.command_args() {
            field(&mut hasher, "arg", &argument);
        }
        let mut environment = self.env.iter().collect::<Vec<_>>();
        environment.sort_by(|left, right| left.0.cmp(right.0));
        for (key, value) in environment {
            field(&mut hasher, "env-key", key);
            field(&mut hasher, "env-value", value);
        }
        field(
            &mut hasher,
            "hermes-profile",
            self.hermes_profile.as_deref().unwrap_or(""),
        );
        field(
            &mut hasher,
            "legacy-set-model-api",
            if self.set_model_api { "true" } else { "false" },
        );

        let protocol = self.protocol();
        field(
            &mut hasher,
            "set-model-api",
            match protocol.set_model_api() {
                SetModelApi::ConfigOption => "config-option",
                SetModelApi::SetModel => "set-model",
                SetModelApi::None => "none",
            },
        );
        field(
            &mut hasher,
            "session-close",
            if protocol.close_via_rpc() {
                "true"
            } else {
                "false"
            },
        );
        field(
            &mut hasher,
            "mcp-servers",
            match protocol.mcp_servers {
                McpServersMode::Always => "always",
                McpServersMode::OmitIfEmpty => "omit-if-empty",
            },
        );
        json(&mut hasher, &protocol.initialize_caps());
        field(
            &mut hasher,
            "protocol-version",
            &protocol.protocol_version().to_string(),
        );
        json(&mut hasher, &protocol.client_info());
        for (name, value) in [
            ("prompt-timeout", protocol.prompt_timeout()),
            ("cancel-settle-timeout", protocol.cancel_settle_timeout()),
            ("idle-timeout", protocol.idle_timeout()),
            ("first-token-timeout", protocol.first_token_timeout()),
            ("rpc-timeout", protocol.rpc_timeout()),
            (
                "max-attachments",
                protocol.attachment_limits().max_attachments as u64,
            ),
            (
                "max-attachment-bytes",
                protocol.attachment_limits().max_attachment_bytes,
            ),
            ("replay-max-events", protocol.replay_max() as u64),
        ] {
            field(&mut hasher, name, &value.to_string());
        }
        let digest = hasher.finalize();
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// 协议行为配置（acp 段缺省 = 默认实例 [`DEFAULT_ACCPROTOCOL`]）。
    /// 生产解析路径 parse() 已把顶层 legacy `set_model_api` 布尔合并进 acp 段
    /// （D2 兼容），此处只做缺省回退。
    pub fn protocol(&self) -> &AcpProtocolConfig {
        self.acp.as_ref().unwrap_or(&DEFAULT_ACCPROTOCOL)
    }

    /// 完整命令行参数：args（含入口子命令）→ `--model <value>`（可选）→ acp_args。
    /// args 与结构化字段并存时结构化参数在后（多数 CLI 后者覆盖前者）。
    pub fn command_args(&self) -> Vec<String> {
        let mut all = self.args.clone();
        if let Some(model) = &self.model {
            // P3：acp_args 已显式携带 --model 时不再追加结构化 --model——否则会
            // 出现两个 --model（依赖参数顺序的静默覆盖，脆弱）。选"跳过 + 警告"
            // 而非"忽略 acp_args"：acp_args 是 per-agent 显式覆盖通道，优先级更高。
            if self
                .acp_args
                .iter()
                .any(|arg| arg == "--model" || arg.starts_with("--model="))
            {
                tracing::warn!(
                    "agent {}: acp_args 含 --model，结构化 model 字段被忽略",
                    self.name
                );
            } else {
                all.push("--model".to_string());
                all.push(model.clone());
            }
        }
        all.extend(self.acp_args.iter().cloned());
        all
    }

    pub fn resolve_paths(&self, base_dir: &Path) -> Self {
        let mut resolved = self.clone();
        let exe = Path::new(&resolved.exe);
        if exe.components().count() > 1 && exe.is_relative() {
            resolved.exe = base_dir.join(exe).to_string_lossy().into_owned();
        }
        if let Some(cwd) = resolved.cwd.as_deref() {
            let cwd = Path::new(cwd);
            if cwd.is_relative() {
                resolved.cwd = Some(base_dir.join(cwd).to_string_lossy().into_owned());
            }
        }
        resolved
    }
}

/// O27：env/args 标量宽松化共用转换——String 原样、Number→to_string、Bool→to_string，
/// 其余（map/seq/null）拒绝。null 不在宽松范围内：显式 null 应视为配置错误。
/// R27b：serde_yaml → serde_yml（API 兼容，noyalib compat 面）。
pub(crate) fn scalar_to_string(value: serde_yml::Value) -> Option<String> {
    match value {
        serde_yml::Value::String(text) => Some(text),
        serde_yml::Value::Number(number) => Some(number.to_string()),
        serde_yml::Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// env 值反序列化：map 中每个值经 scalar_to_string 转字符串。
pub(crate) fn string_or_scalar<'de, D>(deserializer: D) -> Result<HashMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct ScalarStringMapVisitor;

    impl<'de> serde::de::Visitor<'de> for ScalarStringMapVisitor {
        type Value = HashMap<String, String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a map of string/number/bool values")
        }

        fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            let mut map = HashMap::with_capacity(access.size_hint().unwrap_or(0));
            while let Some(key) = access.next_key::<String>()? {
                let value = access.next_value::<serde_yml::Value>()?;
                let text = scalar_to_string(value).ok_or_else(|| {
                    serde::de::Error::custom(format!(
                        "agent env 值非法（key {key:?}）: expected string/number/bool"
                    ))
                })?;
                map.insert(key, text);
            }
            Ok(map)
        }
    }

    deserializer.deserialize_map(ScalarStringMapVisitor)
}

/// args 元素反序列化：序列中每个元素经 scalar_to_string 转字符串。
pub(crate) fn string_or_scalar_seq<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let values = Vec::<serde_yml::Value>::deserialize(deserializer)?;
    values
        .into_iter()
        .map(|value| {
            scalar_to_string(value).ok_or_else(|| {
                serde::de::Error::custom("agent args 元素非法: expected string/number/bool")
            })
        })
        .collect()
}

/// 实际生效的配置路径：优先 `PYLON_AGENTS_CONFIG`，其次 exe 同目录的
/// `agents.yaml`（发行包可热改），否则回退编译期嵌入（返回 None）。
///
/// 施工文档 §2.2：不再使用 `OnceLock` 缓存。旧实现若以 embedded 启动会永久
/// 缓存 `None`，导致 `initialize_agents_config` 在 exe 旁成功创建 `agents.yaml`
/// 后，同一进程的 `update_agents_config` 仍认为配置只读。改为每次调用重新
/// 解析，保证 embedded→external 在同一进程内可见（配置位置在无外部初始化时
/// 稳定；每次解析仅两次 stat，远低于连接/配置写盘成本）。
/// 配置文件精确字节 revision。只返回 SHA-256，不返回配置内容。
pub fn config_revision_for_bytes(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn config_revision_for_path(path: &Path) -> Result<String, ConfigError> {
    let bytes = std::fs::read(path)
        .map_err(|error| ConfigError::Read(format!("读取 {} 失败: {error}", path.display())))?;
    Ok(config_revision_for_bytes(&bytes))
}

