//! Codeg-shaped agent profile -> Pylon agent profile (P62 A0).
//!
//! Conversion only, never execution: the input is an already-redacted,
//! serializable DTO — never a Codeg `AgentType`, a database row or UI state —
//! and the output is the closed [`PylonAgentProfile`] the shared catalog,
//! preflight and ACP launch seams consume. Nothing here reads Codeg source
//! structure at launch time, and installers, downloaders, logins, `sacp` and
//! Codeg's transcript are deliberately outside this path.
//!
//! Source: codeg `b2eec98ce8d082ad48803918dd9a21ab08d1d3d4`
//! `src-tauri/src/acp/registry.rs` (`AcpAdapterRelation`, launch metadata,
//! version gates) and `src-tauri/src/acp/custom_registry.rs` (profile
//! validation, conflict rules, `derive_command_name`). See
//! `src-tauri/vendor/acp/ORIGIN.md`.

use crate::agent_catalog::{
    CatalogAdapterRelation, CatalogLaunchCwdPolicy, CatalogLaunchEnv, CatalogLaunchKind,
    CatalogLaunchProfile, CatalogSessionEstablishmentPolicy, CatalogVersionGate,
    CatalogVersionGates, PylonAgentProfile,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;

/// Source-shaped distribution channel. Mirrors codeg's `AgentDistribution`
/// tag while keeping the vendor-private payload out of the DTO.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CodegDistributionKind {
    Npx,
    Uvx,
    Binary,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodegSystemCommand {
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodegNpxSpec {
    pub package: String,
    #[serde(default)]
    pub cmd: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub node_required: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodegUvxSpec {
    pub package: String,
    #[serde(default)]
    pub cmd: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub uv_required: Option<String>,
    #[serde(default)]
    pub system_cmd: Option<CodegSystemCommand>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodegBinarySpec {
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub version: Option<String>,
}

/// Codeg's `CustomAgentDef`-shaped channel selector: a closed `kind` plus one
/// optional payload per channel. The payload for a channel the `kind` did not
/// select must be absent, which is codeg's own `MissingChannel` premise.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodegDistribution {
    pub kind: CodegDistributionKind,
    #[serde(default)]
    pub npx: Option<CodegNpxSpec>,
    #[serde(default)]
    pub uvx: Option<CodegUvxSpec>,
    #[serde(default)]
    pub binary: Option<CodegBinarySpec>,
}

/// One provider as migrated out of Codeg, before it becomes catalog data.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodegAgentProfile {
    /// Pylon provider id this profile installs under.
    pub provider: String,
    /// Codeg's registry id: source provenance, never a runtime identity.
    pub registry_id: String,
    pub display_name: String,
    pub distribution: CodegDistribution,
    #[serde(default)]
    pub adapter_relation: Option<CatalogAdapterRelation>,
    /// Flat codeg declaration; `None` means "no gate declared for this agent".
    #[serde(default)]
    pub version_gates: Option<CatalogVersionGates>,
    /// `None` takes the Pylon default `resume -> load -> new`.
    #[serde(default)]
    pub session_establishment: Option<CatalogSessionEstablishmentPolicy>,
    #[serde(default)]
    pub cwd_policy: Option<CatalogLaunchCwdPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileTransformError {
    InvalidProviderId(String),
    InvalidRegistryId(String),
    DuplicateProviderId(String),
    MissingChannel(&'static str),
    MissingField(String),
    InvalidField(String),
    /// The profile would have required a Unix-only argv. This project is
    /// Windows-only, so such a profile is refused rather than adapted.
    UnsafeWindowsArgument(String),
}

impl fmt::Display for ProfileTransformError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProviderId(id) => write!(formatter, "provider id 非法: {id}"),
            Self::InvalidRegistryId(id) => write!(formatter, "registry id 非法: {id}"),
            Self::DuplicateProviderId(id) => write!(formatter, "provider id 冲突: {id}"),
            Self::MissingChannel(kind) => write!(formatter, "distribution 缺少 {kind} 通道配置"),
            Self::MissingField(field) => write!(formatter, "缺少字段: {field}"),
            Self::InvalidField(reason) => write!(formatter, "字段非法: {reason}"),
            Self::UnsafeWindowsArgument(detail) => {
                write!(formatter, "profile 需要 Unix-only argv: {detail}")
            }
        }
    }
}

impl std::error::Error for ProfileTransformError {}

/// Pylon provider ids are their own namespace (slug-safe, no leading dot).
/// Codeg's built-in wire-name blocklist does not apply here: duplicate Pylon
/// providers are caught by [`transform_profiles`] instead.
fn is_valid_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Console-script name derived from a package spec when the source does not
/// state one (migrated verbatim from codeg `custom_registry.rs:270`).
///
/// `@qwen-code/qwen-code@0.21.0` -> `qwen-code`;
/// `fast-agent-acp==0.9.24` -> `fast-agent-acp`.
fn derive_command_name(package: &str) -> String {
    let mut value = package;
    for separator in ["==", ">=", "<=", "~=", "!=", ">", "<"] {
        if let Some(index) = value.find(separator) {
            value = &value[..index];
        }
    }
    if let Some(index) = value.find('[') {
        value = &value[..index];
    }
    // Strip an npm version suffix without eating a leading scope `@`
    // (`@scope/name@1.2.3`: the version `@` is the one after the slash).
    let search_from = if value.starts_with('@') {
        value.find('/').map(|index| index + 1).unwrap_or(0)
    } else {
        0
    };
    if let Some(index) = value[search_from..].find('@') {
        value = &value[..search_from + index];
    }
    if let Some(index) = value.rfind('/') {
        value = &value[index + 1..];
    }
    value.trim().to_string()
}

fn resolved_command(explicit: Option<&str>, package: &str) -> String {
    explicit
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| derive_command_name(package))
}

fn launch_from_distribution(
    profile: &CodegAgentProfile,
) -> Result<CatalogLaunchProfile, ProfileTransformError> {
    let distribution = &profile.distribution;
    let unselected = match distribution.kind {
        CodegDistributionKind::Npx => distribution.uvx.is_some() || distribution.binary.is_some(),
        CodegDistributionKind::Uvx => distribution.npx.is_some() || distribution.binary.is_some(),
        CodegDistributionKind::Binary => distribution.npx.is_some() || distribution.uvx.is_some(),
    };
    if unselected {
        return Err(ProfileTransformError::InvalidField(format!(
            "{}.distribution 含未选中通道的载荷",
            profile.provider
        )));
    }
    let (kind, command, args) = match distribution.kind {
        CodegDistributionKind::Npx => {
            let npx = distribution
                .npx
                .as_ref()
                .ok_or(ProfileTransformError::MissingChannel("npx"))?;
            if npx.package.trim().is_empty() {
                return Err(ProfileTransformError::MissingField(format!(
                    "{}.distribution.npx.package",
                    profile.provider
                )));
            }
            (
                CatalogLaunchKind::Npm,
                resolved_command(npx.cmd.as_deref(), &npx.package),
                npx.args.clone(),
            )
        }
        CodegDistributionKind::Uvx => {
            let uvx = distribution
                .uvx
                .as_ref()
                .ok_or(ProfileTransformError::MissingChannel("uvx"))?;
            if uvx.package.trim().is_empty() {
                return Err(ProfileTransformError::MissingField(format!(
                    "{}.distribution.uvx.package",
                    profile.provider
                )));
            }
            (
                CatalogLaunchKind::Uvx,
                resolved_command(uvx.cmd.as_deref(), &uvx.package),
                uvx.args.clone(),
            )
        }
        CodegDistributionKind::Binary => {
            let binary = distribution
                .binary
                .as_ref()
                .ok_or(ProfileTransformError::MissingChannel("binary"))?;
            if binary.cmd.trim().is_empty() {
                return Err(ProfileTransformError::MissingField(format!(
                    "{}.distribution.binary.cmd",
                    profile.provider
                )));
            }
            (
                CatalogLaunchKind::Path,
                binary.cmd.trim().to_string(),
                binary.args.clone(),
            )
        }
    };
    let launch = CatalogLaunchProfile {
        kind,
        command,
        args,
        env: Vec::<CatalogLaunchEnv>::new(),
        cwd_policy: profile.cwd_policy,
    };
    launch
        .validate(&profile.provider)
        .map_err(ProfileTransformError::UnsafeWindowsArgument)?;
    Ok(launch)
}

/// Convert one source profile. Every failure is a closed variant: an unknown
/// strategy or a field the DTO does not declare is refused, never guessed.
pub fn transform_profile(
    source: &CodegAgentProfile,
) -> Result<PylonAgentProfile, ProfileTransformError> {
    if !is_valid_provider_id(&source.provider) {
        return Err(ProfileTransformError::InvalidProviderId(
            source.provider.clone(),
        ));
    }
    if !is_valid_provider_id(&source.registry_id) {
        return Err(ProfileTransformError::InvalidRegistryId(
            source.registry_id.clone(),
        ));
    }
    if source.display_name.trim().is_empty() {
        return Err(ProfileTransformError::MissingField(format!(
            "{}.displayName",
            source.provider
        )));
    }
    let launch = launch_from_distribution(source)?;
    let version_gates: Vec<CatalogVersionGate> = match &source.version_gates {
        None => Vec::new(),
        Some(gates) => gates
            .to_gates(&source.provider)
            .map_err(ProfileTransformError::InvalidField)?,
    };
    let session_establishment = match &source.session_establishment {
        None => CatalogSessionEstablishmentPolicy::default(),
        Some(policy) => {
            // Reuse the catalog's validator so both entries enforce one order
            // contract (`new` last, no repeats) instead of two drifting copies.
            let encoded = serde_json::to_value(policy).map_err(|error| {
                ProfileTransformError::InvalidField(format!(
                    "{}.adaptation.sessionEstablishment 无法序列化: {error}",
                    source.provider
                ))
            })?;
            let reparsed: CatalogSessionEstablishmentPolicy = serde_json::from_value(encoded)
                .map_err(|error| {
                    ProfileTransformError::InvalidField(format!(
                        "{}.adaptation.sessionEstablishment 非法: {error}",
                        source.provider
                    ))
                })?;
            crate::agent_catalog::validate_session_establishment_policy(
                &source.provider,
                &reparsed,
            )
            .map_err(ProfileTransformError::InvalidField)?;
            reparsed
        }
    };
    Ok(PylonAgentProfile {
        provider: source.provider.clone(),
        display_name: source.display_name.clone(),
        launch,
        adapter_relation: source.adapter_relation.clone(),
        version_gates,
        session_establishment,
    })
}

/// Convert a batch, refusing two profiles that would install under the same
/// Pylon provider id (codeg's `CollidesWithBuiltin` premise, restated for the
/// Pylon namespace).
pub fn transform_profiles(
    sources: &[CodegAgentProfile],
) -> Result<Vec<PylonAgentProfile>, ProfileTransformError> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut profiles = Vec::with_capacity(sources.len());
    for source in sources {
        let key = source.provider.to_ascii_lowercase();
        if !seen.insert(key) {
            return Err(ProfileTransformError::DuplicateProviderId(
                source.provider.clone(),
            ));
        }
        profiles.push(transform_profile(source)?);
    }
    Ok(profiles)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(json: serde_json::Value) -> CodegAgentProfile {
        serde_json::from_value(json).expect("fixture 必须是合法 CodegAgentProfile")
    }

    fn claude_wrapper() -> serde_json::Value {
        serde_json::json!({
            "provider": "claude-code",
            "registryId": "claude-acp",
            "displayName": "Claude Code",
            "distribution": {
                "kind": "npx",
                "npx": {
                    "package": "@agentclientprotocol/claude-agent-acp@0.75.1",
                    "cmd": "claude-agent-acp",
                    "args": ["--acp"],
                    "nodeRequired": "22.12.0"
                }
            },
            "adapterRelation": {
                "nativeCmd": "claude",
                "nativeLabel": "Claude Code CLI",
                "sharedConfigDir": "~/.claude",
                "extraDirs": [".local/bin", ".claude/local"],
                "docsUrl": "https://docs.codeg.app/guide/supported-agents#acp-adapters"
            },
            "versionGates": {
                "steeringPromptRequiredMinVersion": "0.65.0",
                "goalControlOutOfBand": false,
                "cursorAcpBackend": false
            },
            "sessionEstablishment": { "order": ["resume", "load", "new"] }
        })
    }

    #[test]
    fn claude_and_codex_wrappers_project_into_closed_launch_and_gates() {
        let claude = transform_profile(&profile(claude_wrapper())).unwrap();
        assert_eq!(claude.launch.kind, CatalogLaunchKind::Npm);
        assert_eq!(claude.launch.command, "claude-agent-acp");
        assert_eq!(claude.launch.args, vec!["--acp"]);
        let relation = claude
            .adapter_relation
            .as_ref()
            .expect("wrapper 关系必须保留");
        assert_eq!(relation.native_cmd, "claude");
        assert_eq!(claude.version_gates.len(), 3);
        assert_eq!(
            claude.version_gates[0].min_version.as_deref(),
            Some("0.65.0")
        );

        let codex = transform_profile(&profile(serde_json::json!({
            "provider": "codex",
            "registryId": "codex-acp",
            "displayName": "Codex",
            "distribution": { "kind": "npx", "npx": { "package": "codex-acp" } },
            "adapterRelation": {
                "nativeCmd": "codex",
                "nativeLabel": "Codex CLI",
                "sharedConfigDir": "~/.codex",
                "extraDirs": [".local/bin"]
            },
            "versionGates": { "goalControlOutOfBand": true }
        })))
        .unwrap();
        assert_eq!(codex.launch.kind, CatalogLaunchKind::Npm);
        // cmd 未声明时按 codeg `derive_command_name` 从包名推导。
        assert_eq!(codex.launch.command, "codex-acp");
        assert!(codex.launch.args.is_empty());
        assert_eq!(codex.version_gates.len(), 1);
        assert!(codex.version_gates[0].enabled);
        // 未声明 sessionEstablishment 的 provider 落在 Pylon 默认策略上。
        assert_eq!(
            codex.session_establishment,
            CatalogSessionEstablishmentPolicy::default()
        );
    }

    #[test]
    fn native_acp_profiles_have_no_adapter_relation_and_a_path_launch() {
        let gemini = transform_profile(&profile(serde_json::json!({
            "provider": "gemini",
            "registryId": "gemini",
            "displayName": "Gemini",
            "distribution": { "kind": "binary", "binary": { "cmd": "gemini", "args": ["--experimental-acp"], "version": "0.11.0" } }
        })))
        .unwrap();
        assert_eq!(gemini.launch.kind, CatalogLaunchKind::Path);
        assert_eq!(gemini.launch.command, "gemini");
        assert!(gemini.adapter_relation.is_none());
        assert!(gemini.version_gates.is_empty());

        // uvx 通道保留为 uvx 策略，不伪装成 path。
        let hermes = transform_profile(&profile(serde_json::json!({
            "provider": "hermes",
            "registryId": "hermes",
            "displayName": "Hermes",
            "distribution": {
                "kind": "uvx",
                "uvx": { "package": "hermes-agent[acp]==0.19.0", "cmd": "hermes-acp", "uvRequired": "0.5.0" }
            }
        })))
        .unwrap();
        assert_eq!(hermes.launch.kind, CatalogLaunchKind::Uvx);
        assert_eq!(hermes.launch.command, "hermes-acp");
    }

    #[test]
    fn package_spec_derivation_matches_codeg() {
        assert_eq!(
            derive_command_name("@qwen-code/qwen-code@0.21.0"),
            "qwen-code"
        );
        assert_eq!(
            derive_command_name("fast-agent-acp==0.9.24"),
            "fast-agent-acp"
        );
        assert_eq!(
            derive_command_name("hermes-agent[acp,mcp]==0.19.0"),
            "hermes-agent"
        );
        assert_eq!(derive_command_name("codex-acp"), "codex-acp");
    }

    #[test]
    fn unknown_strategy_fails_closed() {
        // DTO 边界：未知通道、未知字段、未知 gate、未知 session 方法都在反序列化即失败。
        for invalid in [
            serde_json::json!({
                "provider": "future",
                "registryId": "future",
                "displayName": "Future",
                "distribution": { "kind": "deno", "npx": { "package": "x" } }
            }),
            serde_json::json!({
                "provider": "future",
                "registryId": "future",
                "displayName": "Future",
                "distribution": { "kind": "binary", "binary": { "cmd": "future", "downloadUrl": "https://x" } }
            }),
            serde_json::json!({
                "provider": "future",
                "registryId": "future",
                "displayName": "Future",
                "distribution": { "kind": "binary", "binary": { "cmd": "future" } },
                "versionGates": { "promptCaching": true }
            }),
            serde_json::json!({
                "provider": "future",
                "registryId": "future",
                "displayName": "Future",
                "distribution": { "kind": "binary", "binary": { "cmd": "future" } },
                "sessionEstablishment": { "order": ["fork", "new"] }
            }),
        ] {
            assert!(
                serde_json::from_value::<CodegAgentProfile>(invalid.clone()).is_err(),
                "accepted {invalid}"
            );
        }

        // 语义契约：能反序列化、但违反「new 收尾 / 不得重复」的顺序必须被 transform 拒绝。
        for order in [
            serde_json::json!(["new", "resume"]),
            serde_json::json!(["resume", "resume", "new"]),
        ] {
            let rejected = transform_profile(&profile(serde_json::json!({
                "provider": "future",
                "registryId": "future",
                "displayName": "Future",
                "distribution": { "kind": "binary", "binary": { "cmd": "future" } },
                "sessionEstablishment": { "order": order }
            })));
            assert!(
                matches!(
                    rejected.unwrap_err(),
                    ProfileTransformError::InvalidField(_)
                ),
                "accepted {order}"
            );
        }
    }

    #[test]
    fn missing_fields_fail_closed() {
        // 声明 npx 却没有通道载荷。
        let missing_channel = transform_profile(&profile(serde_json::json!({
            "provider": "future",
            "registryId": "future",
            "displayName": "Future",
            "distribution": { "kind": "npx" }
        })));
        assert_eq!(
            missing_channel.unwrap_err(),
            ProfileTransformError::MissingChannel("npx")
        );

        // 通道载荷存在但必填字段为空。
        let empty_package = transform_profile(&profile(serde_json::json!({
            "provider": "future",
            "registryId": "future",
            "displayName": "Future",
            "distribution": { "kind": "npx", "npx": { "package": "  " } }
        })));
        assert!(matches!(
            empty_package.unwrap_err(),
            ProfileTransformError::MissingField(_)
        ));

        // 未选中通道仍带载荷 = 契约冲突。
        let stray_payload = transform_profile(&profile(serde_json::json!({
            "provider": "future",
            "registryId": "future",
            "displayName": "Future",
            "distribution": {
                "kind": "binary",
                "binary": { "cmd": "future" },
                "uvx": { "package": "future" }
            }
        })));
        assert!(matches!(
            stray_payload.unwrap_err(),
            ProfileTransformError::InvalidField(_)
        ));

        let empty_display_name = transform_profile(&profile(serde_json::json!({
            "provider": "future",
            "registryId": "future",
            "displayName": " ",
            "distribution": { "kind": "binary", "binary": { "cmd": "future" } }
        })));
        assert!(matches!(
            empty_display_name.unwrap_err(),
            ProfileTransformError::MissingField(_)
        ));
    }

    #[test]
    fn conflicting_provider_ids_fail_closed() {
        let one = profile(serde_json::json!({
            "provider": "future",
            "registryId": "future",
            "displayName": "Future",
            "distribution": { "kind": "binary", "binary": { "cmd": "future" } }
        }));
        let mut two = one.clone();
        two.registry_id = "future-other".into();
        assert_eq!(
            transform_profiles(&[one.clone(), two]).unwrap_err(),
            ProfileTransformError::DuplicateProviderId("future".into())
        );
        assert_eq!(transform_profiles(std::slice::from_ref(&one)).unwrap().len(), 1);

        let bad_id = transform_profile(&profile(serde_json::json!({
            "provider": ".hidden",
            "registryId": "future",
            "displayName": "Future",
            "distribution": { "kind": "binary", "binary": { "cmd": "future" } }
        })));
        assert_eq!(
            bad_id.unwrap_err(),
            ProfileTransformError::InvalidProviderId(".hidden".into())
        );
    }

    #[test]
    fn windows_only_profiles_never_produce_unix_argv() {
        for args in [vec!["/bin/sh", "-c", "agent"], vec!["--signal", "SIGTERM"]] {
            let transformed = transform_profile(&profile(serde_json::json!({
                "provider": "future",
                "registryId": "future",
                "displayName": "Future",
                "distribution": { "kind": "binary", "binary": { "cmd": "agent", "args": args } }
            })));
            assert!(matches!(
                transformed.unwrap_err(),
                ProfileTransformError::UnsafeWindowsArgument(_)
            ));
        }
        // 合法 profile 的输出里不含 POSIX shell 或系统路径。
        let ok = transform_profile(&profile(claude_wrapper())).unwrap();
        let rendered = serde_json::to_string(&ok).unwrap();
        assert!(!rendered.contains("/bin/"));
        assert!(!rendered.contains("SIGTERM"));
        assert_eq!(ok.launch.env, Vec::new());
    }
}
