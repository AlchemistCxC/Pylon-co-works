use std::collections::HashMap;
use std::path::Path;
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

fn parse(content: &str) -> Result<HashMap<String, AgentDef>, String> {
    let config: AgentConfigFile = serde_yaml::from_str(content)
        .map_err(|error| format!("failed to parse agents.yaml: {error}"))?;
    if config.agents.is_empty() {
        return Err("agents.yaml contains no agents".to_string());
    }
    Ok(config.agents)
}

pub fn load() -> Result<HashMap<String, AgentDef>, String> {
    parse(include_str!("../../agents.yaml"))
}

pub fn load_from_path(path: &Path) -> Result<HashMap<String, AgentDef>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("read agent config {} failed: {error}", path.display()))?;
    parse(&content)
}

/// Returns the id (key) of the first agent with `default: true`, or the first agent in the map.
pub fn default_agent_id(agents: &HashMap<String, AgentDef>) -> Option<&str> {
    agents.iter().find(|(_, a)| a.default)
        .or_else(|| agents.iter().next())
        .map(|(k, _)| k.as_str())
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
        assert_eq!(default_agent_id(&HashMap::new()), None);
    }

    #[test]
    fn explicit_default_agent_wins() {
        let mut agents = HashMap::new();
        agents.insert("fallback".to_string(), agent(false));
        agents.insert("primary".to_string(), agent(true));
        assert_eq!(default_agent_id(&agents), Some("primary"));
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
}
