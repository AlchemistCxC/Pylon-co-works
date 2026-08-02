use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
struct AgentConfigFile {
    agents: HashMap<String, AgentDef>,
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
    pub acp: Option<AcpConfig>,
}

/// per-agent ACP 协议行为配置（agents.yaml `acp:` 段）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AcpConfig {
    /// initialize 请求的 clientCapabilities 覆盖（任意 JSON，原样进 wire）。
    /// None = 统一默认（tokenStats + _meta.peri.*，Hermes 忽略无害）。
    #[serde(default)]
    pub initialize_caps: Option<serde_json::Value>,
}

impl AgentDef {
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
                log::warn!(
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
fn scalar_to_string(value: serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(text) => Some(text),
        serde_yaml::Value::Number(number) => Some(number.to_string()),
        serde_yaml::Value::Bool(flag) => Some(flag.to_string()),
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
                let value = access.next_value::<serde_yaml::Value>()?;
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
    let values = Vec::<serde_yaml::Value>::deserialize(deserializer)?;
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

fn parse(content: &str) -> Result<HashMap<String, AgentDef>, String> {
    let config: AgentConfigFile = serde_yaml::from_str(content)
        .map_err(|error| format!("failed to parse agents.yaml: {error}"))?;
    if config.agents.is_empty() {
        return Err("agents.yaml contains no agents".to_string());
    }
    for (id, agent) in &config.agents {
        if id.trim().is_empty() {
            return Err("agents.yaml contains an agent with an empty id".to_string());
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
    }
    Ok(config.agents)
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
}
