use std::collections::HashMap;
use std::path::{Path, PathBuf};
use serde::Deserialize;

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
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
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
            if self.acp_args.iter().any(|arg| arg == "--model" || arg.starts_with("--model=")) {
                log::warn!("agent {}: acp_args 含 --model，结构化 model 字段被忽略", self.name);
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

/// 实际生效的配置路径：优先 `PYLON_AGENTS_CONFIG`，其次 exe 同目录的
/// `agents.yaml`（发行包可热改），否则回退编译期嵌入（返回 None）。
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
            return Err(format!("agent {id} uses unsupported transport: {}", agent.transport));
        }
    }
    Ok(config.agents)
}

pub fn load_from_path(path: &Path) -> Result<HashMap<String, AgentDef>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("read agent config {} failed: {error}", path.display()))?;
    parse(&content)
}

pub fn default_agent_id(agents: &HashMap<String, AgentDef>) -> Result<Option<String>, String> {
    let mut defaults: Vec<&String> = agents.iter()
        .filter(|(_, agent)| agent.default)
        .map(|(id, _)| id)
        .collect();
    if defaults.len() > 1 {
        defaults.sort();
        return Err(format!("multiple default agents configured: {}", defaults.iter().map(|id| id.as_str()).collect::<Vec<_>>().join(", ")));
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
        assert_eq!(default_agent_id(&agents).unwrap(), Some("primary".to_string()));
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
        assert_eq!(default_agent_id(&agents).unwrap(), Some("alpha".to_string()));
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
    fn resolves_relative_paths_against_config_directory() {
        let mut relative = agent(false);
        relative.exe = "bin/agent.exe".to_string();
        relative.cwd = Some("workspace".to_string());
        let resolved = relative.resolve_paths(Path::new("C:/portable/pylon"));
        assert!(resolved.exe.contains("portable"));
        assert!(resolved.exe.ends_with("bin/agent.exe") || resolved.exe.ends_with("bin\\agent.exe"));
        assert!(resolved.cwd.unwrap().contains("portable"));
    }

    #[test]
    fn parses_set_model_api_flag_with_default_false() {
        let path = std::env::temp_dir().join(format!("pylon-agents-setmodel-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  hermes:\n    name: Hermes\n    transport: subprocess\n    exe: hermes\n    set_model_api: true\n  peri:\n    name: Peri\n    transport: subprocess\n    exe: peri\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        assert!(agents["hermes"].set_model_api, "配置了 set_model_api: true 必须生效");
        assert!(!agents["peri"].set_model_api, "缺省必须为 false（官方 set_config_option 路径）");
    }

    #[test]
    fn parses_structured_acp_fields() {
        let path = std::env::temp_dir().join(format!("pylon-agents-acp-{}.yaml", std::process::id()));
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
            vec!["acp", "--config", "a.yaml", "--model", "deepseek-v4-flash", "--verbose", "--timeout", "120"]
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
        let path = std::env::temp_dir().join(format!("pylon-agents-acpcfg-{}.yaml", std::process::id()));
        std::fs::write(
            &path,
            "agents:\n  custom:\n    name: Custom\n    transport: subprocess\n    exe: agent\n    acp:\n      initialize_caps:\n        fs: {}\n        auth: {}\n        _meta:\n          \"peri.skillNames\": true\n",
        )
        .expect("write temp agent config");
        let agents = load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let caps = agents["custom"].acp.as_ref().expect("acp 段必须解析").initialize_caps.as_ref().expect("initialize_caps 必须解析");
        assert_eq!(caps["fs"], serde_json::json!({}));
        assert_eq!(caps["_meta"]["peri.skillNames"], serde_json::json!(true));
        // 缺省：无 acp 段
        let plain = agent(false);
        assert!(plain.acp.is_none());
    }
}
