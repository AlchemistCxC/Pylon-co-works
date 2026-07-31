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
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub default: bool,
}

impl AgentDef {
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

pub fn config_path() -> Option<PathBuf> {
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
}
