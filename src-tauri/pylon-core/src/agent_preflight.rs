//! Catalog-driven preflight checks migrated from codeg's `acp/preflight.rs`.
//! Actions are descriptions only; this module never installs or mutates state.
use crate::agent_catalog::{self, CatalogCheckKind, CatalogFixKind};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FixAction { pub kind: String, pub payload: String }

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum CheckStatus { Pass, Fail, Warn }

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem { pub check_id: String, pub label: String, pub status: CheckStatus, pub message: String, pub fixes: Vec<FixAction> }

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult { pub provider: String, pub passed: bool, pub checks: Vec<CheckItem> }

#[derive(Debug, Clone, Default)]
pub struct PreflightInputs { pub node_version: Option<String>, pub uv_version: Option<String>, pub binary_present: bool, pub adapter_present: bool, pub config_evidence: bool }

fn version_at_least(actual: Option<&str>, minimum: Option<&str>) -> bool {
    let Some(minimum) = minimum else { return true };
    let parse = |v: &str| v.trim_start_matches('v').split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let a = parse(actual.unwrap_or("")); let b = parse(minimum);
    (0..a.len().max(b.len())).map(|i| (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0))).find(|(x,y)| x != y).map_or(true, |(x,y)| x > y)
}

pub fn evaluate(provider: &str, inputs: &PreflightInputs) -> Result<PreflightResult, String> {
    let rule = agent_catalog::detection_profiles()?.into_iter().find(|r| r.provider == provider).ok_or_else(|| format!("unknown provider: {provider}"))?;
    let checks = rule.checks.iter().map(|check| {
        let (ok, message) = match check.kind {
            CatalogCheckKind::NodeMin => (version_at_least(inputs.node_version.as_deref(), check.params.get("min").and_then(|v| v.as_str())), "Node.js version"),
            CatalogCheckKind::UvMin => (version_at_least(inputs.uv_version.as_deref(), check.params.get("min").and_then(|v| v.as_str())), "uv version"),
            CatalogCheckKind::BinaryPresent => (inputs.binary_present, "native binary"),
            CatalogCheckKind::AdapterPresent => (inputs.adapter_present, "ACP adapter"),
            CatalogCheckKind::ConfigEvidence => (inputs.config_evidence, "configuration evidence"),
        };
        let fixes = if ok { Vec::new() } else { check.fix.iter().map(|fix| FixAction { kind: match fix.kind { CatalogFixKind::OpenUrl => "open-url", CatalogFixKind::InstallAdapter => "install-adapter", CatalogFixKind::InstallUv => "install-uv" }.into(), payload: fix.payload.clone() }).collect() };
        CheckItem { check_id: check.id.clone(), label: check.label.clone(), status: if ok { CheckStatus::Pass } else { CheckStatus::Fail }, message: message.into(), fixes }
    }).collect::<Vec<_>>();
    Ok(PreflightResult { provider: provider.into(), passed: checks.iter().all(|c| c.status == CheckStatus::Pass), checks })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn unknown_provider_fails_closed() { assert!(evaluate("missing", &PreflightInputs::default()).is_err()); }
    #[test] fn version_gate_is_semver_ordered() { assert!(version_at_least(Some("22.12.1"), Some("22.12.0"))); assert!(!version_at_least(Some("20.0.0"), Some("22.0.0"))); }
}
