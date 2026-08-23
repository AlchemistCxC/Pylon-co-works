//! Shared first-party Agent Catalog.
//!
//! The JSON document is the single provider baseline consumed by both Rust and
//! TypeScript. Native code keeps process discovery behind a controlled
//! projection; editable agents.yaml never supplies scan commands.
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../../../shared/agent-catalog.json");
const SUPPORTED_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogInvocation {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogDetection {
    detector_id: String,
    priority: i32,
    invocations: Vec<CatalogInvocation>,
    config_dirs: Vec<String>,
    #[serde(default)]
    config_evidence: Vec<CatalogConfigEvidence>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CatalogConfigFormat {
    Json,
    Yaml,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogConfigEvidence {
    pub relative_path: String,
    pub format: CatalogConfigFormat,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CatalogSetModelApi {
    ConfigOption,
    SetModel,
    None,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogProtocolDefaults {
    set_model_api: CatalogSetModelApi,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogCapabilities {
    session_updates: bool,
    interaction_events: bool,
    permission_requests: bool,
    replay: bool,
    response_methods: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogTool {
    name: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    display_name: Option<String>,
    kind: String,
    action: String,
    #[serde(default)]
    summary_fields: Vec<String>,
    #[serde(default)]
    output_label: Option<String>,
    /// 2f227cc 起共享目录为工具补充 capability 标签（delegate/subagent/background 等）。
    /// Rust 侧暂无消费者；接受该字段以保持 deny_unknown_fields 与 shared/agent-catalog.json
    /// 单一真值同步（否则 36 个 agent_config 测试因 unknown field 拒绝整个目录）。
    #[serde(default)]
    #[allow(dead_code)] // 解析兼容字段：catalog 数据带此字段必须可解析，按设计存而不读
    capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogProvider {
    provider: String,
    display_name: String,
    protocol: String,
    capabilities: CatalogCapabilities,
    interaction_kinds: Vec<String>,
    protocol_defaults: CatalogProtocolDefaults,
    detection: CatalogDetection,
    tools: Vec<CatalogTool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogDocument {
    schema_version: u32,
    providers: Vec<CatalogProvider>,
}

#[derive(Debug, Clone)]
pub struct AgentDetectionProfile {
    pub detector_id: String,
    pub provider: String,
    pub display_name: String,
    pub priority: i32,
    pub invocations: Vec<CatalogInvocation>,
    pub config_dirs: Vec<String>,
    pub config_evidence: Vec<CatalogConfigEvidence>,
}

static CATALOG: OnceLock<Result<CatalogDocument, String>> = OnceLock::new();

fn validate_non_empty(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("Agent Catalog {label} 不能为空"))
    } else {
        Ok(())
    }
}

fn parse_catalog(json: &str) -> Result<CatalogDocument, String> {
    let catalog: CatalogDocument =
        serde_json::from_str(json).map_err(|error| format!("Agent Catalog JSON 非法: {error}"))?;
    if catalog.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(format!(
            "Agent Catalog schemaVersion 不支持: {}",
            catalog.schema_version
        ));
    }
    if catalog.providers.is_empty() {
        return Err("Agent Catalog providers 不能为空".into());
    }
    let mut providers = HashSet::new();
    let mut detector_ids = HashSet::new();
    for entry in &catalog.providers {
        validate_non_empty(&entry.provider, "provider")?;
        validate_non_empty(
            &entry.display_name,
            &format!("{}.displayName", entry.provider),
        )?;
        if entry.protocol != "acp" {
            return Err(format!(
                "Agent Catalog {}.protocol 必须是 acp",
                entry.provider
            ));
        }
        if !providers.insert(entry.provider.to_lowercase()) {
            return Err(format!("Agent Catalog provider 重复: {}", entry.provider));
        }
        validate_non_empty(
            &entry.detection.detector_id,
            &format!("{}.detection.detectorId", entry.provider),
        )?;
        if !detector_ids.insert(entry.detection.detector_id.clone()) {
            return Err(format!(
                "Agent Catalog detectorId 重复: {}",
                entry.detection.detector_id
            ));
        }
        if entry.detection.invocations.is_empty() {
            return Err(format!(
                "Agent Catalog {}.detection.invocations 不能为空",
                entry.provider
            ));
        }
        for invocation in &entry.detection.invocations {
            validate_non_empty(
                &invocation.command,
                &format!("{}.detection.invocation.command", entry.provider),
            )?;
        }
        for evidence in &entry.detection.config_evidence {
            validate_non_empty(
                &evidence.relative_path,
                &format!("{}.detection.configEvidence.relativePath", entry.provider),
            )?;
            let relative = std::path::Path::new(&evidence.relative_path);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err(format!(
                    "Agent Catalog {}.detection.configEvidence.relativePath 必须位于配置目录内",
                    entry.provider
                ));
            }
            if evidence.fields.is_empty()
                || evidence.fields.iter().any(|field| field.trim().is_empty())
            {
                return Err(format!(
                    "Agent Catalog {}.detection.configEvidence.fields 不能为空",
                    entry.provider
                ));
            }
        }
        let capabilities = &entry.capabilities;
        let _capability_shape = (
            capabilities.session_updates,
            capabilities.interaction_events,
            capabilities.permission_requests,
            capabilities.replay,
            &capabilities.response_methods,
            &entry.interaction_kinds,
        );
        let mut tools = HashSet::new();
        for tool in &entry.tools {
            validate_non_empty(&tool.name, &format!("{}.tool.name", entry.provider))?;
            if !tools.insert(tool.name.to_lowercase()) {
                return Err(format!(
                    "Agent Catalog tool 重复: {}/{}",
                    entry.provider, tool.name
                ));
            }
            if ![
                "read", "edit", "execute", "search", "fetch", "think", "other",
            ]
            .contains(&tool.kind.as_str())
            {
                return Err(format!(
                    "Agent Catalog tool kind 非法: {}/{}",
                    entry.provider, tool.name
                ));
            }
            if ![
                "read", "write", "edit", "search", "execute", "fetch", "navigate", "click", "type",
                "snapshot", "delegate", "plan", "skill", "unknown",
            ]
            .contains(&tool.action.as_str())
            {
                return Err(format!(
                    "Agent Catalog tool action 非法: {}/{}",
                    entry.provider, tool.name
                ));
            }
            if let Some(label) = tool.output_label.as_deref() {
                if !["lines", "matches", "changed-lines"].contains(&label) {
                    return Err(format!(
                        "Agent Catalog outputLabel 非法: {}/{}",
                        entry.provider, tool.name
                    ));
                }
            }
            let _presentation_shape = (&tool.aliases, &tool.display_name, &tool.summary_fields);
        }
    }
    Ok(catalog)
}

fn catalog() -> Result<&'static CatalogDocument, String> {
    match CATALOG.get_or_init(|| parse_catalog(CATALOG_JSON)) {
        Ok(catalog) => Ok(catalog),
        Err(error) => Err(error.clone()),
    }
}

pub fn detection_profiles() -> Result<Vec<AgentDetectionProfile>, String> {
    let mut profiles = catalog()?
        .providers
        .iter()
        .map(|entry| AgentDetectionProfile {
            detector_id: entry.detection.detector_id.clone(),
            provider: entry.provider.clone(),
            display_name: entry.display_name.clone(),
            priority: entry.detection.priority,
            invocations: entry.detection.invocations.clone(),
            config_dirs: entry.detection.config_dirs.clone(),
            config_evidence: entry.detection.config_evidence.clone(),
        })
        .collect::<Vec<_>>();
    // Stable sort preserves catalog order for equal-priority providers.
    profiles.sort_by(|left, right| right.priority.cmp(&left.priority));
    Ok(profiles)
}

pub fn provider_for_executable_stem(stem: &str) -> Result<Option<String>, String> {
    let stem = stem.trim().to_lowercase();
    Ok(catalog()?.providers.iter().find_map(|entry| {
        entry
            .detection
            .invocations
            .iter()
            .any(|invocation| invocation.command.eq_ignore_ascii_case(&stem))
            .then(|| entry.provider.clone())
    }))
}

pub fn set_model_api_default(provider: &str) -> Result<Option<CatalogSetModelApi>, String> {
    Ok(catalog()?
        .providers
        .iter()
        .find(|entry| entry.provider.eq_ignore_ascii_case(provider))
        .map(|entry| entry.protocol_defaults.set_model_api))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_catalog_is_valid_and_excludes_rpc_only_pi() {
        let catalog = parse_catalog(CATALOG_JSON).expect("shared catalog must remain valid");
        assert_eq!(catalog.schema_version, 1);
        assert_eq!(
            catalog
                .providers
                .iter()
                .map(|entry| entry.provider.as_str())
                .collect::<Vec<_>>(),
            ["peri", "hermes", "claude-code"]
        );
        assert!(catalog.providers.iter().all(|entry| entry.provider != "pi"));
    }

    #[test]
    fn catalog_drives_launch_aliases_and_protocol_baseline() {
        assert_eq!(
            provider_for_executable_stem("ccb").unwrap().as_deref(),
            Some("claude-code")
        );
        assert_eq!(
            provider_for_executable_stem("hermes-acp")
                .unwrap()
                .as_deref(),
            Some("hermes")
        );
        assert_eq!(
            set_model_api_default("hermes").unwrap(),
            Some(CatalogSetModelApi::SetModel)
        );
    }
}
