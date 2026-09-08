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
}
