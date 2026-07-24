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
}

pub fn load() -> HashMap<String, AgentDef> {
    let content = include_str!("../../agents.yaml");
    let config: AgentConfigFile = serde_yaml::from_str(content)
        .expect("failed to parse agents.yaml");
    config.agents
}
