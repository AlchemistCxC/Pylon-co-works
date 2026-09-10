//! Data-driven provider adaptation boundary.
//!
//! This module deliberately contains no provider switch.  All policy values
//! originate in the shared catalog; consumers validate their own closed
//! strategy enums at the edge where they are used.

use pylon_core::agent_catalog::{self, CatalogAdaptation};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudePolicy {
    pub native_cmd: String,
    pub native_label: String,
    pub shared_config_dir: String,
    pub steering_prompt_required_min_version: String,
    pub subagent_transcript: bool,
    pub jetbrains_air_session_failure: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterRelation {
    pub native_cmd: String,
    pub native_label: String,
    pub shared_config_dir: String,
    pub extra_dirs: Vec<String>,
    pub docs_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeId {
    GrokExtQuestions,
    PiSelectAsk,
    GrokExitPlan,
    CodexElicitation,
}

fn bridge_id(value: &str) -> Result<BridgeId, String> {
    match value {
        "grok_ext_questions" => Ok(BridgeId::GrokExtQuestions),
        "pi_select_ask" => Ok(BridgeId::PiSelectAsk),
        "grok_exit_plan" => Ok(BridgeId::GrokExitPlan),
        "codex_elicitation" => Ok(BridgeId::CodexElicitation),
        other => Err(format!("unknown interaction bridge: {other}")),
    }
}

pub fn policy(provider: &str) -> Result<Option<CatalogAdaptation>, String> {
    agent_catalog::adaptation(provider)
}

pub fn field(provider: &str, field: &str) -> Result<Option<Value>, String> {
    let adaptation = policy(provider)?;
    let Some(adaptation) = adaptation else {
        return Ok(None);
    };
    let value = match field {
        "adapterRelation" => adaptation.adapter_relation,
        "clientCapabilities" => adaptation.client_capabilities,
        "promptCapabilities" => adaptation.prompt_capabilities,
        "launchEnv" => adaptation.launch_env,
        "versionGates" => adaptation.version_gates,
        "sessionEstablishment" => adaptation.session_establishment,
        "configAdaptation" => adaptation.config_adaptation,
        "mcp" => adaptation.mcp,
        "interactionBridges" => adaptation.interaction_bridges,
        _ => return Err(format!("unknown adaptation field: {field}")),
    };
    Ok(value)
}

pub fn client_capabilities(provider: &str, mut base: Value) -> Result<Value, String> {
    let Some(extra) = field(provider, "clientCapabilities")? else {
        return Ok(base);
    };
    let (Some(base_object), Some(extra_object)) = (base.as_object_mut(), extra.as_object()) else {
        return Err("clientCapabilities adaptation must be an object".into());
    };
    for (key, value) in extra_object {
        if key == "_meta" || key == "meta" {
            let base_meta = base_object
                .entry("_meta")
                .or_insert_with(|| Value::Object(Default::default()));
            let (Some(base_meta), Some(extra_meta)) =
                (base_meta.as_object_mut(), value.as_object())
            else {
                return Err("clientCapabilities._meta adaptation must be an object".into());
            };
            base_meta.extend(extra_meta.clone());
        } else {
            base_object.insert(key.clone(), value.clone());
        }
    }
    Ok(base)
}

pub fn adapter_relation(provider: &str) -> Result<Option<AdapterRelation>, String> {
    let Some(value) = field(provider, "adapterRelation")? else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or("adapterRelation must be an object")?;
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("adapterRelation.{key} missing"))
    };
    let extra_dirs = object
        .get("extraDirs")
        .and_then(Value::as_array)
        .ok_or("adapterRelation.extraDirs missing")?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or("adapterRelation.extraDirs entry must be string")
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(AdapterRelation {
        native_cmd: text("nativeCmd")?,
        native_label: text("nativeLabel")?,
        shared_config_dir: text("sharedConfigDir")?,
        extra_dirs,
        docs_url: object
            .get("docsUrl")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }))
}

pub fn claude_policy(provider: &str) -> Result<Option<ClaudePolicy>, String> {
    let Some(policy) = policy(provider)? else {
        return Ok(None);
    };
    let relation = adapter_relation(provider)?.ok_or("adaptation.adapterRelation missing")?;
    let gates = policy
        .version_gates
        .ok_or("adaptation.versionGates missing")?;
    let caps = policy
        .client_capabilities
        .ok_or("adaptation.clientCapabilities missing")?;
    let string_field = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("adaptation field {key} missing"))
    };
    let meta = caps
        .get("meta")
        .ok_or("adaptation.clientCapabilities.meta missing")?;
    let air = meta.get("jetbrains.air").and_then(Value::as_object);
    Ok(Some(ClaudePolicy {
        native_cmd: relation.native_cmd,
        native_label: relation.native_label,
        shared_config_dir: relation.shared_config_dir,
        steering_prompt_required_min_version: string_field(
            &gates,
            "steeringPromptRequiredMinVersion",
        )?,
        subagent_transcript: meta
            .get("subagent-transcript")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        jetbrains_air_session_failure: air.is_some_and(|value| {
            value
                .get("capabilities")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item.as_str() == Some("sessionFailure"))
                })
        }),
    }))
}

pub fn interaction_bridge(provider: &str, method: &str) -> Result<Option<BridgeId>, String> {
    let Some(policy) = policy(provider)? else {
        return Ok(None);
    };
    let Some(bridges) = policy.interaction_bridges else {
        return Ok(None);
    };
    let Some(items) = bridges.as_array() else {
        return Err("interactionBridges must be an array".into());
    };
    for item in items {
        let object = item
            .as_object()
            .ok_or("interaction bridge must be an object")?;
        if object.get("method").and_then(Value::as_str) == Some(method) {
            let parser = object
                .get("parser")
                .and_then(Value::as_str)
                .ok_or("interaction bridge parser missing")?;
            return Ok(Some(bridge_id(parser)?));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_codeg_claude_policy_without_provider_branching() {
        let relation = field("claude-code", "adapterRelation").unwrap().unwrap();
        assert_eq!(relation["nativeCmd"], "claude");
        let gates = field("claude-code", "versionGates").unwrap().unwrap();
        assert_eq!(gates["steeringPromptRequiredMinVersion"], "0.65.0");
    }

    #[test]
    fn empty_provider_is_empty_and_unknown_field_fails_closed() {
        assert!(policy("peri").unwrap().is_none());
        assert!(field("claude-code", "providerSpecificHack").is_err());
    }

    #[test]
    fn client_capabilities_merge_preserves_default_meta() {
        let result = client_capabilities(
            "claude-code",
            serde_json::json!({"_meta": {"peri.replay": true}}),
        )
        .unwrap();
        assert_eq!(result["_meta"]["peri.replay"], true);
        assert_eq!(result["_meta"]["subagent-transcript"], true);
    }

    #[test]
    fn projects_declared_claude_policy_into_closed_shape() {
        let policy = claude_policy("claude-code").unwrap().unwrap();
        assert_eq!(policy.native_cmd, "claude");
        assert_eq!(policy.steering_prompt_required_min_version, "0.65.0");
        assert!(policy.subagent_transcript && policy.jetbrains_air_session_failure);
    }

    #[test]
    fn unknown_bridge_names_fail_closed() {
        assert!(bridge_id("future_bridge").is_err());
        assert_eq!(
            interaction_bridge("peri", "_x.ai/ask_user_question").unwrap(),
            None
        );
    }
}
