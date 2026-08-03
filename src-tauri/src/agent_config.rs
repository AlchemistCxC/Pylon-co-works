use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
struct AgentConfigFile {
    /// E1：agents 先以宽松值解析，再在 parse() 内逐 agent 反序列化——
    /// 非法字段（负数值/未知枚举/类型错误）的报错带 agent id 上下文。
    agents: HashMap<String, serde_yml::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentDef {
    pub name: String,
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
    #[allow(dead_code)]
    #[serde(default)]
    pub session_close: Option<bool>,
    /// D4 mcpServers 字段形态：always(默认，恒发字段，现状) | omit_if_empty
    /// （v2 语义，空则省略——07 文档 §8.2）。
    /// G2（W2 链 E）消费：session_new/load 调用点传 `protocol().mcp_servers`。
    #[allow(dead_code)]
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
    /// H7 写通道超时（秒）；None = 10。E2 已定：写超时是"连接活性"语义，
    /// 默认值仍可配置，但 send_line/writer 任务不按协议参数分派。
    #[serde(default)]
    pub write_timeout_secs: Option<u64>,
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
    #[allow(dead_code)]
    pub fn route(self, key: &str) -> ModelSwitchTarget {
        match self {
            Self::SetModel if key == "model" => ModelSwitchTarget::SetModel,
            Self::None if key == "model" => ModelSwitchTarget::Disabled,
            _ => ModelSwitchTarget::ConfigOption,
        }
    }
}

/// D2 路由结果（G2 set_config_option 三路匹配消费；G1 链内无消费点，W2 移交）。
#[allow(dead_code)]
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
    write_timeout_secs: None,
    max_attachments: None,
    max_attachment_bytes: None,
    replay_max_events: None,
};

impl AcpProtocolConfig {
    /// D2 已解析的切 model 途径：acp 段声明优先；未声明回退 ConfigOption
    /// （生产解析路径 parse() 已合并顶层 legacy bool，此兜底仅覆盖直构场景）。
    /// G2（W2 链 E）消费：`protocol().set_model_api().route(&key)`。
    #[allow(dead_code)]
    pub fn set_model_api(&self) -> SetModelApi {
        self.set_model_api.unwrap_or(SetModelApi::ConfigOption)
    }

    /// D3 是否尝试 session/close RPC（false = 跳过 RPC 直接本地清理；缺省 true）。
    /// G2（W2 链 E）消费：close 四处消费点。
    #[allow(dead_code)]
    pub fn close_via_rpc(&self) -> bool {
        self.session_close.unwrap_or(true)
    }

    /// H5 prompt 超时（秒，缺省 300）。G2（W2 链 E）消费：wait_prompt_with_cancel。
    #[allow(dead_code)]
    pub fn prompt_timeout(&self) -> u64 {
        self.prompt_timeout_secs.unwrap_or(crate::acp::PROMPT_TIMEOUT_SECS)
    }

    /// H6 cancel settle 超时（秒，缺省 30）。G2（W2 链 E）消费。
    #[allow(dead_code)]
    pub fn cancel_settle_timeout(&self) -> u64 {
        self.cancel_settle_timeout_secs
            .unwrap_or(crate::acp::CANCEL_SETTLE_TIMEOUT_SECS)
    }

    /// H8/H9 通用 RPC 超时（秒，缺省 30；complete + 回放共用）。
    pub fn rpc_timeout(&self) -> u64 {
        self.rpc_timeout_secs.unwrap_or(DEFAULT_RPC_TIMEOUT_SECS)
    }

    /// H7 写通道超时（秒，缺省 10）。G2（W2 链 E）消费：permission.rs H18 同源建议。
    #[allow(dead_code)]
    pub fn write_timeout(&self) -> u64 {
        self.write_timeout_secs.unwrap_or(crate::acp::DEFAULT_WRITE_TIMEOUT_SECS)
    }

    /// H10/H11 附件限制（缺省 8 / 10MB）。
    pub fn attachment_limits(&self) -> AttachmentLimits {
        AttachmentLimits {
            max_attachments: self.max_attachments.unwrap_or(crate::acp::DEFAULT_MAX_ATTACHMENTS),
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
    serde_json::json!({"name": "Pylon", "version": "0.1.0"})
}

/// E1：acp 段取值校验——数值字段必须 > 0（负数在反序列化层已被 u64 拒绝，
/// 此处拦截 0 并指明 agent id；风格对齐 route.rs reset 校验）。
fn validate_acp_section(id: &str, acp: &AcpProtocolConfig) -> Result<(), String> {
    let numeric = [
        ("prompt_timeout_secs", acp.prompt_timeout_secs.map(|v| v as u128)),
        ("cancel_settle_timeout_secs", acp.cancel_settle_timeout_secs.map(|v| v as u128)),
        ("rpc_timeout_secs", acp.rpc_timeout_secs.map(|v| v as u128)),
        ("write_timeout_secs", acp.write_timeout_secs.map(|v| v as u128)),
        ("max_attachments", acp.max_attachments.map(|v| v as u128)),
        ("max_attachment_bytes", acp.max_attachment_bytes.map(|v| v as u128)),
        ("replay_max_events", acp.replay_max_events.map(|v| v as u128)),
    ];
    for (field, value) in numeric {
        if value == Some(0) {
            return Err(format!("agent {id} 的 acp.{field} 非法: 0（必须大于 0）"));
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

/// O28：生效配置路径进程级缓存——有效路径在进程生命周期内不变，避免每次调用
/// 重复 stat exe 旁 agents.yaml（reload_gateway/load 高频路径）。
static EFFECTIVE_CONFIG_PATH: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// 实际生效的配置路径：优先 `PYLON_AGENTS_CONFIG`，其次 exe 同目录的
/// `agents.yaml`（发行包可热改），否则回退编译期嵌入（返回 None）。
pub fn effective_config_path() -> Option<PathBuf> {
    EFFECTIVE_CONFIG_PATH
        .get_or_init(|| {
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
        })
        .clone()
}

pub fn load() -> Result<HashMap<String, AgentDef>, String> {
    if let Some(path) = effective_config_path() {
        return load_from_path(&path);
    }
    parse(include_str!("../../agents.yaml"))
}

/// 网关配置读取统一入口（R35）：effective_config_path 优先读文件，无路径时回退
/// 编译期嵌入（include_str）。reload 路径的异步读（tokio::fs）在 gateway_cmds 内
/// 实现，本入口承载"路径选择 + 兜底"语义供复用。
/// 登记说明：启动路径 GatewayCore::new 已含 include_str 兜底 + reload 热更新覆盖，
/// 本次只统一 reload 路径（gateway/mod.rs 属另一链，禁碰）。
pub fn load_gateway_config() -> Result<String, String> {
    match effective_config_path() {
        Some(path) => std::fs::read_to_string(&path)
            .map_err(|error| format!("读取 {} 失败: {error}", path.display())),
        None => Ok(include_str!("../../agents.yaml").to_string()),
    }
}

fn parse(content: &str) -> Result<HashMap<String, AgentDef>, String> {
    // R27b：serde_yaml → serde_yml（API 兼容：serde_yml::from_str）。
    // 自定义错误前缀 "failed to parse agents.yaml" 保持（不依赖上游错误文案）。
    // E1：agents 先以宽松值解析再逐 agent 反序列化——非法字段（负数值/未知枚举/
    // 类型错误）的报错带 agent id 上下文（风格对齐 route.rs reset 校验）。
    let config: AgentConfigFile = serde_yml::from_str(content)
        .map_err(|error| format!("failed to parse agents.yaml: {error}"))?;
    if config.agents.is_empty() {
        return Err("agents.yaml contains no agents".to_string());
    }
    let mut agents = HashMap::with_capacity(config.agents.len());
    for (id, raw) in config.agents {
        if id.trim().is_empty() {
            return Err("agents.yaml contains an agent with an empty id".to_string());
        }
        let mut agent: AgentDef = serde_yml::from_value(raw)
            .map_err(|error| format!("agent {id} 配置非法: {error}"))?;
        // D2 兼容合并：acp 段未声明 set_model_api 时回退顶层 legacy bool
        // （agents.yaml 现状 hermes 即顶层 `set_model_api: true`——旧键保留，
        // bool 双格式兼容；acp 段显式声明优先）。
        match agent.acp.as_mut() {
            Some(acp) if acp.set_model_api.is_none() => {
                acp.set_model_api = Some(if agent.set_model_api {
                    SetModelApi::SetModel
                } else {
                    SetModelApi::ConfigOption
                });
            }
            None if agent.set_model_api => {
                agent.acp = Some(AcpProtocolConfig {
                    set_model_api: Some(SetModelApi::SetModel),
                    ..Default::default()
                });
            }
            _ => {}
        }
        if agent.name.trim().is_empty() {
            return Err(format!("agent {id} has an empty name"));
        }
        if agent.exe.trim().is_empty() {
            return Err(format!("agent {id} has an empty executable"));
        }
        if agent.transport != "subprocess" {
            return Err(format!(
                "agent {id} uses unsupported transport: {}",
                agent.transport
            ));
        }
        // A11：env 键/值未校验时 `cmd.env(k, v)` 会 panic（含 '=' 或 NUL 的键、
        // NUL 值均触发）——非法配置从启动 panic 变为启动报错降级。
        for (key, value) in &agent.env {
            if key.is_empty() {
                return Err(format!("agent {id} has invalid env entry: empty key"));
            }
            if key.contains('=') {
                return Err(format!(
                    "agent {id} has invalid env entry: key contains '=': {key:?}"
                ));
            }
            if key.contains('\0') || value.contains('\0') {
                return Err(format!(
                    "agent {id} has invalid env entry: NUL byte in key or value: {key:?}"
                ));
            }
        }
        if let Some(acp) = &agent.acp {
            validate_acp_section(&id, acp)?;
        }
        agents.insert(id, agent);
    }
    Ok(agents)
}

pub fn load_from_path(path: &Path) -> Result<HashMap<String, AgentDef>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("read agent config {} failed: {error}", path.display()))?;
    let agents = parse(&content)?;
    // A11：相对 exe/cwd 以配置所在目录为基准绝对化（否则相对路径随进程 cwd 变化，
    // 落库/回放错位）。connect_with_logs 的临时 resolve 保留（幂等，双保险）。
    let base_dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    Ok(agents
        .into_iter()
        .map(|(id, agent)| (id, agent.resolve_paths(base_dir)))
        .collect())
}

pub fn default_agent_id(agents: &HashMap<String, AgentDef>) -> Result<Option<String>, String> {
    let mut defaults: Vec<&String> = agents
        .iter()
        .filter(|(_, agent)| agent.default)
        .map(|(id, _)| id)
        .collect();
    if defaults.len() > 1 {
        defaults.sort();
        return Err(format!(
            "multiple default agents configured: {}",
            defaults
                .iter()
                .map(|id| id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
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
            transport: "subprocess".to_string(),
            exe: "missing-agent".to_string(),
            args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            default,
            set_model_api: false,
            model: None,
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
        assert!(error.contains("a, b"));
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
        assert!(error.contains("agent bad has invalid env entry"));
    }

    #[test]
    fn rejects_agent_env_key_containing_equals() {
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    env:\n      \"a=b\": \"value\"\n",
        )
        .expect_err("env key containing '=' must be rejected");
        assert!(error.contains("agent bad has invalid env entry"));
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
        let mut config = AcpProtocolConfig::default();
        config.session_close = Some(false);
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
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-protodef-{}.yaml",
            std::process::id()
        ));
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
        assert_eq!(protocol.prompt_timeout(), crate::acp::PROMPT_TIMEOUT_SECS);
        assert_eq!(
            protocol.cancel_settle_timeout(),
            crate::acp::CANCEL_SETTLE_TIMEOUT_SECS
        );
        assert_eq!(protocol.rpc_timeout(), DEFAULT_RPC_TIMEOUT_SECS);
        assert_eq!(protocol.write_timeout(), crate::acp::DEFAULT_WRITE_TIMEOUT_SECS);
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
            serde_json::json!({"name": "Pylon", "version": "0.1.0"})
        );
        // DEFAULT_ACCPROTOCOL 静态与解析结果一致（AgentDef::protocol 缺省回退）
        assert_eq!(DEFAULT_ACCPROTOCOL.set_model_api(), SetModelApi::ConfigOption);
        assert_eq!(DEFAULT_ACCPROTOCOL.prompt_timeout(), 300);
    }

    /// G1-01：acp 段全字段声明 → 访问器全部返回声明值。
    #[test]
    fn parses_full_acp_section() {
        // 注意：serde_yml 对"空 flow mapping {} 为块内唯一尾部键"解析失败
        // （多键则正常）——测试用两键形态，生产配置同规避。
        let yaml = "agents:\n  future:\n    name: Future\n    transport: subprocess\n    exe: future\n    acp:\n      set_model_api: none\n      session_close: false\n      mcp_servers: omit_if_empty\n      initialize_caps:\n        fs: {}\n        auth: {}\n      protocol_version: 2\n      client_info:\n        name: Pylon\n        version: \"0.2.0\"\n      prompt_timeout_secs: 600\n      cancel_settle_timeout_secs: 45\n      rpc_timeout_secs: 60\n      write_timeout_secs: 15\n      max_attachments: 4\n      max_attachment_bytes: 5242880\n      replay_max_events: 5000\n";
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-acpfull-{}.yaml",
            std::process::id()
        ));
        std::fs::write(&path, yaml).expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let protocol = agents["future"].protocol();
        assert_eq!(protocol.set_model_api(), SetModelApi::None);
        assert!(!protocol.close_via_rpc(), "session_close: false 必须跳过 RPC");
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
        assert_eq!(protocol.write_timeout(), 15);
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
        assert!(error.contains("agent bad"), "报错必须指明 agent id: {error}");
        // 0：parse 校验层拒绝（u64 可解析，语义非法）
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      prompt_timeout_secs: 0\n",
        )
        .expect_err("0 必须拒绝");
        assert!(error.contains("agent bad"), "报错必须指明 agent id: {error}");
        assert!(
            error.contains("prompt_timeout_secs"),
            "报错必须指明字段: {error}"
        );
        // 全部数值字段 0 均拒绝
        for field in [
            "cancel_settle_timeout_secs",
            "rpc_timeout_secs",
            "write_timeout_secs",
            "max_attachments",
            "max_attachment_bytes",
            "replay_max_events",
        ] {
            let error = parse(&format!(
                "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      {field}: 0\n"
            ))
            .expect_err("{field} 为 0 必须拒绝");
            assert!(error.contains("agent bad"), "{field}: {error}");
            assert!(error.contains(field), "{field}: {error}");
        }
        // 未知枚举值：反序列化层拒绝，报错带 agent id
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      set_model_api: unknown\n",
        )
        .expect_err("未知 set_model_api 必须拒绝");
        assert!(error.contains("agent bad"), "报错必须指明 agent id: {error}");
        assert!(
            error.contains("set_model_api"),
            "报错必须指明字段: {error}"
        );
        let error = parse(
            "agents:\n  bad:\n    name: Bad\n    transport: subprocess\n    exe: agent\n    acp:\n      mcp_servers: sometimes\n",
        )
        .expect_err("未知 mcp_servers 必须拒绝");
        assert!(error.contains("agent bad"), "报错必须指明 agent id: {error}");
        assert!(error.contains("mcp_servers"), "报错必须指明字段: {error}");
        // 合法值不受影响（正对照）
        assert!(
            parse(
                "agents:\n  good:\n    name: Good\n    transport: subprocess\n    exe: agent\n    acp:\n      prompt_timeout_secs: 1\n      max_attachments: 1\n      max_attachment_bytes: 1\n      replay_max_events: 1\n"
            )
            .is_ok(),
            "合法 >0 值必须通过"
        );
    }
}
