//! Catalog-driven preflight checks migrated from codeg's `acp/preflight.rs`.
//! Actions are descriptions only; this module never installs or mutates state.
use crate::agent_catalog::{
    self, AgentDetectionProfile, CatalogCheckKind, CatalogFixKind, CatalogVersionEvidence,
    CatalogVersionGate, CatalogVersionGateId,
};
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
    /// Stable provider-level outcome. A consumer may branch on this without
    /// re-deriving meaning from individual check statuses.
    pub status: PreflightStatus,
    /// True only for `installed`: the ACP entry point is present and the
    /// declared version gate (if any) is satisfied.
    pub passed: bool,
    /// Adapter-vs-vendor-CLI explainer, present only for wrapper providers.
    pub adapter: Option<AdapterEvidence>,
    pub checks: Vec<CheckItem>,
}

/// A1 稳定状态。新增值必须同时出现在 `detect`/`adapterMissing` 矩阵测试里。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PreflightStatus {
    /// Wrapper provider whose ACP entry point exists but whose vendor CLI was not
    /// found.
    ///
    /// **Informational, not blocking** — that is the A5① decision, and the reason
    /// is that the migrated Codeg relation is not always a real dependency:
    /// Pylon's `claude-code` entry is `ccb`, not the npm adapter Codeg's
    /// `nativeCmd: "claude"` was written for, and this host runs that
    /// configuration today. Treating the relation as a gate would report a working
    /// setup as broken and make Pylon (which is not Codeg's adapter installer)
    /// demand an install the user may not need. Whether a wrapper can really speak
    /// ACP is proven by the connection test, never by the presence of a second
    /// CLI; the launch planner keeps starting the ACP entry and records this only
    /// as a diagnostic. A vendor CLI that is genuinely a hard dependency belongs
    /// in that provider's own `checks`, not in this state.
    NativeMissing,
    /// Wrapper provider whose vendor CLI was found but whose ACP adapter was not.
    /// This one IS actionable: nothing exists that can speak ACP.
    AdapterMissing,
    /// ACP entry point present, declared version gate satisfied.
    Installed,
    /// ACP entry point present but its observed version is below the declared floor.
    VersionTooOld,
    /// No executable, but the provider's shared config dir exists.
    ConfigOnly,
    /// Nothing that could be launched or configured was found. The 施工书 lists
    /// the five states above plus “等”; this keeps the mapping total so a bare
    /// machine is never reported as one of the more specific states.
    NotInstalled,
}

/// Wrapper evidence: the vendor CLI the user installs themselves and the ACP
/// adapter Pylon launches. Deliberately structured, no prose — the frontend owns
/// the wording, and detection already reports the paths.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdapterEvidence {
    pub native_cmd: String,
    pub native_label: String,
    pub native_present: bool,
    pub acp_present: bool,
    pub shared_config_dir: String,
    /// Presence only; the directory itself may hold credentials.
    pub shared_config_present: bool,
    pub docs_url: Option<String>,
}

/// Observed state of a tool a provider's launch depends on (Node.js, uv).
///
/// A two-state `Option<String>` cannot express the real distinction the source
/// makes: "we looked and the tool is not installed" is a hard failure, while
/// "the tool is there but we could not read its version" is not. Collapsing them
/// would either fabricate a violation or hide a genuine one.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "version")]
pub enum ToolVersion {
    /// The tool's executable was not found. A provider requiring it cannot run.
    Absent,
    /// The executable was found but its version could not be read (probe failed,
    /// timed out, exited non-zero, or printed nothing version-shaped).
    ///
    /// This is the `Default` on purpose: a caller that never probed must not
    /// claim either "absent" (a fabricated failure) or a satisfying version (a
    /// fabricated pass).
    #[default]
    Unknown,
    Known(String),
}

#[derive(Debug, Clone, Default)]
pub struct PreflightInputs {
    pub node: ToolVersion,
    pub uv: ToolVersion,
    /// Native/vendor executable evidence (catalog `binary-present`).
    pub binary_present: bool,
    /// ACP adapter executable evidence; for a wrapper provider this is the ACP
    /// entry point the launch planner starts.
    pub adapter_present: bool,
    /// The ACP entry point this provider launches. Equal to `binary_present` for
    /// a provider with no adapter relation.
    pub acp_present: bool,
    /// The vendor CLI a wrapper's adapter delegates to. Always false when the
    /// provider declares no adapter relation, because nothing is probed.
    pub native_present: bool,
    pub config_evidence: bool,
    /// Presence of the adapter relation's shared config/credential dir. Presence
    /// only: the directory may hold credentials and is never read here.
    pub shared_config_present: bool,
    /// Observed version of the ACP entry point, from the bounded version probe.
    /// A declared `minVersion` gate is only satisfied when this is present and
    /// parseable — an unreadable version never proves the floor.
    pub adapter_version: Option<String>,
}

/// Evaluate one runtime requirement against observed tool evidence.
///
/// Mirrors the Codeg source (`acp/preflight.rs::build_node_version_check`): a
/// definitively missing tool FAILS, an unreadable version WARNS, and an observed
/// version is compared against the declared minimum. The message states the
/// observed fact, never a guess.
fn required_tool_status(
    tool: &ToolVersion,
    minimum: Option<&str>,
    label: &str,
) -> (CheckStatus, String) {
    // No declared floor means there is nothing to violate. Returning Fail here
    // would fabricate a violation out of an absent requirement, so the check is
    // explicitly vacuous instead. (Unreachable from the catalog path, where a
    // check is only synthesized when a minimum is declared — this keeps the pure
    // function total and honest for any other caller.)
    let Some(minimum) = minimum else {
        return (CheckStatus::Pass, format!("{label} 未声明下限"));
    };
    match tool {
        ToolVersion::Absent => (
            CheckStatus::Fail,
            format!("未检测到 {label}（需要 >= {minimum}）"),
        ),
        ToolVersion::Unknown => (
            CheckStatus::Warn,
            format!("无法读取 {label} 版本（需要 >= {minimum}）"),
        ),
        ToolVersion::Known(version) => {
            if version_at_least(Some(version), Some(minimum)) {
                (
                    CheckStatus::Pass,
                    format!("{label} {version} 满足 >= {minimum}"),
                )
            } else {
                (
                    CheckStatus::Fail,
                    format!("{label} {version} 低于要求的 >= {minimum}"),
                )
            }
        }
    }
}

/// Pure, total mapping from evidence to the stable provider status.
///
/// Kept separate from `evaluate` so every state has a deterministic fixture and
/// a consumer can classify a report it already holds.
pub fn classify(
    adapter_relation_declared: bool,
    acp_present: bool,
    native_present: bool,
    config_present: bool,
    version_too_old: bool,
) -> PreflightStatus {
    if acp_present {
        if version_too_old {
            return PreflightStatus::VersionTooOld;
        }
        if adapter_relation_declared && !native_present {
            return PreflightStatus::NativeMissing;
        }
        return PreflightStatus::Installed;
    }
    if native_present {
        return PreflightStatus::AdapterMissing;
    }
    if config_present {
        return PreflightStatus::ConfigOnly;
    }
    PreflightStatus::NotInstalled
}

fn version_gate_id(gate: &CatalogVersionGate) -> &'static str {
    match gate.id {
        CatalogVersionGateId::SteeringPromptRequired => "steering-prompt-required",
        CatalogVersionGateId::GoalControlOutOfBand => "goal-control-out-of-band",
        CatalogVersionGateId::CursorAcpBackend => "cursor-acp-backend",
    }
}

fn version_gate_evidence_label(gate: &CatalogVersionGate) -> &'static str {
    match gate.evidence {
        CatalogVersionEvidence::AdapterAgentInfoVersion => "adapter version",
        CatalogVersionEvidence::LaunchRecipe => "launch recipe",
        CatalogVersionEvidence::StaticPolicy => "static policy",
    }
}

/// Version comparison shared with `agent_detection`'s version-gate diagnostics.
/// Missing or unparseable input never satisfies a requirement.
pub fn version_at_least(actual: Option<&str>, minimum: Option<&str>) -> bool {
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

/// Checks derived from the catalog's declared version gates.
///
/// Catalog `checks` are optional data a provider may leave empty; declared
/// gates are a contract, so they always become visible checks. Only the
/// adapter-version evidence source can be evaluated from a local probe — the
/// others are recipe or policy facts and contribute no version comparison.
fn version_gate_checks(rule: &AgentDetectionProfile, inputs: &PreflightInputs) -> Vec<CheckItem> {
    rule.version_gates
        .iter()
        .filter_map(|gate| {
            let minimum = gate.min_version.as_deref()?;
            let label = version_gate_evidence_label(gate);
            let status = match gate.evidence {
                CatalogVersionEvidence::AdapterAgentInfoVersion => {
                    match inputs.adapter_version.as_deref() {
                        Some(version) if version_at_least(Some(version), Some(minimum)) => {
                            CheckStatus::Pass
                        }
                        Some(_) => CheckStatus::Fail,
                        None => CheckStatus::Warn,
                    }
                }
                CatalogVersionEvidence::LaunchRecipe | CatalogVersionEvidence::StaticPolicy => {
                    if gate.enabled {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Warn
                    }
                }
            };
            Some(CheckItem {
                check_id: format!("version-gate:{}", version_gate_id(gate)),
                label: label.to_string(),
                status,
                message: format!("{label} >= {minimum}"),
                fixes: Vec::new(),
            })
        })
        .collect()
}

pub fn evaluate(provider: &str, inputs: &PreflightInputs) -> Result<PreflightResult, String> {
    let rule = agent_catalog::detection_profiles()?
        .into_iter()
        .find(|r| r.provider == provider)
        .ok_or_else(|| format!("unknown provider: {provider}"))?;
    let gate_checks = version_gate_checks(&rule, inputs);
    let checks = rule
        .checks
        .iter()
        .map(|check| {
            let (status, message) = match check.kind {
                CatalogCheckKind::NodeMin => required_tool_status(
                    &inputs.node,
                    check.params.get("min").and_then(|v| v.as_str()),
                    "Node.js",
                ),
                CatalogCheckKind::UvMin => required_tool_status(
                    &inputs.uv,
                    check.params.get("min").and_then(|v| v.as_str()),
                    "uv",
                ),
                CatalogCheckKind::BinaryPresent => (
                    if inputs.binary_present {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Fail
                    },
                    "native binary".to_string(),
                ),
                CatalogCheckKind::AdapterPresent => (
                    if inputs.adapter_present {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Fail
                    },
                    "ACP adapter".to_string(),
                ),
                CatalogCheckKind::ConfigEvidence => (
                    if inputs.config_evidence {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Fail
                    },
                    "configuration evidence".to_string(),
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
                message,
                fixes,
            }
        })
        .chain(gate_checks.iter().cloned())
        .collect::<Vec<_>>();
    // A `minVersion` gate is evaluated against the adapter's observed version.
    // An unreadable version is `unknown`, not a silent pass: the floor can only
    // be proven by evidence, and only a proven violation forces `versionTooOld`.
    let version_too_old = gate_checks
        .iter()
        .any(|check| check.status == CheckStatus::Fail);
    let status = classify(
        rule.adapter_relation.is_some(),
        inputs.acp_present,
        inputs.native_present,
        inputs.shared_config_present || inputs.config_evidence,
        version_too_old,
    );
    let adapter = rule
        .adapter_relation
        .as_ref()
        .map(|relation| AdapterEvidence {
            native_cmd: relation.native_cmd.clone(),
            native_label: relation.native_label.clone(),
            native_present: inputs.native_present,
            acp_present: inputs.acp_present || inputs.adapter_present,
            shared_config_dir: relation.shared_config_dir.clone(),
            shared_config_present: inputs.shared_config_present,
            docs_url: relation.docs_url.clone(),
        });
    Ok(PreflightResult {
        provider: provider.into(),
        status,
        // `passed` means "everything this provider needs is satisfied": the
        // install state is `installed` AND no required check failed. A failed
        // required runtime (e.g. Node too old) therefore cannot be reported as a
        // passing preflight while the status stays about installation.
        passed: status == PreflightStatus::Installed
            && checks.iter().all(|check| check.status != CheckStatus::Fail),
        adapter,
        checks,
    })
}

/// Build the preflight result for one provider from detector output.
///
/// One shared mapping for both consumers (the `pylon-detect` CLI and the
/// settings panel): computing it twice is exactly how a settings page ends up
/// with a second, drifting candidate/preflight set.
pub fn from_detection(
    evidence: &crate::agent_detection::AgentProviderEvidence,
    candidates: &[crate::agent_detection::AgentRuntimeCandidate],
) -> Result<PreflightResult, String> {
    let acp_present = !evidence.acp_commands.is_empty();
    let native_present = !evidence.native_commands.is_empty();
    let provider_candidates: Vec<_> = candidates
        .iter()
        .filter(|candidate| candidate.provider == evidence.provider)
        .collect();
    let config_evidence = provider_candidates.iter().any(|candidate| {
        candidate
            .evidence
            .iter()
            .any(|item| item.kind == "config-fields")
    });
    let adapter_version = provider_candidates.iter().find_map(|candidate| {
        candidate
            .evidence
            .iter()
            .find(|item| item.kind == "version")
            .map(|item| item.detail.clone())
    });
    evaluate(
        &evidence.provider,
        &PreflightInputs {
            // A wrapper's "binary" is the vendor CLI it wraps; a native ACP
            // provider's entry point and ACP command are the same executable.
            binary_present: if evidence.adapter_relation_declared {
                native_present
            } else {
                acp_present
            },
            adapter_present: acp_present,
            acp_present,
            native_present,
            config_evidence,
            shared_config_present: evidence.shared_config_present,
            // Node/uv come from the machine-level probe. The direct executable
            // probe wins the adapter version; npm global metadata is the fallback
            // the probe cannot supply.
            node: evidence.node.clone(),
            uv: evidence.uv.clone(),
            adapter_version: adapter_version.or_else(|| evidence.adapter_version.clone()),
        },
    )
}

/// Actionable, locale-free reason code for a non-installed status.
///
/// The frontend owns the wording; this is the closed vocabulary it switches on,
/// so a new state cannot reach the UI as an untranslated mystery.
pub fn action_code(status: PreflightStatus) -> &'static str {
    match status {
        PreflightStatus::Installed => "none",
        PreflightStatus::AdapterMissing => "install-acp-adapter",
        PreflightStatus::NativeMissing => "install-vendor-cli",
        PreflightStatus::VersionTooOld => "upgrade-acp-adapter",
        PreflightStatus::ConfigOnly => "provide-executable",
        PreflightStatus::NotInstalled => "install-agent",
    }
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
    /// A4：设置页与 CLI 消费同一份映射（同一 provider 证据 → 同一 PreflightResult）。
    #[test]
    fn detection_evidence_maps_to_one_shared_preflight_result() {
        use crate::agent_detection::{
            AgentDetectionEvidence, AgentProviderEvidence, AgentRuntimeCandidate,
            IdentityConfidence, ProtocolAvailability, Startability,
        };
        let evidence =
            |acp: &[&str], native: &[&str], declared: bool, shared: bool| AgentProviderEvidence {
                provider: "claude-code".into(),
                detector_id: "builtin.detector.claude-code".into(),
                adapter_relation_declared: declared,
                acp_commands: acp
                    .iter()
                    .map(|path| crate::agent_detection::AgentEvidenceHit {
                        kind: "acp-command".into(),
                        path: (*path).to_string(),
                        source: "path".into(),
                    })
                    .collect(),
                native_commands: native
                    .iter()
                    .map(|path| crate::agent_detection::AgentEvidenceHit {
                        kind: "native-command".into(),
                        path: (*path).to_string(),
                        source: "known-path".into(),
                    })
                    .collect(),
                shared_config_present: shared,
                // These two callers exercise install-state mapping only, so the
                // machine-level tool evidence stays at "not measured" — the
                // Default that must not claim absent or a version.
                node: crate::agent_preflight::ToolVersion::default(),
                uv: crate::agent_preflight::ToolVersion::default(),
                adapter_version: None,
            };
        let candidate = |version: Option<&str>| AgentRuntimeCandidate {
            candidate_id: "c".into(),
            detector_id: "builtin.detector.claude-code".into(),
            provider: "claude-code".into(),
            suggested_agent_id: "claude-code".into(),
            name: "Claude Code".into(),
            executable: "ccb".into(),
            args: vec!["--acp".into()],
            evidence: version
                .map(|version| {
                    vec![AgentDetectionEvidence {
                        kind: "version".into(),
                        detail: version.to_string(),
                    }]
                })
                .unwrap_or_default(),
            identity_confidence: IdentityConfidence::Medium,
            startability: Startability::NotTested,
            protocol_availability: ProtocolAvailability::NotTested,
            already_imported_agent_id: None,
            warnings: Vec::new(),
        };

        // wrapper 在、vendor CLI 不在（本机真实状态）→ nativeMissing + 可行动码
        let result = from_detection(
            &evidence(&["C:/x/ccb.cmd"], &[], true, true),
            &[candidate(Some("0.75.1"))],
        )
        .unwrap();
        assert_eq!(result.status, PreflightStatus::NativeMissing);
        assert_eq!(action_code(result.status), "install-vendor-cli");

        // vendor CLI 在、wrapper 不在 → adapterMissing
        let result = from_detection(&evidence(&[], &["C:/x/claude.exe"], true, true), &[]).unwrap();
        assert_eq!(result.status, PreflightStatus::AdapterMissing);
        assert_eq!(action_code(result.status), "install-acp-adapter");

        // 两者均在、版本达标 → installed
        let result = from_detection(
            &evidence(&["C:/x/ccb.cmd"], &["C:/x/claude.exe"], true, true),
            &[candidate(Some("0.75.1"))],
        )
        .unwrap();
        assert_eq!(result.status, PreflightStatus::Installed);
        assert_eq!(action_code(result.status), "none");

        // 版本不足 → versionTooOld
        let result = from_detection(
            &evidence(&["C:/x/ccb.cmd"], &["C:/x/claude.exe"], true, true),
            &[candidate(Some("0.64.2"))],
        )
        .unwrap();
        assert_eq!(result.status, PreflightStatus::VersionTooOld);
        assert_eq!(action_code(result.status), "upgrade-acp-adapter");

        // 只有配置 → configOnly；什么都没有 → notInstalled
        let result = from_detection(&evidence(&[], &[], true, true), &[]).unwrap();
        assert_eq!(result.status, PreflightStatus::ConfigOnly);
        assert_eq!(action_code(result.status), "provide-executable");
        let result = from_detection(&evidence(&[], &[], true, false), &[]).unwrap();
        assert_eq!(result.status, PreflightStatus::NotInstalled);
        assert_eq!(action_code(result.status), "install-agent");

        // 非 wrapper provider 不因缺原生 CLI 被判 nativeMissing。
        let mut peri_evidence = evidence(&["C:/x/peri.exe"], &[], false, false);
        peri_evidence.provider = "peri".into();
        let result = from_detection(&peri_evidence, &[]).unwrap();
        assert_eq!(result.status, PreflightStatus::Installed);
    }

    /// A5① 裁定的行为契约：`NativeMissing` 是**信息性**状态，不得改变可启动性。
    ///
    /// 理由见 `PreflightStatus::NativeMissing` 的文档：从 Codeg 迁来的 wrapper relation
    /// 不总是真依赖（Pylon 的 `claude-code` 实际是 `ccb`），把它当门禁会把今天可用的
    /// 配置报成坏的。本测试把「状态可报、启动不受影响」这一对事实钉在一起。
    #[test]
    fn native_missing_is_reported_without_gating_the_launch_plan() {
        let profile = crate::agent_catalog::provider_profile("claude-code").unwrap();
        let detection = crate::agent_launch_plan::LaunchDetection {
            resolved_executable: None,
            acp_present: true,
            native_present: false,
        };
        // 1）preflight 如实报 NativeMissing。
        let preflight = from_detection(
            &crate::agent_detection::AgentProviderEvidence {
                provider: "claude-code".into(),
                detector_id: "builtin.detector.claude-code".into(),
                adapter_relation_declared: true,
                acp_commands: vec![crate::agent_detection::AgentEvidenceHit {
                    kind: "acp-command".into(),
                    path: "C:/x/ccb.cmd".into(),
                    source: "path".into(),
                }],
                native_commands: Vec::new(),
                shared_config_present: true,
                node: ToolVersion::Known("26.7.0".into()),
                uv: ToolVersion::default(),
                adapter_version: None,
            },
            &[],
        )
        .unwrap();
        assert_eq!(preflight.status, PreflightStatus::NativeMissing);
        // 2）同一个检测结果下，launch plan 仍可生成且诊断带 codable 原因。
        let plan = crate::agent_launch_plan::plan_launch(
            "claude-code",
            profile.as_ref(),
            &detection,
            &crate::agent_launch_plan::LaunchOverrides::default(),
        )
        .expect("NativeMissing 不得阻止生成 launch plan");
        assert_eq!(plan.executable, "ccb");
        assert_eq!(plan.args, vec!["--acp"]);
        assert!(
            plan.diagnostics
                .iter()
                .any(|item| item.code == "native-cli-not-found"),
            "必须留下可诊断痕迹: {:?}",
            plan.diagnostics
        );
    }

    /// B0：`requires` 的状态语义与 Codeg 真源逐条对齐。
    ///
    /// 关键区分：**未找到** = Fail（真实且可修）；**存在但版本读不出** = Warn
    /// （不得当作违规）；**版本已知且过旧** = Fail。
    ///
    /// 备注：`PreflightInputs::default()` 的 `ToolVersion` 是 `Unknown`，不是
    /// `Absent`——「没探测过」既不能冒充缺失（伪造失败）也不能冒充满足（伪造通过）。
    #[test]
    fn required_runtime_tool_status_matches_the_source_semantics() {
        assert_eq!(
            required_tool_status(&ToolVersion::Absent, Some("22.0.0"), "Node.js"),
            (
                CheckStatus::Fail,
                "未检测到 Node.js（需要 >= 22.0.0）".into()
            )
        );
        assert_eq!(
            required_tool_status(&ToolVersion::Unknown, Some("22.0.0"), "Node.js").0,
            CheckStatus::Warn
        );
        assert_eq!(
            required_tool_status(
                &ToolVersion::Known("22.19.0".into()),
                Some("22.19.0"),
                "Node.js"
            )
            .0,
            CheckStatus::Pass,
            "恰好等于下限必须通过（kimi 的 22.19.0 即此情形）"
        );
        assert_eq!(
            required_tool_status(
                &ToolVersion::Known("22.18.0".into()),
                Some("22.19.0"),
                "Node.js"
            )
            .0,
            CheckStatus::Fail
        );
        // 版本存在但不可解析（如 `v22`）也不得通过要求。
        assert_eq!(
            required_tool_status(&ToolVersion::Known("22".into()), Some("22.0.0"), "Node.js").0,
            CheckStatus::Fail
        );
        // 未声明下限：已知版本无法被证明满足，但也不构成违规。
        assert_eq!(
            required_tool_status(&ToolVersion::Known("22.0.0".into()), None, "uv").0,
            CheckStatus::Pass
        );
    }

    /// B0：Node 缺失/过旧时 `codex` 必须给出**可见的**失败与可行动 fix，
    /// 而不是像此前那样「已安装、passed=true」。
    ///
    /// 最强形式：安装面**全部满足**（状态为 `Installed`），仅运行时工具不满足——此时
    /// `passed` 必须为 false，证明必需运行时检查真的参与了结论；同时 `status` 仍是
    /// `Installed`，证明运行时问题没有被伪装成安装问题。
    #[test]
    fn codex_without_a_sufficient_node_fails_its_required_runtime_check() {
        let installed = PreflightInputs {
            acp_present: true,
            adapter_present: true,
            binary_present: true,
            native_present: true,
            ..Default::default()
        };

        // 安装面满足 + Node 不存在 → node-min Fail，fix 指向 nodejs.org，passed=false。
        let absent = evaluate(
            "codex",
            &PreflightInputs {
                node: ToolVersion::Absent,
                ..installed.clone()
            },
        )
        .unwrap();
        assert_eq!(absent.status, PreflightStatus::Installed);
        let node_min = absent
            .checks
            .iter()
            .find(|check| check.check_id == "node-min")
            .expect("codex 声明了 requires.node，必须产出 node-min");
        assert_eq!(node_min.status, CheckStatus::Fail);
        assert!(node_min
            .fixes
            .iter()
            .any(|fix| fix.kind == "open-url" && fix.payload == "https://nodejs.org/"));
        assert!(
            !absent.passed,
            "必需运行时失败时 preflight 不得报 passed（此处安装面全部满足）"
        );

        // Node 版本低于下限 → Fail
        let too_old = evaluate(
            "codex",
            &PreflightInputs {
                node: ToolVersion::Known("18.0.0".into()),
                ..installed.clone()
            },
        )
        .unwrap();
        assert!(!too_old.passed);
        assert!(too_old
            .checks
            .iter()
            .any(|check| check.check_id == "node-min" && check.status == CheckStatus::Fail));

        // 读不出版本 → Warn，不得构成 passed=false（不得伪造违规）
        let unreadable = evaluate(
            "codex",
            &PreflightInputs {
                node: ToolVersion::Unknown,
                ..installed.clone()
            },
        )
        .unwrap();
        assert!(unreadable.passed, "版本不可读不得被当作违规");
        assert!(unreadable
            .checks
            .iter()
            .any(|check| check.check_id == "node-min" && check.status == CheckStatus::Warn));

        // Node 满足 → Pass 且 passed=true
        let satisfied = evaluate(
            "codex",
            &PreflightInputs {
                node: ToolVersion::Known("26.7.0".into()),
                ..installed
            },
        )
        .unwrap();
        assert!(satisfied.passed);
        assert!(satisfied
            .checks
            .iter()
            .any(|check| check.check_id == "node-min" && check.status == CheckStatus::Pass));

        // 未声明 requires 的 provider 不得凭空多出检查项（现有行为不变）。
        for provider in ["peri", "hermes"] {
            let result = evaluate(
                provider,
                &PreflightInputs {
                    acp_present: true,
                    binary_present: true,
                    node: ToolVersion::Absent,
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(
                result.checks.is_empty(),
                "{provider} 未声明 requires，不得新增检查项"
            );
            assert!(result.passed);
        }
    }

    #[test]
    fn version_gate_is_semver_ordered() {
        assert!(version_at_least(Some("22.12.1"), Some("22.12.0")));
        assert!(!version_at_least(Some("20.0.0"), Some("22.0.0")));
    }

    /// A1 验收：五类 fixture 各有确定状态，且分类是全覆盖的。
    #[test]
    fn claude_wrapper_evidence_maps_to_every_stable_state() {
        // 1）原生 CLI 存在、wrapper 缺失 → adapterMissing
        assert_eq!(
            classify(true, false, true, true, false),
            PreflightStatus::AdapterMissing
        );
        // 2）wrapper 存在、原生缺失 → nativeMissing
        assert_eq!(
            classify(true, true, false, false, false),
            PreflightStatus::NativeMissing
        );
        // 3）两者均存在 → installed
        assert_eq!(
            classify(true, true, true, true, false),
            PreflightStatus::Installed
        );
        // 4）版本不足 → versionTooOld（优先级高于 nativeMissing）
        assert_eq!(
            classify(true, true, false, false, true),
            PreflightStatus::VersionTooOld
        );
        // 5）仅配置存在 → configOnly
        assert_eq!(
            classify(true, false, false, true, false),
            PreflightStatus::ConfigOnly
        );
        // 全都不存在 → notInstalled（施工书「等」的收尾值，保证映射全）
        assert_eq!(
            classify(true, false, false, false, false),
            PreflightStatus::NotInstalled
        );
        // 非 wrapper provider 不会被判 nativeMissing。
        assert_eq!(
            classify(false, true, false, false, false),
            PreflightStatus::Installed
        );
    }

    #[test]
    fn claude_preflight_evaluates_the_declared_version_gate() {
        let installed = PreflightInputs {
            acp_present: true,
            native_present: true,
            binary_present: true,
            adapter_present: true,
            shared_config_present: true,
            adapter_version: Some("0.75.1".into()),
            ..Default::default()
        };
        let result = evaluate("claude-code", &installed).unwrap();
        assert_eq!(result.status, PreflightStatus::Installed);
        assert!(result.passed);
        let gate = result
            .checks
            .iter()
            .find(|check| check.check_id == "version-gate:steering-prompt-required")
            .expect("claude-code 声明了 steering 版本 gate");
        assert_eq!(gate.status, CheckStatus::Pass);
        let adapter = result.adapter.expect("claude-code 是 wrapper");
        assert_eq!(adapter.native_cmd, "claude");
        assert!(adapter.native_present && adapter.acp_present);
        assert!(adapter.shared_config_present);

        // 版本低于 0.65.0 → versionTooOld，且 gate 项为 Fail。
        let too_old = PreflightInputs {
            adapter_version: Some("0.64.2".into()),
            ..installed.clone()
        };
        let result = evaluate("claude-code", &too_old).unwrap();
        assert_eq!(result.status, PreflightStatus::VersionTooOld);
        assert!(!result.passed);
        assert!(result.checks.iter().any(|check| check.check_id
            == "version-gate:steering-prompt-required"
            && check.status == CheckStatus::Fail));

        // 版本不可读 → unknown（Warn），不得静默当成满足下限；
        // 但「无法证明违反」也不会被报成 versionTooOld。
        let unknown = PreflightInputs {
            adapter_version: None,
            ..installed.clone()
        };
        let result = evaluate("claude-code", &unknown).unwrap();
        assert_eq!(result.status, PreflightStatus::Installed);
        assert!(result.checks.iter().any(|check| check.check_id
            == "version-gate:steering-prompt-required"
            && check.status == CheckStatus::Warn));
    }

    #[test]
    fn wrapper_preflight_reports_both_missing_sides() {
        let native_only = evaluate(
            "claude-code",
            &PreflightInputs {
                native_present: true,
                binary_present: true,
                shared_config_present: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(native_only.status, PreflightStatus::AdapterMissing);
        assert!(!native_only.passed);
        let adapter = native_only.adapter.expect("wrapper explainer 仍在");
        assert!(adapter.native_present && !adapter.acp_present);

        let adapter_only = evaluate(
            "claude-code",
            &PreflightInputs {
                acp_present: true,
                adapter_present: true,
                adapter_version: Some("0.75.1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(adapter_only.status, PreflightStatus::NativeMissing);

        // 非 wrapper provider 无 adapter 解释块，也不会因缺原生 CLI 被判 nativeMissing。
        let peri = evaluate(
            "peri",
            &PreflightInputs {
                acp_present: true,
                binary_present: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(peri.status, PreflightStatus::Installed);
        assert!(peri.adapter.is_none());
        assert!(peri.checks.is_empty(), "peri 既无 checks 也无 gate");

        let config_only = evaluate(
            "claude-code",
            &PreflightInputs {
                shared_config_present: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(config_only.status, PreflightStatus::ConfigOnly);

        let nothing = evaluate("claude-code", &PreflightInputs::default()).unwrap();
        assert_eq!(nothing.status, PreflightStatus::NotInstalled);
    }

    /// A1 安全契约：诊断只给出「存在性」，不包含共享配置目录里的任何内容。
    #[test]
    fn diagnostics_never_carry_secrets_from_the_shared_config_dir() {
        let result = evaluate(
            "claude-code",
            &PreflightInputs {
                acp_present: true,
                native_present: true,
                shared_config_present: true,
                adapter_version: Some("0.75.1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let rendered = serde_json::to_string(&result).unwrap();
        // 目录字面量来自 catalog（`~/.claude`），检测从不回传展开后的绝对路径。
        assert!(rendered.contains("~/.claude"));
        assert!(!rendered.contains("apiKeyHelper"));
        assert!(!rendered.contains("ANTHROPIC_API_KEY"));
        assert!(!rendered.contains("sk-"));
        let adapter = result.adapter.unwrap();
        assert_eq!(adapter.shared_config_dir, "~/.claude");
    }
}
