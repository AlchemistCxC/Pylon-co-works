//! Data-driven provider adaptation boundary (P62 A3).
//!
//! This module deliberately contains no provider switch. All policy values
//! originate in the shared catalog and reach consumers through the strong-typed
//! `PylonAgentProfile` projection: there is no generic "read this catalog field
//! as JSON" escape hatch, so a consumer cannot re-derive provider behaviour from
//! an untyped blob at the call site.

use pylon_core::agent_catalog::{
    self, CatalogAdapterRelation, CatalogBridgeId, CatalogClientCapabilities,
    CatalogInteractionBridge, PylonAgentProfile,
};
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

/// One provider's declared adaptation policy as a strong projection.
///
/// `Ok(None)` means the provider is not in the catalog at all; a declared
/// provider whose policy is malformed is an `Err`, never a silent absence.
pub fn profile(provider: &str) -> Result<Option<PylonAgentProfile>, String> {
    agent_catalog::provider_profile(provider)
}

pub fn client_capabilities(provider: &str, mut base: Value) -> Result<Value, String> {
    let Some(profile) = profile(provider)? else {
        return Ok(base);
    };
    let Some(declared) = profile.client_capabilities.as_ref() else {
        return Ok(base);
    };
    let Some(base_object) = base.as_object_mut() else {
        return Err("clientCapabilities base must be an object".into());
    };
    for (key, value) in declared.declarations() {
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

pub fn adapter_relation(provider: &str) -> Result<Option<CatalogAdapterRelation>, String> {
    Ok(profile(provider)?.and_then(|profile| profile.adapter_relation))
}

pub fn claude_policy(provider: &str) -> Result<Option<ClaudePolicy>, String> {
    let Some(profile) = profile(provider)? else {
        return Ok(None);
    };
    let Some(relation) = profile.adapter_relation.as_ref() else {
        return Ok(None);
    };
    let gate = profile
        .version_gates
        .iter()
        .find(|gate| gate.id == agent_catalog::CatalogVersionGateId::SteeringPromptRequired)
        .and_then(|gate| gate.min_version.clone())
        .ok_or("adaptation.versionGates.steeringPromptRequiredMinVersion missing")?;
    let capabilities: &CatalogClientCapabilities = profile
        .client_capabilities
        .as_ref()
        .ok_or("adaptation.clientCapabilities missing")?;
    let jetbrains_air_session_failure = capabilities
        .meta()
        .and_then(|meta| meta.get("jetbrains.air"))
        .and_then(Value::as_object)
        .and_then(|air| air.get("capabilities"))
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.as_str() == Some("sessionFailure"))
        });
    Ok(Some(ClaudePolicy {
        native_cmd: relation.native_cmd.clone(),
        native_label: relation.native_label.clone(),
        shared_config_dir: relation.shared_config_dir.clone(),
        steering_prompt_required_min_version: gate,
        subagent_transcript: capabilities.flag("subagent-transcript").unwrap_or(false),
        jetbrains_air_session_failure,
    }))
}

/// The catalog-declared bridge for `method`, or `None` when this provider's
/// catalog entry declares no such bridge.
///
/// A declaration can only NARROW what the closed parser seam accepts: a declared
/// method is still parsed by that same closed parser, and a method the catalog
/// omits is not fabricated here. A provider absent from the catalog (a private
/// protocol without a runtime owner) keeps its existing behaviour, which is why
/// this returns `None` rather than erroring.
pub fn interaction_bridge(provider: &str, method: &str) -> Result<Option<CatalogBridgeId>, String> {
    Ok(
        profile(provider)?
            .and_then(|profile| declared_bridge(&profile.interaction_bridges, method)),
    )
}

fn declared_bridge(bridges: &[CatalogInteractionBridge], method: &str) -> Option<CatalogBridgeId> {
    bridges
        .iter()
        .find(|bridge| bridge.method == method)
        .map(|bridge| bridge.parser)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_codeg_claude_policy_without_provider_branching() {
        let relation = adapter_relation("claude-code").unwrap().unwrap();
        assert_eq!(relation.native_cmd, "claude");
        let policy = claude_policy("claude-code").unwrap().unwrap();
        assert_eq!(policy.steering_prompt_required_min_version, "0.65.0");
    }

    #[test]
    fn undeclared_provider_is_empty_and_unknown_provider_fails_closed() {
        assert!(adapter_relation("missing").unwrap().is_none());
        assert!(claude_policy("missing").unwrap().is_none());
        // 只声明 sessionEstablishment 的 provider 不得凭空得到 wrapper/gate 策略。
        assert!(adapter_relation("peri").unwrap().is_none());
        assert!(claude_policy("peri").unwrap().is_none());
        assert!(interaction_bridge("peri", "_x.ai/ask_user_question")
            .unwrap()
            .is_none());
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
    fn provider_without_declared_capabilities_keeps_the_base_object() {
        let base = serde_json::json!({"fs": {"readTextFile": true}});
        let result = client_capabilities("hermes", base.clone()).unwrap();
        assert_eq!(result, base);
    }

    #[test]
    fn projects_declared_claude_policy_into_closed_shape() {
        let policy = claude_policy("claude-code").unwrap().unwrap();
        assert_eq!(policy.native_cmd, "claude");
        assert_eq!(policy.native_label, "Claude Code CLI");
        assert_eq!(policy.shared_config_dir, "~/.claude");
        assert_eq!(policy.steering_prompt_required_min_version, "0.65.0");
        assert!(policy.subagent_transcript && policy.jetbrains_air_session_failure);
    }

    /// A3 验收：未知 bridge 名在 catalog 边界即失败（而不是在调用点被忽略）。
    #[test]
    fn unknown_bridge_names_fail_closed_at_the_catalog_boundary() {
        assert!(
            serde_json::from_value::<CatalogInteractionBridge>(serde_json::json!({
                "method": "future/method",
                "parser": "future_bridge"
            }))
            .is_err()
        );
        let bridge: CatalogInteractionBridge = serde_json::from_value(serde_json::json!({
            "method": "pi/select_ask",
            "parser": "pi_select_ask"
        }))
        .unwrap();
        assert_eq!(bridge.parser, CatalogBridgeId::PiSelectAsk);
    }

    /// 声明只能“收窄”：未声明的方法不得被推断成任何 bridge。
    #[test]
    fn bridge_declaration_can_only_narrow_the_allowed_set() {
        let bridges = vec![
            CatalogInteractionBridge {
                method: "_x.ai/ask_user_question".into(),
                parser: CatalogBridgeId::GrokExtQuestions,
            },
            CatalogInteractionBridge {
                method: "pi/select_ask".into(),
                parser: CatalogBridgeId::PiSelectAsk,
            },
        ];
        assert_eq!(
            declared_bridge(&bridges, "pi/select_ask"),
            Some(CatalogBridgeId::PiSelectAsk)
        );
        assert_eq!(declared_bridge(&bridges, "_x.ai/exit_plan_mode"), None);
        assert_eq!(declared_bridge(&[], "pi/select_ask"), None);
    }
}
