use super::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
        ConfigSource::Embedded => include_str!("../../../agents.example.yaml").to_string(),
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
pub(crate) fn parse_domains(
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
pub(crate) fn parse_agents(
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
pub(crate) fn resolve_config_source() -> (ConfigSource, Option<PathBuf>) {
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
pub(crate) fn resolve_provider(agent: &AgentDef) -> Result<Option<String>, ConfigError> {
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

pub(crate) fn catalog_set_model_api(provider: Option<&str>) -> Result<SetModelApi, ConfigError> {
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

pub(crate) fn parse(content: &str) -> Result<HashMap<String, AgentDef>, ConfigError> {
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

