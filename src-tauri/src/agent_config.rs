use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

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
            Self::Backup(_) => "config_backup_error",
            Self::LockBusy(_) => "config_lock_busy",
            Self::ActiveAgentProtected(_) => "config_active_agent_protected",
            Self::NotApplied(_) => "config_not_applied",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct AgentConfigFile {
    /// E1：agents 先以宽松值解析，再在 parse() 内逐 agent 反序列化——
    /// 非法字段（负数值/未知枚举/类型错误）的报错带 agent id 上下文。
    agents: HashMap<String, serde_yml::Value>,
    /// 外置工具归一化字典（provider → tools）。缺省为空表，前端可继续使用内置 fallback。
    #[serde(default)]
    tool_dictionary: HashMap<String, Vec<ToolDictEntry>>,
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
    /// H5 prompt 超时（秒）；None = 300。
    #[serde(default)]
    pub prompt_timeout_secs: Option<u64>,
    /// H6 cancel settle 超时（秒）；None = 30。
    #[serde(default)]
    pub cancel_settle_timeout_secs: Option<u64>,
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

    /// H5 prompt 超时（秒，缺省 300）。G2（W2 链 E）消费：wait_prompt_with_cancel。
    pub fn prompt_timeout(&self) -> u64 {
        self.prompt_timeout_secs
            .unwrap_or(crate::acp::DEFAULT_PROMPT_TIMEOUT_SECS)
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
fn deserialize_set_model_api<'de, D>(deserializer: D) -> Result<Option<SetModelApi>, D::Error>
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
fn deserialize_mcp_servers_mode<'de, D>(deserializer: D) -> Result<McpServersMode, D::Error>
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
const MAX_PROMPT_TIMEOUT_SECS: u64 = 3600;
const MAX_CANCEL_SETTLE_TIMEOUT_SECS: u64 = 300;
const MAX_RPC_TIMEOUT_SECS: u64 = 300;
const MAX_ATTACHMENTS: usize = 64;
const MAX_ATTACHMENT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_REPLAY_EVENTS: usize = 100_000;

fn validate_acp_section(id: &str, acp: &AcpProtocolConfig) -> Result<(), ConfigError> {
    let numeric = [
        (
            "prompt_timeout_secs",
            acp.prompt_timeout_secs.map(|v| v as u128),
        ),
        (
            "cancel_settle_timeout_secs",
            acp.cancel_settle_timeout_secs.map(|v| v as u128),
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
    let maxima: [(&str, u128); 6] = [
        ("prompt_timeout_secs", MAX_PROMPT_TIMEOUT_SECS as u128),
        ("cancel_settle_timeout_secs", MAX_CANCEL_SETTLE_TIMEOUT_SECS as u128),
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

fn config_path() -> Option<PathBuf> {
    std::env::var_os("PYLON_AGENTS_CONFIG").map(PathBuf::from)
}

/// O27：env/args 标量宽松化共用转换——String 原样、Number→to_string、Bool→to_string，
/// 其余（map/seq/null）拒绝。null 不在宽松范围内：显式 null 应视为配置错误。
/// R27b：serde_yaml → serde_yml（API 兼容，noyalib compat 面）。
fn scalar_to_string(value: serde_yml::Value) -> Option<String> {
    match value {
        serde_yml::Value::String(text) => Some(text),
        serde_yml::Value::Number(number) => Some(number.to_string()),
        serde_yml::Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// env 值反序列化：map 中每个值经 scalar_to_string 转字符串。
fn string_or_scalar<'de, D>(deserializer: D) -> Result<HashMap<String, String>, D::Error>
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
fn string_or_scalar_seq<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
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
    let bytes = std::fs::read(path).map_err(|error| {
        ConfigError::Read(format!("读取 {} 失败: {error}", path.display()))
    })?;
    Ok(config_revision_for_bytes(&bytes))
}

struct ConfigLease {
    path: PathBuf,
}

impl ConfigLease {
    fn acquire(config_path: &Path) -> Result<Self, ConfigError> {
        let lease_path = config_path.with_file_name(format!(
            "{}.pylon.lock",
            config_path.file_name().and_then(|name| name.to_str()).unwrap_or("agents.yaml"),
        ));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lease_path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    ConfigError::LockBusy(lease_path.display().to_string())
                } else {
                    ConfigError::Write(format!("创建配置 lease {} 失败: {error}", lease_path.display()))
                }
            })?;
        Ok(Self { path: lease_path })
    }
}

impl Drop for ConfigLease {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub fn write_config_transaction(
    path: &Path,
    expected: &str,
    candidate: &[u8],
) -> Result<String, ConfigError> {
    let _lease = ConfigLease::acquire(path)?;
    let current = std::fs::read(path).map_err(|error| {
        ConfigError::Read(format!("读取 {} 失败: {error}", path.display()))
    })?;
    let actual = config_revision_for_bytes(&current);
    if actual != expected {
        return Err(ConfigError::Conflict {
            expected: expected.to_string(),
            actual,
        });
    }
    let dir = path.parent().ok_or_else(|| ConfigError::Write(format!("{} 无父目录", path.display())))?;
    let file_name = path.file_name().ok_or_else(|| ConfigError::Write(format!("{} 无文件名", path.display())))?;
    let pid = std::process::id();
    let temp = dir.join(format!(".{}.tmp-{pid}", file_name.to_string_lossy()));
    let backup_temp = dir.join(format!(".{}.bak-tmp-{pid}", file_name.to_string_lossy()));
    let backup = dir.join(format!("{}.bak", file_name.to_string_lossy()));
    let result = (|| -> std::io::Result<()> {
        let mut backup_file = std::fs::File::create(&backup_temp)?;
        backup_file.write_all(&current)?;
        backup_file.sync_all()?;
        drop(backup_file);
        if backup.exists() {
            std::fs::remove_file(&backup)?;
        }
        std::fs::rename(&backup_temp, &backup)?;
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(candidate)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        let _ = std::fs::remove_file(&backup_temp);
        return Err(ConfigError::Backup(format!("写入 {} 失败: {error}", backup.display())));
    }
    Ok(config_revision_for_bytes(candidate))
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

pub fn load() -> Result<HashMap<String, AgentDef>, ConfigError> {
    // R1/R2：与 Gateway 共享同一读取入口（read_config_document 单次读文本），
    // 外部配置经 base_dir 绝对化相对 exe/cwd，embedded 不做路径解析（语义同旧实现）。
    match read_config_document() {
        Ok(doc) => parse_agents(&doc.content, doc.base_dir.as_deref()),
        Err(error) => Err(error),
    }
}

/// 读取外置工具归一化字典（`tool_dictionary` 段）。与 `load()` 共用同一配置源；
/// 解析失败返回 ConfigError，调用方决定是否降级为前端内置 fallback。
pub fn load_tool_dictionary() -> Result<HashMap<String, Vec<ToolDictEntry>>, ConfigError> {
    let doc = read_config_document()?;
    let config: AgentConfigFile = serde_yml::from_str(&doc.content)
        .map_err(|error| ConfigError::Parse(format!("failed to parse agents.yaml: {error}")))?;
    Ok(config.tool_dictionary)
}

/// 网关配置读取统一入口（R35）：effective_config_path 优先读文件，无路径时回退
/// 编译期嵌入（include_str）。reload 路径的异步读（tokio::fs）在 gateway_cmds 内
/// 实现，本入口承载"路径选择 + 兜底"语义供复用。
pub fn load_gateway_config() -> Result<String, ConfigError> {
    // R1：共享 read_config_document（单次读文本），语义与旧实现一致。
    read_config_document().map(|doc| doc.content)
}

// ── R1/R2：启动配置统一装载（分域部分成功，P1-1）──

/// 启动配置来源（R1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigSource {
    /// `PYLON_AGENTS_CONFIG` 环境变量指定。
    Environment(PathBuf),
    /// exe 同目录的 `agents.yaml`。
    ExecutableDirectory(PathBuf),
    /// 编译期嵌入配置（无外部文件）。
    Embedded,
}

impl ConfigSource {
    /// 来源类型标识（startup diagnostics 用）。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Environment(_) => "environment",
            Self::ExecutableDirectory(_) => "executable_directory",
            Self::Embedded => "embedded",
        }
    }

    /// 配置文件名（embedded 无真实路径，返回 "agents.yaml"）。
    pub fn file_name(&self) -> Option<String> {
        match self {
            Self::Environment(path) | Self::ExecutableDirectory(path) => path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            Self::Embedded => Some("agents.yaml".to_string()),
        }
    }
}

/// R1：一次读取到的原始配置文档（路径解析 + 文本读取各一次）。
pub struct ConfigDocument {
    pub source: ConfigSource,
    /// 外部配置的 base_dir（相对 exe/cwd 解析基准 = 配置文件父目录）；Embedded 为 None。
    pub base_dir: Option<PathBuf>,
    pub content: String,
}

/// R1：解析配置来源并单次读取文本。仅"读取失败"返回 Err——调用方把该错误并入
/// 两个域（agents/gateway 同时失败），应用仍可 degraded 启动。
pub fn read_config_document() -> Result<ConfigDocument, ConfigError> {
    let (source, base_dir) = resolve_config_source();
    let content = match &source {
        ConfigSource::Embedded => include_str!("../../agents.yaml").to_string(),
        ConfigSource::Environment(path) | ConfigSource::ExecutableDirectory(path) => {
            std::fs::read_to_string(path).map_err(|error| {
                ConfigError::Read(format!("读取 {} 失败: {error}", path.display()))
            })?
        }
    };
    Ok(ConfigDocument {
        source,
        base_dir,
        content,
    })
}

/// R2：启动配置分域装载结果——Agent 与 Gateway 独立解析，允许部分成功。
pub struct LoadedAppConfig {
    pub source: ConfigSource,
    pub agents: Result<HashMap<String, AgentDef>, ConfigError>,
    pub gateway: Result<crate::gateway::route::GatewayConfig, ConfigError>,
}

/// R2：启动配置装载——同一份 YAML 文本分域解析（P1-1 不变量：同一轮启动的
/// Agent 与 Gateway 基于同一份文本，而非必须同时成功）。无顶层 Result：
/// 文件读取失败也进入两个域的 Err（degraded 启动，可恢复）。
pub fn load_app_config() -> LoadedAppConfig {
    match read_config_document() {
        Ok(doc) => {
            let (agents, gateway) = parse_domains(&doc.content, doc.base_dir.as_deref());
            LoadedAppConfig {
                source: doc.source,
                agents,
                gateway,
            }
        }
        Err(error) => {
            let (source, _) = resolve_config_source();
            let message = format!("配置读取失败: {error}");
            LoadedAppConfig {
                source,
                agents: Err(ConfigError::Read(message.clone())),
                gateway: Err(ConfigError::Read(message)),
            }
        }
    }
}

/// 分域解析（纯函数）：agents 语义错误不影响 gateway 解析结果，反之亦然。
fn parse_domains(
    content: &str,
    base_dir: Option<&Path>,
) -> (
    Result<HashMap<String, AgentDef>, ConfigError>,
    Result<crate::gateway::route::GatewayConfig, ConfigError>,
) {
    (
        parse_agents(content, base_dir),
        crate::gateway::route::GatewayConfig::from_yaml_str(content).map_err(ConfigError::Invalid),
    )
}

/// 分域解析 agents（外部配置对相对 exe/cwd 做 base_dir 绝对化；embedded 不解析）。
fn parse_agents(
    content: &str,
    base_dir: Option<&Path>,
) -> Result<HashMap<String, AgentDef>, ConfigError> {
    let agents = parse(content)?;
    match base_dir {
        Some(dir) => Ok(agents
            .into_iter()
            .map(|(id, agent)| (id, agent.resolve_paths(dir)))
            .collect()),
        None => Ok(agents),
    }
}

/// 解析配置来源：PYLON_AGENTS_CONFIG → exe 旁 agents.yaml → Embedded。
fn resolve_config_source() -> (ConfigSource, Option<PathBuf>) {
    match effective_config_path() {
        Some(path) => {
            let base_dir = path.parent().map(Path::to_path_buf);
            let source = if std::env::var_os("PYLON_AGENTS_CONFIG").is_some() {
                ConfigSource::Environment(path)
            } else {
                ConfigSource::ExecutableDirectory(path)
            };
            (source, base_dir)
        }
        None => (ConfigSource::Embedded, None),
    }
}

/// P0-1（交接 §5.4 方案 1）：配置加载时按协议依据补全 provider。
/// 优先级：声明值（trim+lowercase 归一）→ `hermes_profile` 存在（Hermes 专属字段，
/// 强信号）→ exe 文件名去扩展名小写命中已知 provider 可执行名（可执行程序类型）
/// → 无信号保持 None（显式降级 invalid-instance，绝不按 agentId 名称猜）。
fn resolve_provider(agent: &AgentDef) -> Result<Option<String>, ConfigError> {
    if let Some(declared) = agent.provider.as_deref() {
        let normalized = declared.trim().to_lowercase();
        if !normalized.is_empty() {
            return Ok(Some(normalized));
        }
    }
    if agent.hermes_profile.is_some() {
        return Ok(Some("hermes".to_string()));
    }
    let stem = std::path::Path::new(&agent.exe)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.trim().to_lowercase())
        .filter(|stem| !stem.is_empty());
    stem.map(|stem| {
        crate::agent_catalog::provider_for_executable_stem(&stem).map_err(ConfigError::Invalid)
    })
    .transpose()
    .map(Option::flatten)
}

fn catalog_set_model_api(provider: Option<&str>) -> Result<SetModelApi, ConfigError> {
    use crate::agent_catalog::CatalogSetModelApi;
    let Some(provider) = provider else {
        return Ok(SetModelApi::ConfigOption);
    };
    Ok(
        match crate::agent_catalog::set_model_api_default(provider).map_err(ConfigError::Invalid)? {
            Some(CatalogSetModelApi::SetModel) => SetModelApi::SetModel,
            Some(CatalogSetModelApi::None) => SetModelApi::None,
            Some(CatalogSetModelApi::ConfigOption) | None => SetModelApi::ConfigOption,
        },
    )
}

fn parse(content: &str) -> Result<HashMap<String, AgentDef>, ConfigError> {
    // R27b：serde_yaml → serde_yml（API 兼容：serde_yml::from_str）。
    // 自定义错误前缀 "failed to parse agents.yaml" 保持（不依赖上游错误文案）。
    // E1：agents 先以宽松值解析再逐 agent 反序列化——非法字段（负数值/未知枚举/
    // 类型错误）的报错带 agent id 上下文（风格对齐 route.rs reset 校验）。
    let config: AgentConfigFile = serde_yml::from_str(content)
        .map_err(|error| ConfigError::Parse(format!("failed to parse agents.yaml: {error}")))?;
    if config.agents.is_empty() {
        return Err(ConfigError::Invalid(
            "agents.yaml contains no agents".to_string(),
        ));
    }
    let mut agents = HashMap::with_capacity(config.agents.len());
    for (id, raw) in config.agents {
        if id.trim().is_empty() {
            return Err(ConfigError::Invalid(
                "agents.yaml contains an agent with an empty id".to_string(),
            ));
        }
        let legacy_set_model_api_declared = raw
            .as_mapping()
            .map(|mapping| mapping.contains_key("set_model_api"))
            .unwrap_or(false);
        let mut agent: AgentDef = serde_yml::from_value(raw)
            .map_err(|error| ConfigError::InvalidAgent(format!("agent {id} 配置非法: {error}")))?;
        // Agent Catalog baseline < top-level legacy field < explicit acp field.
        // The raw mapping is inspected because bool's serde default cannot
        // distinguish an absent key from an explicit false override.
        agent.provider = resolve_provider(&agent)?;
        let catalog_default = catalog_set_model_api(agent.provider.as_deref())?;
        match agent.acp.as_mut() {
            Some(acp) if acp.set_model_api.is_none() => {
                acp.set_model_api = Some(if legacy_set_model_api_declared {
                    if agent.set_model_api {
                        SetModelApi::SetModel
                    } else {
                        SetModelApi::ConfigOption
                    }
                } else {
                    catalog_default
                });
            }
            None if legacy_set_model_api_declared
                || catalog_default != SetModelApi::ConfigOption =>
            {
                agent.acp = Some(AcpProtocolConfig {
                    set_model_api: Some(if legacy_set_model_api_declared {
                        if agent.set_model_api {
                            SetModelApi::SetModel
                        } else {
                            SetModelApi::ConfigOption
                        }
                    } else {
                        catalog_default
                    }),
                    ..Default::default()
                });
            }
            _ => {}
        }
        if agent.name.trim().is_empty() {
            return Err(ConfigError::InvalidAgent(format!(
                "agent {id} has an empty name"
            )));
        }
        if agent.exe.trim().is_empty() {
            return Err(ConfigError::InvalidAgent(format!(
                "agent {id} has an empty executable"
            )));
        }
        if agent.transport != "subprocess" {
            return Err(ConfigError::InvalidAgent(format!(
                "agent {id} uses unsupported transport: {}",
                agent.transport
            )));
        }
        // A11：env 键/值未校验时 `cmd.env(k, v)` 会 panic（含 '=' 或 NUL 的键、
        // NUL 值均触发）——非法配置从启动 panic 变为启动报错降级。
        for (key, value) in &agent.env {
            if key.is_empty() {
                return Err(ConfigError::InvalidAgent(format!(
                    "agent {id} has invalid env entry: empty key"
                )));
            }
            if key.contains('=') {
                return Err(ConfigError::InvalidAgent(format!(
                    "agent {id} has invalid env entry: key contains '=': {key:?}"
                )));
            }
            if key.contains('\0') || value.contains('\0') {
                return Err(ConfigError::InvalidAgent(format!(
                    "agent {id} has invalid env entry: NUL byte in key or value: {key:?}"
                )));
            }
        }
        if let Some(acp) = &agent.acp {
            validate_acp_section(&id, acp)?;
        }
        agents.insert(id, agent);
    }
    Ok(agents)
}

pub fn load_from_path(path: &Path) -> Result<HashMap<String, AgentDef>, ConfigError> {
    let content = std::fs::read_to_string(path).map_err(|error| {
        ConfigError::Read(format!(
            "read agent config {} failed: {error}",
            path.display()
        ))
    })?;
    let agents = parse(&content)?;
    // A11：相对 exe/cwd 以配置所在目录为基准绝对化（否则相对路径随进程 cwd 变化，
    // 落库/回放错位）。connect_with_logs 的临时 resolve 保留（幂等，双保险）。
    let base_dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    Ok(agents
        .into_iter()
        .map(|(id, agent)| (id, agent.resolve_paths(base_dir)))
        .collect())
}

// ── Phase 3：配置写入纯函数层（后端施工计划书 §5.3.A；command/事务层待 scope 契约拍板）──

/// 解析整份配置文档为可编辑 Value。YAML round-trip 会丢注释/缩进/键序——
/// 这是产品层明确接受的代价（§5.3.A），不默认引入 CST 保留方案。
pub(crate) fn parse_config_document(content: &str) -> Result<serde_yml::Value, ConfigError> {
    serde_yml::from_str::<serde_yml::Value>(content)
        .map_err(|error| ConfigError::Parse(format!("failed to parse agents.yaml: {error}")))
}

/// 应用 agent 补丁（§5.3.A）：patch 为 agent 整块 YAML 字符串（前端 AgentConfigEditor
/// 形态）；仅替换目标 agent，默认禁止创建不存在 agent（产品拍板项，默认禁止）。
pub(crate) fn apply_agent_patch(
    content: &str,
    agent_id: &str,
    patch_yaml: &str,
) -> Result<String, ConfigError> {
    let mut document = parse_config_document(content)?;
    let agents = document
        .get_mut("agents")
        .and_then(|value| value.as_mapping_mut())
        .ok_or_else(|| ConfigError::Invalid("配置缺少 agents 段".to_string()))?;
    let key = agent_id.to_string();
    if !agents.contains_key(&key) {
        return Err(ConfigError::Invalid(format!(
            "agent {agent_id} 不存在（默认禁止创建，待拍板）"
        )));
    }
    let patch_value: serde_yml::Value = serde_yml::from_str(patch_yaml)
        .map_err(|error| ConfigError::Parse(format!("agent {agent_id} 补丁 YAML 非法: {error}")))?;
    agents.insert(key, patch_value);
    serde_yml::to_string(&document)
        .map_err(|error| ConfigError::Invalid(format!("配置序列化失败: {error}")))
}

/// 施工文档 §4.3.1：结构化字段 patch（scope="agent_fields"）。
/// patch 为前端 JSON 对象 `{ exe?, default?, name?, provider?, transport?, args? }`；
/// 只允许白名单字段，避免前端 DTO 不完整时丢失高级字段（acp/model/env 等保持原值）。
/// `default: true` 在同一候选内互斥更新：其他 agent 全部置 false，目标置 true。
pub(crate) fn apply_agent_field_patch(
    content: &str,
    agent_id: &str,
    patch: &serde_json::Value,
) -> Result<String, ConfigError> {
    let patch = patch.as_object().ok_or_else(|| {
        ConfigError::Invalid("scope=agent_fields 的 config 必须为 JSON 对象".to_string())
    })?;
    if patch.is_empty() {
        return Err(ConfigError::Invalid(
            "agent_fields 补丁不能为空".to_string(),
        ));
    }
    let mut unknown = patch
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "exe" | "default" | "name" | "provider" | "transport" | "args"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    unknown.sort();
    if !unknown.is_empty() {
        return Err(ConfigError::Invalid(format!(
            "agent_fields 不支持字段: {}",
            unknown.join(", ")
        )));
    }

    let mut document = parse_config_document(content)?;
    let agents = document
        .get_mut("agents")
        .and_then(|value| value.as_mapping_mut())
        .ok_or_else(|| ConfigError::Invalid("配置缺少 agents 段".to_string()))?;
    let key = agent_id.to_string();
    if !agents.contains_key(&key) {
        return Err(ConfigError::Invalid(format!(
            "agent {agent_id} 不存在（字段 patch 只更新已有 agent）"
        )));
    }

    // default=true 互斥更新：先清掉所有其他 agent 的 default，再按 patch 写入目标。
    if patch.get("default").and_then(|value| value.as_bool()) == Some(true) {
        for (other_id, value) in agents.iter_mut() {
            if other_id != &key {
                if let Some(mapping) = value.as_mapping_mut() {
                    mapping.insert("default".to_string(), serde_yml::Value::Bool(false));
                }
            }
        }
    }

    let target = agents
        .get_mut(&key)
        .and_then(|value| value.as_mapping_mut())
        .ok_or_else(|| ConfigError::Invalid(format!("agent {agent_id} 不是 mapping")))?;

    for (field, value) in patch {
        match field.as_str() {
            "exe" => {
                let text = value.as_str().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.exe 必须为字符串".to_string())
                })?;
                if text.trim().is_empty() {
                    return Err(ConfigError::Invalid(
                        "agent_fields.exe 不能为空".to_string(),
                    ));
                }
                target.insert(
                    "exe".to_string(),
                    serde_yml::Value::String(text.to_string()),
                );
            }
            "name" => {
                let text = value.as_str().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.name 必须为字符串".to_string())
                })?;
                if text.trim().is_empty() {
                    return Err(ConfigError::Invalid(
                        "agent_fields.name 不能为空".to_string(),
                    ));
                }
                target.insert(
                    "name".to_string(),
                    serde_yml::Value::String(text.to_string()),
                );
            }
            "transport" => {
                let text = value.as_str().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.transport 必须为字符串".to_string())
                })?;
                if text != "subprocess" {
                    return Err(ConfigError::Invalid(
                        "agent_fields.transport 只允许 subprocess".to_string(),
                    ));
                }
                target.insert(
                    "transport".to_string(),
                    serde_yml::Value::String(text.to_string()),
                );
            }
            "provider" => match value {
                serde_json::Value::Null => {
                    target.remove("provider");
                }
                serde_json::Value::String(text) if !text.trim().is_empty() => {
                    target.insert(
                        "provider".to_string(),
                        serde_yml::Value::String(text.trim().to_lowercase()),
                    );
                }
                _ => {
                    return Err(ConfigError::Invalid(
                        "agent_fields.provider 必须为字符串或 null".to_string(),
                    ))
                }
            },
            "default" => {
                let flag = value.as_bool().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.default 必须为 bool".to_string())
                })?;
                target.insert("default".to_string(), serde_yml::Value::Bool(flag));
            }
            "args" => {
                let args = value.as_array().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.args 必须为字符串数组".to_string())
                })?;
                let mut out = Vec::with_capacity(args.len());
                for item in args {
                    let text = item.as_str().ok_or_else(|| {
                        ConfigError::Invalid("agent_fields.args 必须为字符串数组".to_string())
                    })?;
                    out.push(serde_yml::Value::String(text.to_string()));
                }
                target.insert("args".to_string(), serde_yml::Value::Sequence(out));
            }
            other => {
                return Err(ConfigError::Invalid(format!(
                    "agent_fields 不支持字段: {other}"
                )))
            }
        }
    }

    serde_yml::to_string(&document)
        .map_err(|error| ConfigError::Invalid(format!("配置序列化失败: {error}")))
}

/// 新建 Agent（scope="agent_create"）。
/// `agent_config` 是单 Agent 的结构化 JSON node；完整 `{ agents: ... }` document
/// 只允许用于 initialize_agents_config，避免前后端 wire 语义混用产生嵌套配置。
pub(crate) fn apply_agent_create(
    content: &str,
    agent_id: &str,
    agent_config: &serde_json::Value,
) -> Result<String, ConfigError> {
    validate_agent_id(agent_id)?;
    let config_object = agent_config.as_object().ok_or_else(|| {
        ConfigError::Invalid(format!("agent {agent_id} 配置必须为结构化 object"))
    })?;
    if config_object.contains_key("agents") {
        return Err(ConfigError::Invalid(format!(
            "agent {agent_id} 配置必须是单 Agent node，不能包含顶层 agents"
        )));
    }
    let mut document = parse_config_document(content)?;
    let agents = document
        .get_mut("agents")
        .and_then(|value| value.as_mapping_mut())
        .ok_or_else(|| ConfigError::Invalid("配置缺少 agents 段".to_string()))?;
    let key = agent_id.to_string();
    if agents.contains_key(&key) {
        return Err(ConfigError::Invalid(format!(
            "agent {agent_id} 已存在（新建不可覆盖）"
        )));
    }
    let patch_value = serde_yml::to_value(agent_config).map_err(|error| {
        ConfigError::Invalid(format!("agent {agent_id} 结构化配置转换失败: {error}"))
    })?;
    agents.insert(key, patch_value);
    serde_yml::to_string(&document)
        .map_err(|error| ConfigError::Invalid(format!("配置序列化失败: {error}")))
}

/// 将结构化的完整 `{ agents: ... }` document 序列化为配置文件内容。
/// 与 `apply_agent_create` 的单 Agent node interface 分离，避免 wire shape 混用。
pub(crate) fn serialize_agents_document(
    document: &serde_json::Value,
) -> Result<String, ConfigError> {
    let agents = document
        .get("agents")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            ConfigError::Invalid(
                "结构化 agents document 必须包含 object 类型的 agents 段".to_string(),
            )
        })?;
    if agents.is_empty() {
        return Err(ConfigError::Invalid(
            "结构化 agents document 的 agents 段不能为空".to_string(),
        ));
    }
    serde_yml::to_string(document)
        .map_err(|error| ConfigError::Invalid(format!("结构化 agents document 序列化失败: {error}")))
}

/// 施工文档 §4.3.2：新建 Agent 的 id 字符规则。
pub(crate) fn validate_agent_id(agent_id: &str) -> Result<(), ConfigError> {
    let mut chars = agent_id.chars();
    let first_valid = chars
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false);
    let rest_valid = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !first_valid || !rest_valid || agent_id.is_empty() {
        return Err(ConfigError::Invalid(format!(
            "agent id {agent_id:?} 非法（须匹配 ^[a-zA-Z0-9][a-zA-Z0-9._-]*$）"
        )));
    }
    Ok(())
}

/// 应用 gateway 补丁（§5.3.A）：patch 为前端 JSON `{ gateway: { routes: [...] } }`；
/// 只允许 routes 键整段替换（显式 patch，不做不透明深 merge，保留 qq/inject 段）。
pub(crate) fn apply_gateway_patch(
    content: &str,
    patch: &serde_json::Value,
) -> Result<String, ConfigError> {
    let gateway = patch
        .get("gateway")
        .ok_or_else(|| ConfigError::Invalid("补丁缺少 gateway 段".to_string()))?;
    let routes = gateway
        .get("routes")
        .ok_or_else(|| ConfigError::Invalid("gateway 补丁缺少 routes".to_string()))?;
    let extra_keys = gateway
        .as_object()
        .map(|object| object.keys().filter(|key| *key != "routes").count())
        .unwrap_or(0);
    if extra_keys > 0 {
        return Err(ConfigError::Invalid(
            "gateway 补丁只允许 routes 键（防隐式深 merge）".to_string(),
        ));
    }
    // JSON → YAML Value：JSON 是合法 YAML 子集，经字符串往返转换。
    let routes_yaml: serde_yml::Value = serde_yml::from_str(
        &serde_json::to_string(routes)
            .map_err(|error| ConfigError::Invalid(format!("routes 序列化失败: {error}")))?,
    )
    .map_err(|error| ConfigError::Parse(format!("gateway routes 非法: {error}")))?;
    let mut document = parse_config_document(content)?;
    let mapping = document
        .as_mapping_mut()
        .ok_or_else(|| ConfigError::Invalid("配置顶层必须为 mapping".to_string()))?;
    let gateway_key = "gateway".to_string();
    if !mapping.contains_key(&gateway_key) {
        mapping.insert(
            gateway_key.clone(),
            serde_yml::Value::Mapping(serde_yml::Mapping::new()),
        );
    }
    let gateway_node = mapping
        .get_mut(&gateway_key)
        .ok_or_else(|| ConfigError::Invalid("gateway 段不可变".to_string()))?;
    let gateway_map = gateway_node
        .as_mapping_mut()
        .ok_or_else(|| ConfigError::Invalid("gateway 段非法".to_string()))?;
    gateway_map.insert("routes".to_string(), routes_yaml);
    serde_yml::to_string(&document)
        .map_err(|error| ConfigError::Invalid(format!("配置序列化失败: {error}")))
}

/// 候选配置双域校验（§5.3.A）：agents 经 parse_agents（A11 env/NUL、transport、
/// 空 name/exe 等），gateway 经 GatewayConfig::from_yaml_str；任一侧失败即 Err。
/// 返回解析后的 agents 表（写盘前 active agent 保护检查复用，避免二次解析）。
pub(crate) fn validate_candidate(
    content: &str,
    base_dir: Option<&Path>,
) -> Result<HashMap<String, AgentDef>, ConfigError> {
    let (agents, gateway) = parse_domains(content, base_dir);
    let agents = agents?;
    gateway?;
    Ok(agents)
}

/// 原子写入（§5.3.A）：唯一临时文件 + 写全 + sync_all + rename 覆盖；失败清理
/// 临时文件。与 export::write_export_atomically 的 create_new（拒绝覆盖）语义
/// 不同——本函数是替换目标语义。Windows rename 覆盖/目标占用返回明确错误。
pub(crate) fn write_config_atomically(path: &Path, content: &str) -> Result<(), ConfigError> {
    let dir = path
        .parent()
        .ok_or_else(|| ConfigError::Write(format!("{} 无父目录", path.display())))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| ConfigError::Write(format!("{} 无文件名", path.display())))?;
    let temp = dir.join(format!(
        ".{}.tmp-{}",
        file_name.to_string_lossy(),
        std::process::id()
    ));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp);
        return Err(ConfigError::Write(format!(
            "写配置 {} 失败: {error}",
            path.display()
        )));
    }
    Ok(())
}

pub fn default_agent_id(agents: &HashMap<String, AgentDef>) -> Result<Option<String>, ConfigError> {
    let mut defaults: Vec<&String> = agents
        .iter()
        .filter(|(_, agent)| agent.default)
        .map(|(id, _)| id)
        .collect();
    if defaults.len() > 1 {
        defaults.sort();
        return Err(ConfigError::Invalid(format!(
            "multiple default agents configured: {}",
            defaults
                .iter()
                .map(|id| id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    if let Some(id) = defaults.pop() {
        return Ok(Some(id.clone()));
    }
    Ok(agents.keys().min().cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(default: bool) -> AgentDef {
        AgentDef {
            name: "test".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: "missing-agent".to_string(),
            args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            default,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        }
    }

    #[test]
    fn empty_registry_has_no_default_agent() {
        assert_eq!(default_agent_id(&HashMap::new()).unwrap(), None);
    }

    #[test]
    fn explicit_default_agent_wins() {
        let mut agents = HashMap::new();
        agents.insert("fallback".to_string(), agent(false));
        agents.insert("primary".to_string(), agent(true));
        assert_eq!(
            default_agent_id(&agents).unwrap(),
            Some("primary".to_string())
        );
    }

    #[test]
    fn multiple_default_agents_are_rejected() {
        let mut agents = HashMap::new();
        agents.insert("a".to_string(), agent(true));
        agents.insert("b".to_string(), agent(true));
        let error = default_agent_id(&agents).expect_err("multiple defaults must fail");
        assert!(error.to_string().contains("a, b"));
    }

    #[test]
    fn fallback_agent_id_is_deterministic() {
        let mut agents = HashMap::new();
        agents.insert("zeta".to_string(), agent(false));
        agents.insert("alpha".to_string(), agent(false));
        assert_eq!(
            default_agent_id(&agents).unwrap(),
            Some("alpha".to_string())
        );
    }

    #[test]
    fn load_from_path_reads_runtime_changes() {
        let path = std::env::temp_dir().join(format!("pylon-agents-{}.yaml", std::process::id()));
        std::fs::write(&path, "agents:\n  runtime:\n    name: Runtime\n    transport: subprocess\n    exe: runtime-agent\n")
            .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert!(agents.contains_key("runtime"));
    }

    #[test]
    fn rejects_agent_env_with_empty_key() {
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    env:\n      \"\": \"value\"\n",
        )
        .expect_err("empty env key must be rejected");
        assert!(error
            .to_string()
            .contains("agent bad has invalid env entry"));
    }

    #[test]
    fn rejects_agent_env_key_containing_equals() {
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    env:\n      \"a=b\": \"value\"\n",
        )
        .expect_err("env key containing '=' must be rejected");
        assert!(error
            .to_string()
            .contains("agent bad has invalid env entry"));
    }

    #[test]
    fn parses_numeric_env_values_as_strings() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-envnum-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  runtime:\n    name: Runtime\n    transport: subprocess\n    exe: runtime-agent\n    env:\n      PORT: 8080\n      DEBUG: true\n      NODE_ENV: prod\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("numeric env values must coerce to strings");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["runtime"].env.get("PORT"), Some(&"8080".to_string()));
        assert_eq!(
            agents["runtime"].env.get("DEBUG"),
            Some(&"true".to_string())
        );
        assert_eq!(
            agents["runtime"].env.get("NODE_ENV"),
            Some(&"prod".to_string())
        );
    }

    #[test]
    fn parses_scalar_args_as_strings() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-argsnum-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  runtime:\n    name: Runtime\n    transport: subprocess\n    exe: runtime-agent\n    args: [acp, 8080, true]\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("scalar args must coerce to strings");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["runtime"].args, vec!["acp", "8080", "true"]);
    }

    #[test]
    fn resolves_relative_paths_against_config_directory() {
        let mut relative = agent(false);
        relative.exe = "bin/agent.exe".to_string();
        relative.cwd = Some("workspace".to_string());
        let resolved = relative.resolve_paths(Path::new("C:/portable/pylon"));
        assert!(resolved.exe.contains("portable"));
        assert!(
            resolved.exe.ends_with("bin/agent.exe") || resolved.exe.ends_with("bin\\agent.exe")
        );
        assert!(resolved.cwd.unwrap().contains("portable"));
    }

    #[test]
    fn parses_set_model_api_flag_with_default_false() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-setmodel-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  hermes:\n    name: Hermes\n    transport: subprocess\n    exe: hermes\n    set_model_api: true\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: peri\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert!(
            agents["hermes"].set_model_api,
            "配置了 set_model_api: true 必须生效"
        );
        assert!(
            !agents["peri"].set_model_api,
            "缺省必须为 false（官方 set_config_option 路径）"
        );
    }

    #[test]
    fn parses_hermes_profile_field() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-profile-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  hermes:\n    name: Hermes\n    transport: subprocess\n    exe: hermes\n    hermes_profile: profile-a\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: peri\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(
            agents["hermes"].hermes_profile.as_deref(),
            Some("profile-a"),
            "hermes_profile 字段必须解析"
        );
        assert!(
            agents["peri"].hermes_profile.is_none(),
            "未配置的 agent 缺省为 None"
        );
    }

    /// P0-1：旧配置缺 provider 时按协议依据推断——hermes_profile 存在（Hermes 专属字段）→ hermes。
    #[test]
    fn infers_provider_from_hermes_profile_when_missing() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-hermes-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  hermes-work:\n    name: Hermes Work\n    transport: subprocess\n    exe: hermes\n    hermes_profile: profile-a\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(
            agents["hermes-work"].provider.as_deref(),
            Some("hermes"),
            "hermes_profile 存在 → 推断 provider=hermes"
        );
    }

    /// P0-1：旧配置缺 provider 时按可执行程序类型推断——exe 文件名去扩展名小写命中已知 provider。
    #[test]
    fn infers_provider_from_known_exe_stem_when_missing() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-exe-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri-copy:\n    name: Peri Copy\n    transport: subprocess\n    exe: F:\\Agent\\peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(
            agents["peri-copy"].provider.as_deref(),
            Some("peri"),
            "exe 文件名命中已知 provider → 推断 provider=peri"
        );
    }

    #[test]
    fn shared_catalog_infers_claude_alias_and_supplies_protocol_baseline() {
        let yaml = "agents:\n  claude:\n    name: Claude\n    transport: subprocess\n    exe: ccb.cmd\n  hermes:\n    name: Hermes\n    provider: hermes\n    transport: subprocess\n    exe: custom-hermes-launcher\n";
        let agents = parse_agents(yaml, None).expect("catalog-backed agents must parse");
        assert_eq!(agents["claude"].provider.as_deref(), Some("claude-code"));
        assert_eq!(
            agents["hermes"].protocol().set_model_api(),
            SetModelApi::SetModel,
            "Hermes baseline must come from Shared Agent Catalog"
        );
    }

    #[test]
    fn explicit_instance_protocol_override_wins_over_catalog_baseline() {
        let yaml = "agents:\n  hermes:\n    name: Hermes\n    provider: hermes\n    transport: subprocess\n    exe: hermes\n    set_model_api: false\n  hermes-explicit:\n    name: Hermes Explicit\n    provider: hermes\n    transport: subprocess\n    exe: hermes\n    acp:\n      set_model_api: none\n";
        let agents = parse_agents(yaml, None).expect("explicit overrides must parse");
        assert_eq!(
            agents["hermes"].protocol().set_model_api(),
            SetModelApi::ConfigOption
        );
        assert_eq!(
            agents["hermes-explicit"].protocol().set_model_api(),
            SetModelApi::None
        );
    }

    /// P0-1：无协议信号必须保持 None（显式降级，绝不按 agentId 名称猜）。
    #[test]
    fn no_provider_signal_leaves_none() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-none-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  custom:\n    name: Custom\n    transport: subprocess\n    exe: my-agent.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert!(
            agents["custom"].provider.is_none(),
            "无协议信号必须保持 None（显式降级，不猜）"
        );
    }

    /// P0-1：声明值 trim+lowercase 归一（与前端 normalizeProvider 一致，防 wire 大小写漂移）。
    #[test]
    fn declared_provider_is_normalized_lowercase() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-norm-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    provider: PERI\n    transport: subprocess\n    exe: peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["peri"].provider.as_deref(), Some("peri"));
    }

    /// P0-1：声明为空串视为缺省 → 走协议依据推断。
    #[test]
    fn empty_declared_provider_falls_back_to_inference() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-empty-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    provider: \"\"\n    transport: subprocess\n    exe: peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["peri"].provider.as_deref(), Some("peri"));
    }

    /// P0-1：显式声明优先于推断信号（exe 命中 peri 但声明 custom → custom）。
    #[test]
    fn declared_provider_wins_over_exe_signal() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-wins-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    provider: custom\n    transport: subprocess\n    exe: peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(agents["peri"].provider.as_deref(), Some("custom"));
    }

    /// WI-01 CR-001（NOTE 吸收）：误导性 agentId（id=peri）+ 通用 exe 不得推断为 peri——
    /// "不按 agentId 名称猜"由 resolve_provider 签名结构保证，固化为回归守护。
    #[test]
    fn misleading_agent_id_never_drives_provider() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-idguard-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: my-agent.exe\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert!(
            agents["peri"].provider.is_none(),
            "agentId 名称绝不作 provider 推断依据（结构保证固化）"
        );
    }

    /// WI-01 CR-002（NOTE 吸收）：声明 provider 优先于 hermes_profile 推断信号。
    #[test]
    fn declared_provider_wins_over_hermes_profile_signal() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-provider-profile-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  custom:\n    name: Custom\n    provider: custom\n    transport: subprocess\n    exe: hermes\n    hermes_profile: profile-a\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert_eq!(
            agents["custom"].provider.as_deref(),
            Some("custom"),
            "声明优先于 hermes_profile 推断"
        );
    }

    #[test]
    fn parses_structured_acp_fields() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-acp-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: peri\n    args: [\"acp\"]\n    model: deepseek-v4-flash\n    acp_args: [\"--verbose\"]\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let peri = &agents["peri"];
        assert_eq!(peri.model.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(peri.acp_args, vec!["--verbose".to_string()]);
    }

    #[test]
    fn command_args_merge_structured_fields_after_args() {
        let mut def = agent(false);
        def.args = vec!["acp".into(), "--config".into(), "a.yaml".into()];
        def.model = Some("deepseek-v4-flash".into());
        def.acp_args = vec!["--verbose".into(), "--timeout".into(), "120".into()];
        assert_eq!(
            def.command_args(),
            vec![
                "acp",
                "--config",
                "a.yaml",
                "--model",
                "deepseek-v4-flash",
                "--verbose",
                "--timeout",
                "120"
            ]
        );
        // 纯 args（无结构化字段）：原样返回（向后兼容）
        let mut plain = agent(false);
        plain.args = vec!["acp".into()];
        assert_eq!(plain.command_args(), vec!["acp"]);
        // model 后出现 → 覆盖 args 里手工写的 --model
        let mut overridden = agent(false);
        overridden.args = vec!["acp".into(), "--model".into(), "old".into()];
        overridden.model = Some("new".into());
        let merged = overridden.command_args();
        assert_eq!(merged[merged.len() - 2], "--model");
        assert_eq!(merged[merged.len() - 1], "new");
    }

    #[test]
    fn parses_acp_protocol_config_section() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-acpcfg-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  custom:\n    name: Custom\n    transport: subprocess\n    exe: agent\n    acp:\n      initialize_caps:\n        fs: {}\n        auth: {}\n        _meta:\n          \"peri.skillNames\": true\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let caps = agents["custom"]
            .acp
            .as_ref()
            .expect("acp 段必须解析")
            .initialize_caps
            .as_ref()
            .expect("initialize_caps 必须解析");
        assert_eq!(caps["fs"], serde_json::json!({}));
        assert_eq!(caps["_meta"]["peri.skillNames"], serde_json::json!(true));
        // 缺省：无 acp 段
        let plain = agent(false);
        assert!(plain.acp.is_none());
    }

    /// G1-06：close_via_rpc 缺省 true（现状 wire：总是尝试 RPC + -32601 降级）。
    #[test]
    fn close_via_rpc_default_true() {
        assert!(DEFAULT_ACCPROTOCOL.close_via_rpc());
        assert!(AcpProtocolConfig::default().close_via_rpc());
        assert!(
            crate::agent_config::AttachmentLimits::default().max_attachments > 0,
            "附件默认限制与常量同源"
        );
        let mut config = AcpProtocolConfig {
            session_close: Some(false),
            ..AcpProtocolConfig::default()
        };
        assert!(!config.close_via_rpc(), "session_close: false 必须跳过 RPC");
        config.session_close = Some(true);
        assert!(config.close_via_rpc(), "session_close: true 必须尝试 RPC");
    }

    /// G1-01：D2 双格式反序列化——acp 段内 bool|string 五形态 + 顶层 legacy bool
    /// 合并语义（顶层 `set_model_api: true` 无 acp 段 → SetModel；acp 段显式声明优先）。
    #[test]
    fn parses_set_model_api_dual_format() {
        let yaml = "agents:\n  bool-true:\n    name: A\n    transport: subprocess\n    exe: a\n    acp:\n      set_model_api: true\n  bool-false:\n    name: B\n    transport: subprocess\n    exe: b\n    acp:\n      set_model_api: false\n  str-set-model:\n    name: C\n    transport: subprocess\n    exe: c\n    acp:\n      set_model_api: set_model\n  str-config-option:\n    name: D\n    transport: subprocess\n    exe: d\n    acp:\n      set_model_api: config_option\n  str-none:\n    name: E\n    transport: subprocess\n    exe: e\n    acp:\n      set_model_api: none\n  legacy-true:\n    name: F\n    transport: subprocess\n    exe: f\n    set_model_api: true\n  legacy-false:\n    name: G\n    transport: subprocess\n    exe: g\n  legacy-true-overridden:\n    name: H\n    transport: subprocess\n    exe: h\n    set_model_api: true\n    acp:\n      set_model_api: config_option\n";
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-setmodel-dual-{}.yaml",
            std::process::id()
        ));
        std::fs::write(&path, yaml).expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let resolved = |id: &str| agents[id].protocol().set_model_api();
        assert_eq!(resolved("bool-true"), SetModelApi::SetModel);
        assert_eq!(resolved("bool-false"), SetModelApi::ConfigOption);
        assert_eq!(resolved("str-set-model"), SetModelApi::SetModel);
        assert_eq!(resolved("str-config-option"), SetModelApi::ConfigOption);
        assert_eq!(resolved("str-none"), SetModelApi::None);
        assert_eq!(resolved("legacy-true"), SetModelApi::SetModel);
        assert_eq!(resolved("legacy-false"), SetModelApi::ConfigOption);
        assert_eq!(
            resolved("legacy-true-overridden"),
            SetModelApi::ConfigOption,
            "acp 段显式声明必须优先于顶层 legacy bool"
        );
    }

    /// G1-01：空 acp 段/无 acp 段 → 全部访问器 = 重构前硬编码现值（wire 零变化）。
    #[test]
    fn protocol_defaults_match_current_behavior() {
        let path =
            std::env::temp_dir().join(format!("pylon-agents-protodef-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  plain:\n    name: Plain\n    transport: subprocess\n    exe: plain\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let protocol = agents["plain"].protocol();
        // G1-01 自检：D2 兼容合并——顶层 legacy bool 与 acp 段缺省等价
        assert_eq!(protocol.set_model_api(), SetModelApi::ConfigOption);
        assert_eq!(
            protocol.prompt_timeout(),
            crate::acp::DEFAULT_PROMPT_TIMEOUT_SECS
        );
        assert_eq!(
            protocol.cancel_settle_timeout(),
            crate::acp::DEFAULT_CANCEL_SETTLE_TIMEOUT_SECS
        );
        assert_eq!(protocol.rpc_timeout(), DEFAULT_RPC_TIMEOUT_SECS);
        assert_eq!(protocol.replay_max(), DEFAULT_REPLAY_MAX_EVENTS);
        assert_eq!(protocol.protocol_version(), DEFAULT_PROTOCOL_VERSION);
        assert!(protocol.close_via_rpc(), "session_close 缺省必须尝试 RPC");
        assert_eq!(protocol.mcp_servers, McpServersMode::Always);
        let limits = protocol.attachment_limits();
        assert_eq!(limits.max_attachments, crate::acp::DEFAULT_MAX_ATTACHMENTS);
        assert_eq!(
            limits.max_attachment_bytes,
            crate::acp::DEFAULT_MAX_ATTACHMENT_BYTES
        );
        assert_eq!(
            protocol.initialize_caps(),
            serde_json::json!({
                "tokenStats": true,
                "_meta": {
                    "peri.tokenStats": true,
                    "peri.skillNames": true,
                    "peri.replay": true
                }
            }),
            "默认 caps = 现值（tokenStats + _meta.peri.*）"
        );
        assert_eq!(
            protocol.client_info(),
            serde_json::json!({"name": "Pylon", "version": "1.0.0"})
        );
        // DEFAULT_ACCPROTOCOL 静态与解析结果一致（AgentDef::protocol 缺省回退）
        assert_eq!(
            DEFAULT_ACCPROTOCOL.set_model_api(),
            SetModelApi::ConfigOption
        );
        assert_eq!(DEFAULT_ACCPROTOCOL.prompt_timeout(), 300);
    }

    /// G1-01：acp 段全字段声明 → 访问器全部返回声明值。
    #[test]
    fn parses_full_acp_section() {
        // 注意：serde_yml 对"空 flow mapping {} 为块内唯一尾部键"解析失败
        // （多键则正常）——测试用两键形态，生产配置同规避。
        let path =
            std::env::temp_dir().join(format!("pylon-agents-acpfull-{}.yaml", std::process::id()));
        let yaml = "agents:\n  future:\n    name: Future\n    transport: subprocess\n    exe: future\n    acp:\n      set_model_api: none\n      session_close: false\n      mcp_servers: omit_if_empty\n      initialize_caps:\n        fs: {}\n        auth: {}\n      protocol_version: 2\n      client_info:\n        name: Pylon\n        version: \"0.2.0\"\n      prompt_timeout_secs: 600\n      cancel_settle_timeout_secs: 45\n      rpc_timeout_secs: 60\n      max_attachments: 4\n      max_attachment_bytes: 5242880\n      replay_max_events: 5000\n";
        std::fs::write(&path, yaml).expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let protocol = agents["future"].protocol();
        assert_eq!(protocol.set_model_api(), SetModelApi::None);
        assert!(
            !protocol.close_via_rpc(),
            "session_close: false 必须跳过 RPC"
        );
        assert_eq!(protocol.mcp_servers, McpServersMode::OmitIfEmpty);
        assert_eq!(
            protocol.initialize_caps(),
            serde_json::json!({"fs": {}, "auth": {}})
        );
        assert_eq!(protocol.protocol_version(), 2);
        assert_eq!(
            protocol.client_info(),
            serde_json::json!({"name": "Pylon", "version": "0.2.0"})
        );
        assert_eq!(protocol.prompt_timeout(), 600);
        assert_eq!(protocol.cancel_settle_timeout(), 45);
        assert_eq!(protocol.rpc_timeout(), 60);
        let limits = protocol.attachment_limits();
        assert_eq!(limits.max_attachments, 4);
        assert_eq!(limits.max_attachment_bytes, 5_242_880);
        assert_eq!(protocol.replay_max(), 5000);
        // D2 路由纯函数：None + model 键 → Disabled；其余键 → ConfigOption
        assert_eq!(
            protocol.set_model_api().route("model"),
            ModelSwitchTarget::Disabled
        );
        assert_eq!(
            protocol.set_model_api().route("mode"),
            ModelSwitchTarget::ConfigOption
        );
        assert_eq!(
            SetModelApi::SetModel.route("model"),
            ModelSwitchTarget::SetModel
        );
        assert_eq!(
            SetModelApi::SetModel.route("mode"),
            ModelSwitchTarget::ConfigOption
        );
        assert_eq!(
            SetModelApi::ConfigOption.route("model"),
            ModelSwitchTarget::ConfigOption
        );
    }

    /// E1 封闭：非法 acp 取值必须拒绝且报错指明 agent id——
    /// 负数值（serde 层拒绝，逐 agent 包装带 id）、0（parse 校验）、未知枚举。
    #[test]
    fn rejects_invalid_acp_values_with_agent_context() {
        // 负数值：serde u64 层拒绝，报错带 agent id（逐 agent 反序列化包装）
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      prompt_timeout_secs: -5\n",
        )
        .expect_err("负数值必须拒绝");
        assert!(
            error.to_string().contains("agent bad"),
            "报错必须指明 agent id: {error}"
        );
        // 0：parse 校验层拒绝（u64 可解析，语义非法）
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      prompt_timeout_secs: 0\n",
        )
        .expect_err("0 必须拒绝");
        assert!(
            error.to_string().contains("agent bad"),
            "报错必须指明 agent id: {error}"
        );
        assert!(
            error.to_string().contains("prompt_timeout_secs"),
            "报错必须指明字段: {error}"
        );
        // 全部数值字段 0 均拒绝
        for field in [
            "cancel_settle_timeout_secs",
            "rpc_timeout_secs",
            "max_attachments",
            "max_attachment_bytes",
            "replay_max_events",
        ] {
            let error = parse(&format!(
                "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      {field}: 0\n"
            ))
            .expect_err("{field} 为 0 必须拒绝");
            assert!(error.to_string().contains("agent bad"), "{field}: {error}");
            assert!(error.to_string().contains(field), "{field}: {error}");
        }
        // 未知枚举值：反序列化层拒绝，报错带 agent id
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      set_model_api: unknown\n",
        )
        .expect_err("未知 set_model_api 必须拒绝");
        assert!(
            error.to_string().contains("agent bad"),
            "报错必须指明 agent id: {error}"
        );
        assert!(
            error.to_string().contains("set_model_api"),
            "报错必须指明字段: {error}"
        );
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      mcp_servers: sometimes\n",
        )
        .expect_err("未知 mcp_servers 必须拒绝");
        assert!(
            error.to_string().contains("agent bad"),
            "报错必须指明 agent id: {error}"
        );
        assert!(
            error.to_string().contains("mcp_servers"),
            "报错必须指明字段: {error}"
        );
        // 合法值不受影响（正对照）
        assert!(
            parse(
                "agents:\n  good:\n    name: Good\n    transport: subprocess\n    exe: agent\n    acp:\n      prompt_timeout_secs: 1\n      max_attachments: 1\n      max_attachment_bytes: 1\n      replay_max_events: 1\n"
            )
            .is_ok(),
            "合法 >0 值必须通过"
        );
        for (field, maximum) in [
            ("prompt_timeout_secs", 3600u64),
            ("cancel_settle_timeout_secs", 300),
            ("rpc_timeout_secs", 300),
            ("max_attachments", 64),
            ("max_attachment_bytes", 256 * 1024 * 1024),
            ("replay_max_events", 100_000),
        ] {
            let error = parse(&format!(
                "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      {field}: {}\n",
                maximum + 1,
            ))
            .expect_err("超过 hard max 必须拒绝");
            assert!(error.to_string().contains("agent bad"), "{field}: {error}");
            assert!(error.to_string().contains("hard max"), "{field}: {error}");
        }
    }

    // ── R6（P1-4）：分域部分成功与统一装载 ──

    #[test]
    fn config_error_codes_are_stable_and_machine_readable() {
        assert_eq!(ConfigError::Read("x".into()).code(), "config_read_error");
        assert_eq!(ConfigError::Parse("x".into()).code(), "config_parse_error");
        assert_eq!(
            ConfigError::InvalidAgent("x".into()).code(),
            "config_invalid_agent"
        );
        assert_eq!(ConfigError::Invalid("x".into()).code(), "config_error");
    }

    #[test]
    fn config_error_display_preserves_original_message() {
        // R7：Display 透传原文案（前端/日志文案不变），code 独立细分。
        let error = ConfigError::InvalidAgent("agent bad has an empty name".into());
        assert_eq!(error.to_string(), "agent bad has an empty name");
        assert_eq!(error.code(), "config_invalid_agent");
    }

    #[test]
    fn parse_domains_both_domains_ok() {
        let content = r#"
agents:
  peri:
    name: Peri
    transport: subprocess
    exe: peri
gateway:
  routes:
    - source: qq:group:1
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let (agents, gateway) = parse_domains(content, None);
        assert_eq!(agents.expect("agents 必须可解析").len(), 1);
        assert_eq!(
            gateway.expect("gateway 必须可解析").routes.iter().count(),
            1
        );
    }

    #[test]
    fn parse_domains_agent_error_does_not_block_gateway() {
        let content = r#"
agents:
  bad:
    name: ""
    transport: subprocess
    exe: peri
gateway:
  routes:
    - source: qq:group:1
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let (agents, gateway) = parse_domains(content, None);
        assert!(agents.is_err(), "空 name 必须使 agents 失败");
        assert!(
            gateway.is_ok(),
            "agents 失败不得拖垮 gateway（P1-1 部分成功）"
        );
    }

    #[test]
    fn parse_domains_gateway_error_does_not_block_agents() {
        let content = r#"
agents:
  peri:
    name: Peri
    transport: subprocess
    exe: peri
gateway:
  routes:
    - source: qq:group:1
      agent: peri
      profile: trpg
      session: 战役1
      reset: banana
"#;
        let (agents, gateway) = parse_domains(content, None);
        assert!(
            agents.is_ok(),
            "gateway 失败不得拖垮 agents（P1-1 部分成功）"
        );
        let error = gateway.expect_err("非法 reset 必须使 gateway 失败");
        assert!(
            error.to_string().contains("reset"),
            "报错必须指明 reset: {error}"
        );
    }

    #[test]
    fn parse_domains_broken_yaml_fails_both_domains() {
        let (agents, gateway) = parse_domains("{{{ not yaml", None);
        assert!(agents.is_err(), "语法损坏必须使 agents 失败");
        assert!(gateway.is_err(), "语法损坏必须使 gateway 失败");
    }

    #[test]
    fn load_app_config_is_structured_and_source_identifiable() {
        // 环境无关的结构断言：来源三选一、两个域结果都存在（成败由测试环境决定，
        // 不在此断言）。同一份文本分域解析由 parse_domains 测试覆盖。
        let loaded = load_app_config();
        assert!(matches!(
            loaded.source,
            ConfigSource::Environment(_)
                | ConfigSource::ExecutableDirectory(_)
                | ConfigSource::Embedded
        ));
        let _ = loaded.agents.is_ok();
        let _ = loaded.gateway.is_ok();
    }

    #[test]
    fn load_and_load_gateway_config_share_read_entry() {
        // R1：load() 与 load_gateway_config() 都经 read_config_document 单次读文本——
        // 同一来源下两域读取的是同一份内容（P1-1 不变量）。
        let doc = read_config_document();
        let agents = load();
        let gateway_text = load_gateway_config();
        match doc {
            Ok(doc) => {
                // 有来源 → load 解析成功则 gateway 文本即该内容
                if let Ok(agents) = agents {
                    assert!(!agents.is_empty());
                }
                assert_eq!(
                    gateway_text.as_ref().map(|text| text.as_str()),
                    Ok(doc.content.as_str())
                );
            }
            Err(_) => {
                // 无来源（embedded 恒可用，正常不可达）——防回归
                assert!(gateway_text.is_err());
            }
        }
    }

    // ── Phase 3 配置写入纯函数层（§5.5）──

    const SAMPLE: &str = "agents:\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: python\n  hermes:\n    name: Hermes\n    transport: subprocess\n    exe: python\n    default: true\ngateway:\n  qq:\n    group_allow_from: [g1]\n  routes:\n    - source: qq:user:demo-user\n      agent: peri\n      profile: p\n      session: s\n";

    #[test]
    fn agent_patch_replaces_target_and_preserves_others() {
        let patched = apply_agent_patch(
            SAMPLE,
            "peri",
            "name: Peri2\ntransport: subprocess\nexe: python3\n",
        )
        .unwrap();
        assert!(patched.contains("name: Peri2"), "目标 agent 必须替换");
        assert!(patched.contains("name: Hermes"), "其余 agent 必须保留");
        // round-trip：重解析后 peri 更新、hermes 不变
        let agents = parse(&patched).unwrap();
        assert_eq!(agents["peri"].name, "Peri2");
        assert_eq!(agents["hermes"].name, "Hermes");
        assert_eq!(agents["hermes"].default, true);
    }

    #[test]
    fn agent_patch_rejects_missing_agent_and_bad_patch() {
        assert!(
            apply_agent_patch(SAMPLE, "ghost", "name: X\nexe: y\ntransport: subprocess\n").is_err(),
            "不存在 agent 默认禁止创建"
        );
        assert!(
            apply_agent_patch(SAMPLE, "peri", "name: [unclosed").is_err(),
            "非法 YAML 补丁必须报错"
        );
    }

    #[test]
    fn gateway_patch_replaces_routes_keeps_qq() {
        let patch = serde_json::json!({ "gateway": { "routes": [{ "source": "qq:user:new", "agent": "hermes", "profile": "p", "session": "s" }] } });
        let patched = apply_gateway_patch(SAMPLE, &patch).unwrap();
        assert!(patched.contains("qq:user:new"), "routes 必须整段替换");
        assert!(!patched.contains("qq:user:demo-user"), "旧 routes 必须移除");
        assert!(
            patched.contains("group_allow_from"),
            "qq 段必须保留（显式 patch 不做深 merge）"
        );
        // round-trip：gateway 域重解析校验通过
        validate_candidate(&patched, None).unwrap();
    }

    #[test]
    fn gateway_patch_rejects_unknown_keys() {
        let patch = serde_json::json!({ "gateway": { "routes": [], "inject": {} } });
        assert!(
            apply_gateway_patch(SAMPLE, &patch).is_err(),
            "只允许 routes 键"
        );
        let no_routes = serde_json::json!({ "gateway": { "qq": {} } });
        assert!(
            apply_gateway_patch(SAMPLE, &no_routes).is_err(),
            "缺少 routes 必须报错"
        );
    }

    #[test]
    fn validate_candidate_rejects_bad_agent_and_bad_gateway() {
        let bad_env = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n    env:\n      \"k=v\": x\n";
        assert!(
            validate_candidate(bad_env, None).is_err(),
            "env 键含 = 必须拒绝"
        );
        let bad_route = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\ngateway:\n  routes:\n    - source: x\n";
        assert!(
            validate_candidate(bad_route, None).is_err(),
            "route 缺 agent/profile/session 必须拒绝"
        );
    }

    #[test]
    fn write_config_atomically_creates_replaces_and_cleans_temp() {
        let dir = std::env::temp_dir().join(format!("pylon-cfg-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        // 新建
        write_config_atomically(
            &path,
            "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap().trim(),
            "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n".trim()
        );
        // 覆盖（替换语义）
        write_config_atomically(
            &path,
            "agents:\n  b:\n    name: B\n    transport: subprocess\n    exe: python\n",
        )
        .unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("name: B"));
        // 无临时残留
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "失败/成功后不得残留临时文件");
        // 写后重解析等价（§5.5 round-trip）
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(parse(&content).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_config_atomically_fails_on_missing_dir() {
        let dir = std::env::temp_dir().join(format!("pylon-cfg-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("agents.yaml");
        let result = write_config_atomically(&path, "x");
        assert!(
            matches!(result, Err(ConfigError::Write(_))),
            "目标目录缺失必须 config_write_error"
        );
    }

    // ── 施工文档 Phase 2：agent_fields / agent_create 纯函数 ──

    #[test]
    fn agent_field_patch_updates_whitelisted_fields_and_preserves_advanced_fields() {
        let content = "agents:\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: python\n    model: deepseek\n    acp:\n      rpc_timeout_secs: 60\n  hermes:\n    name: Hermes\n    transport: subprocess\n    exe: python\n    default: true\n";
        let patched = apply_agent_field_patch(
            content,
            "peri",
            &serde_json::json!({ "exe": "F:/Agent/peri.exe", "name": "Peri2", "provider": "PERI" }),
        )
        .unwrap();
        let agents = parse(&patched).unwrap();
        assert_eq!(agents["peri"].exe, "F:/Agent/peri.exe");
        assert_eq!(agents["peri"].name, "Peri2");
        assert_eq!(agents["peri"].provider.as_deref(), Some("peri"));
        assert_eq!(agents["peri"].model.as_deref(), Some("deepseek"));
        assert_eq!(agents["peri"].protocol().rpc_timeout(), 60);
        assert!(agents["hermes"].default, "非目标 default 不受 patch 影响");
    }

    #[test]
    fn agent_field_patch_default_true_mutual_exclusion() {
        let content = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n    default: true\n  b:\n    name: B\n    transport: subprocess\n    exe: python\n";
        let patched =
            apply_agent_field_patch(content, "b", &serde_json::json!({ "default": true })).unwrap();
        let agents = parse(&patched).unwrap();
        assert!(agents["b"].default, "目标必须置 default");
        assert!(
            !agents["a"].default,
            "其他 agent 必须在同一事务内取消 default"
        );
        assert_eq!(default_agent_id(&agents).unwrap(), Some("b".to_string()));
    }

    #[test]
    fn embedded_repository_config_can_materialize_default_switch() {
        let content = include_str!("../../agents.yaml");
        let patched =
            apply_agent_field_patch(content, "hermes", &serde_json::json!({ "default": true }))
                .expect("repository config field patch must succeed");
        let agents = validate_candidate(&patched, None)
            .expect("repository config candidate must remain valid");
        assert_eq!(
            default_agent_id(&agents).unwrap(),
            Some("hermes".to_string())
        );
    }

    #[test]
    fn agent_field_patch_rejects_unknown_and_bad_types() {
        let content = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n";
        assert!(apply_agent_field_patch(content, "a", &serde_json::json!({ "env": {} })).is_err());
        assert!(apply_agent_field_patch(content, "a", &serde_json::json!({ "exe": 1 })).is_err());
        assert!(
            apply_agent_field_patch(content, "a", &serde_json::json!({ "transport": "http" }))
                .is_err()
        );
        assert!(
            apply_agent_field_patch(content, "ghost", &serde_json::json!({ "name": "X" })).is_err()
        );
    }

    #[test]
    fn agent_create_inserts_new_agent_and_rejects_duplicate() {
        let content = "agents:\n  a:\n    name: A\n    transport: subprocess\n    exe: python\n";
        let agent = serde_json::json!({
            "name": "B: #1",
            "provider": "custom",
            "transport": "subprocess",
            "exe": "C:\\Program Files\\Agent\\agent.exe",
            "args": ["acp", "--profile", "work space"]
        });
        let created = apply_agent_create(
            content,
            "b.v2",
            &agent,
        )
        .unwrap();
        let agents = parse(&created).unwrap();
        assert!(agents.contains_key("b.v2"));
        let created_document = parse_config_document(&created).unwrap();
        let created_agent = created_document["agents"]["b.v2"]
            .as_mapping()
            .expect("created agent node");
        assert_eq!(
            created_agent.get("name").and_then(serde_yml::Value::as_str),
            Some("B: #1")
        );
        assert!(created_agent.get("agents").is_none(), "不得嵌套完整 agents 文档");
        assert!(apply_agent_create(
            content,
            "a",
            &serde_json::json!({ "name": "X", "transport": "subprocess", "exe": "python" })
        )
        .is_err());
        assert!(apply_agent_create(
            content,
            "nested",
            &serde_json::json!({ "agents": { "nested": agent } })
        )
        .is_err());
    }

    #[test]
    fn structured_agents_document_round_trips_special_characters() {
        let document = serde_json::json!({
            "agents": {
                "custom-agent": {
                    "name": "Agent: #1",
                    "provider": "custom",
                    "transport": "subprocess",
                    "exe": "C:\\Program Files\\Agent\\agent.exe",
                    "args": ["acp", "--profile", "work space"],
                    "default": true
                }
            }
        });
        let serialized = serialize_agents_document(&document).unwrap();
        let agents = parse(&serialized).unwrap();
        let custom = agents.get("custom-agent").expect("custom agent");
        assert_eq!(custom.name, "Agent: #1");
        assert_eq!(custom.exe, "C:\\Program Files\\Agent\\agent.exe");
        assert_eq!(custom.args, vec!["acp", "--profile", "work space"]);
        assert!(serialize_agents_document(&serde_json::json!({ "agents": {} })).is_err());
    }

    #[test]
    fn agent_id_validation_matches_contract() {
        assert!(validate_agent_id("peri").is_ok());
        assert!(validate_agent_id("agent.v2-beta_x").is_ok());
        assert!(validate_agent_id("_bad").is_err());
        assert!(validate_agent_id("bad id").is_err());
        assert!(validate_agent_id("").is_err());
    }
}
