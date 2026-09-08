//! Data-driven provider adaptation boundary.
//!
//! This module deliberately contains no provider switch.  All policy values
//! originate in the shared catalog; consumers validate their own closed
//! strategy enums at the edge where they are used.

use pylon_core::agent_catalog::{self, CatalogAdaptation};
use serde_json::Value;

pub fn policy(provider: &str) -> Result<Option<CatalogAdaptation>, String> {
    agent_catalog::adaptation(provider)
}

pub fn field(provider: &str, field: &str) -> Result<Option<Value>, String> {
    let adaptation = policy(provider)?;
    let Some(adaptation) = adaptation else { return Ok(None) };
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
    let Some(extra) = field(provider, "clientCapabilities")? else { return Ok(base) };
    let (Some(base_object), Some(extra_object)) = (base.as_object_mut(), extra.as_object()) else {
        return Err("clientCapabilities adaptation must be an object".into());
    };
    for (key, value) in extra_object {
        if key == "_meta" || key == "meta" {
            let base_meta = base_object.entry("_meta").or_insert_with(|| Value::Object(Default::default()));
            let (Some(base_meta), Some(extra_meta)) = (base_meta.as_object_mut(), value.as_object()) else {
                return Err("clientCapabilities._meta adaptation must be an object".into());
            };
            base_meta.extend(extra_meta.clone());
        } else {
            base_object.insert(key.clone(), value.clone());
        }
    }
    Ok(base)
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
        let result = client_capabilities("claude-code", serde_json::json!({"_meta": {"peri.replay": true}})).unwrap();
        assert_eq!(result["_meta"]["peri.replay"], true);
        assert_eq!(result["_meta"]["subagent-transcript"], true);
    }
}
