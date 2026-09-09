//! Catalog-driven preflight checks migrated from codeg's `acp/preflight.rs`.
//! Actions are descriptions only; this module never installs or mutates state.
use crate::agent_catalog::{self, CatalogCheckKind, CatalogFixKind};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FixAction {
    pub kind: String,
    pub payload: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum CheckStatus {
    Pass,
    Fail,
    Warn,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub check_id: String,
    pub label: String,
    pub status: CheckStatus,
    pub message: String,
    pub fixes: Vec<FixAction>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub provider: String,
    pub passed: bool,
    pub checks: Vec<CheckItem>,
}

#[derive(Debug, Clone, Default)]
pub struct PreflightInputs {
    pub node_version: Option<String>,
    pub uv_version: Option<String>,
    pub binary_present: bool,
    pub adapter_present: bool,
    pub config_evidence: bool,
}

fn version_at_least(actual: Option<&str>, minimum: Option<&str>) -> bool {
    match (
        actual.and_then(parse_node_version),
        minimum.and_then(parse_node_version),
    ) {
        (Some(current), Some(required)) => current >= required,
        _ => false,
    }
}

// Source: acp/preflight.rs::parse_node_version, locked source in ORIGIN.md.
fn parse_node_version(v: &str) -> Option<(u32, u32, u32)> {
    let v = v.trim().trim_start_matches('v');
    let mut parts = v.splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch_str = parts.next()?;
    let patch_digits: String = patch_str
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let patch = patch_digits.parse().ok()?;
    Some((major, minor, patch))
}

pub fn evaluate(provider: &str, inputs: &PreflightInputs) -> Result<PreflightResult, String> {
    let rule = agent_catalog::detection_profiles()?
        .into_iter()
        .find(|r| r.provider == provider)
        .ok_or_else(|| format!("unknown provider: {provider}"))?;
    let checks = rule
        .checks
        .iter()
        .map(|check| {
            let (status, message) = match check.kind {
                CatalogCheckKind::NodeMin => (
                    if version_at_least(
                        inputs.node_version.as_deref(),
                        check.params.get("min").and_then(|v| v.as_str()),
                    ) {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Fail
                    },
                    "Node.js version",
                ),
                CatalogCheckKind::UvMin => (
                    if version_at_least(
                        inputs.uv_version.as_deref(),
                        check.params.get("min").and_then(|v| v.as_str()),
                    ) {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Warn
                    },
                    "uv version",
                ),
                CatalogCheckKind::BinaryPresent => (
                    if inputs.binary_present {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Fail
                    },
                    "native binary",
                ),
                CatalogCheckKind::AdapterPresent => (
                    if inputs.adapter_present {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Fail
                    },
                    "ACP adapter",
                ),
                CatalogCheckKind::ConfigEvidence => (
                    if inputs.config_evidence {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Fail
                    },
                    "configuration evidence",
                ),
            };
            let fixes = if status == CheckStatus::Pass {
                Vec::new()
            } else {
                check
                    .fix
                    .iter()
                    .map(|fix| FixAction {
                        kind: match fix.kind {
                            CatalogFixKind::OpenUrl => "open-url",
                            CatalogFixKind::InstallAdapter => "install-adapter",
                            CatalogFixKind::InstallUv => "install-uv",
                        }
                        .into(),
                        payload: fix.payload.clone(),
                    })
                    .collect()
            };
            CheckItem {
                check_id: check.id.clone(),
                label: check.label.clone(),
                status,
                message: message.into(),
                fixes,
            }
        })
        .collect::<Vec<_>>();
    Ok(PreflightResult {
        provider: provider.into(),
        passed: checks.iter().all(|c| c.status == CheckStatus::Pass),
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_or_missing_versions_cannot_pass_a_requirement() {
        for actual in [
            None,
            Some(""),
            Some("invalid"),
            Some("22.12"),
            Some("22.bad.0"),
        ] {
            assert!(!version_at_least(actual, Some("0.0.0")));
        }
        assert!(!version_at_least(Some("22.12.0"), None));
        assert!(!version_at_least(Some("22.12.0"), Some("invalid")));
    }
    #[test]
    fn upstream_parser_accepts_banner_whitespace_and_patch_suffixes() {
        assert_eq!(parse_node_version(" v22.12.3+build "), Some((22, 12, 3)));
        assert_eq!(parse_node_version("v22.0.0-nightly"), Some((22, 0, 0)));
        assert!(version_at_least(Some("v22.12.3+build"), Some("22.12.3")));
    }
    #[test]
    fn unknown_provider_fails_closed() {
        assert!(evaluate("missing", &PreflightInputs::default()).is_err());
    }
    #[test]
    fn version_gate_is_semver_ordered() {
        assert!(version_at_least(Some("22.12.1"), Some("22.12.0")));
        assert!(!version_at_least(Some("20.0.0"), Some("22.0.0")));
    }

    #[test]
    fn catalog_checks_project_node_fail_and_uv_warn_without_install_side_effects() {
        let result = evaluate(
            "claude-code",
            &PreflightInputs {
                node_version: Some("20.0.0".into()),
                uv_version: None,
                binary_present: true,
                adapter_present: true,
                config_evidence: false,
            },
        )
        .unwrap();
        assert!(!result.passed);
        assert!(result
            .checks
            .iter()
            .any(|check| check.status == CheckStatus::Fail));
        assert!(result
            .checks
            .iter()
            .any(|check| check.status == CheckStatus::Warn));
    }
}
