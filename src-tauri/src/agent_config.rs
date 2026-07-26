use std::collections::HashMap;
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

pub fn load() -> HashMap<String, AgentDef> {
    let content = include_str!("../../agents.yaml");
    let config: AgentConfigFile = serde_yaml::from_str(content)
        .expect("failed to parse agents.yaml");
    config.agents
}

/// Returns the id (key) of the first agent with `default: true`, or the first agent in the map.
pub fn default_agent_id(agents: &HashMap<String, AgentDef>) -> &str {
    agents.iter().find(|(_, a)| a.default)
        .or_else(|| agents.iter().next())
        .map(|(k, _)| k.as_str())
        .expect("no agents in agents.yaml")
}
