//! Shared first-party Agent Catalog.
//!
//! The JSON document is the single provider baseline consumed by both Rust and
//! TypeScript. Native code keeps process discovery behind a controlled
//! projection; editable agents.yaml never supplies scan commands.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../../../shared/agent-catalog.json");
const SUPPORTED_SCHEMA_VERSION: u32 = 3;

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
    #[serde(default)]
    version_args: Vec<String>,
    #[serde(default)]
    package_manager: Option<CatalogPackageManager>,
    #[serde(default)]
    requires: CatalogRequirements,
    #[serde(default)]
    checks: Vec<CatalogCheck>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogPackageManagerKind {
    Npx,
    Uvx,
    Binary,
    None,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogPackageManager {
    pub kind: CatalogPackageManagerKind,
    pub package: Option<String>,
    pub cmd: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogRequirements {
    pub node: Option<String>,
    pub uv: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogCheckKind {
    NodeMin,
    UvMin,
    BinaryPresent,
    AdapterPresent,
    ConfigEvidence,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogFixKind {
    OpenUrl,
    InstallAdapter,
    InstallUv,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogFix {
    pub kind: CatalogFixKind,
    pub payload: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogCheck {
    pub id: String,
    pub label: String,
    pub kind: CatalogCheckKind,
    pub params: serde_json::Map<String, serde_json::Value>,
    pub fix: Option<CatalogFix>,
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CatalogSetModelApi {
    ConfigOption,
    SetModel,
    None,
}

/// Public, read-only projection of the protocol portion of the shared Agent
/// Catalog.  The on-disk document intentionally remains private so callers
/// cannot accidentally depend on detection/tool presentation internals.
/// Runtime protocol adapters enrich this baseline in the desktop crate.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProtocolProfile {
    pub provider: String,
    pub display_name: String,
    pub session_updates: bool,
    pub interaction_events: bool,
    pub permission_requests: bool,
    pub replay: bool,
    pub response_methods: Vec<String>,
    pub interaction_kinds: Vec<String>,
    pub set_model_api: CatalogSetModelApi,
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
    #[serde(default)]
    adaptation: Option<CatalogAdaptation>,
    /// Schema v3. Static launch recipe; absent on a provider that has not been
    /// given one yet, in which case `provider_profile` fails closed.
    #[serde(default)]
    launch: Option<CatalogLaunchProfile>,
    tools: Vec<CatalogTool>,
}

/// Declarative provider adaptation policy. The nested shapes are intentionally
/// retained as JSON values until A-ADAPT assigns each consumer its closed
/// strategy enum; unknown top-level policy names are rejected now.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogAdaptation {
    pub adapter_relation: Option<serde_json::Value>,
    pub client_capabilities: Option<serde_json::Value>,
    pub prompt_capabilities: Option<serde_json::Value>,
    pub launch_env: Option<serde_json::Value>,
    pub version_gates: Option<serde_json::Value>,
    pub session_establishment: Option<serde_json::Value>,
    pub config_adaptation: Option<serde_json::Value>,
    pub mcp: Option<serde_json::Value>,
    pub interaction_bridges: Option<serde_json::Value>,
}

/// Closed launch strategy for a catalog provider.
///
/// `path` launches an already-installed executable (the only strategy the
/// Windows launch planner implements today); `uvx`/`npm` name a package runner
/// and must fail closed until a planner implements them.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CatalogLaunchKind {
    Path,
    Uvx,
    Npm,
}

/// Where a launched ACP process runs. Closed on purpose: a profile can never
/// name an arbitrary directory.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogLaunchCwdPolicy {
    Workspace,
    ProviderConfig,
    Inherit,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogLaunchEnv {
    pub name: String,
    pub value: String,
}

/// Static launch recipe for one provider (schema v3).
///
/// Pure data: the Windows launch planner (A2) turns this plus live detection
/// into a `LaunchPlan`; nothing here is executed by the catalog itself.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogLaunchProfile {
    pub kind: CatalogLaunchKind,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<CatalogLaunchEnv>,
    #[serde(default)]
    pub cwd_policy: Option<CatalogLaunchCwdPolicy>,
}

/// POSIX system path prefixes. This project is Windows-only, so no catalog
/// profile may name one and no Unix argv can be synthesized from catalog data.
const POSIX_SYSTEM_PATH_PREFIXES: &[&str] = &[
    "/bin/", "/sbin/", "/usr/", "/etc/", "/dev/", "/lib/", "/opt/", "/tmp/", "/var/",
];

fn env_name_is_valid(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|rest| rest.is_ascii_alphanumeric() || rest == '_')
}

/// Security contract §6: the catalog is text in git, so a profile can never
/// carry a literal credential. A name that *asks* for one is rejected rather
/// than silently written into a launch plan.
fn env_name_requests_secret(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "API_KEY",
        "APIKEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn unix_only_argument(command: &str, arg: &str) -> bool {
    if POSIX_SYSTEM_PATH_PREFIXES
        .iter()
        .any(|prefix| arg.starts_with(prefix))
    {
        return true;
    }
    if arg.contains("SIGTERM") || arg.contains("SIGKILL") {
        return true;
    }
    let stem = std::path::Path::new(command)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(command)
        .to_ascii_lowercase();
    matches!(stem.as_str(), "sh" | "bash" | "zsh" | "dash" | "ksh")
        && matches!(arg, "-c" | "-lc" | "--command")
}

/// One validator for interaction-bridge declarations, shared with the Codeg
/// profile transform so both entry points enforce one method/parser contract.
pub(crate) fn validate_interaction_bridges(
    provider: &str,
    bridges: &[CatalogInteractionBridge],
) -> Result<(), String> {
    let mut seen = HashSet::new();
    for bridge in bridges {
        if bridge.method.trim().is_empty() {
            return Err(format!(
                "Agent Catalog {provider}.adaptation.interactionBridges.method 不能为空"
            ));
        }
        if !seen.insert(bridge.method.clone()) {
            return Err(format!(
                "Agent Catalog {provider}.adaptation.interactionBridges.method 重复: {}",
                bridge.method
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_launch_env_entry(
    provider: &str,
    entry: &CatalogLaunchEnv,
) -> Result<(), String> {
    if !env_name_is_valid(&entry.name) {
        return Err(format!(
            "Agent Catalog {provider}.launch env name 非法: {}",
            entry.name
        ));
    }
    if env_name_requests_secret(&entry.name) {
        return Err(format!(
            "Agent Catalog {provider} 不得声明凭据类 env: {}",
            entry.name
        ));
    }
    if entry.value.trim().is_empty() {
        return Err(format!(
            "Agent Catalog {provider}.launch env value 不能为空: {}",
            entry.name
        ));
    }
    Ok(())
}

impl CatalogLaunchProfile {
    /// Windows-only launch boundary. A profile that cannot be launched as a
    /// plain Windows child process must be rejected here rather than at spawn
    /// time, where the failure would be an opaque process error.
    pub fn validate(&self, provider: &str) -> Result<(), String> {
        if self.command.trim().is_empty() {
            return Err(format!("Agent Catalog {provider}.launch.command 不能为空"));
        }
        if self.command.contains('/') || self.command.contains('\\') {
            return Err(format!(
                "Agent Catalog {provider}.launch.command 必须是 PATH 可解析的可执行名"
            ));
        }
        for arg in &self.args {
            if arg.trim().is_empty() {
                return Err(format!("Agent Catalog {provider}.launch.args 不能含空项"));
            }
            if unix_only_argument(&self.command, arg) {
                return Err(format!(
                    "Agent Catalog {provider}.launch.args 含 Unix-only 参数: {arg}"
                ));
            }
        }
        for entry in &self.env {
            validate_launch_env_entry(provider, entry)?;
        }
        Ok(())
    }
}

/// The vendor CLI wrapped by a provider whose own entry is a third-party ACP
/// *adapter* (migrated from Codeg `b2eec98`
/// `src-tauri/src/acp/registry.rs::AcpAdapterRelation`).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogAdapterRelation {
    pub native_cmd: String,
    pub native_label: String,
    pub shared_config_dir: String,
    pub extra_dirs: Vec<String>,
    #[serde(default)]
    pub docs_url: Option<String>,
}

fn is_relative_dir(raw: &str) -> bool {
    let trimmed = raw.trim();
    let trimmed = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
        .unwrap_or(trimmed);
    if trimmed.is_empty() {
        return false;
    }
    let path = std::path::Path::new(trimmed);
    !path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
}

fn validate_adapter_relation(
    provider: &str,
    relation: &CatalogAdapterRelation,
) -> Result<(), String> {
    for (label, value) in [
        ("nativeCmd", &relation.native_cmd),
        ("nativeLabel", &relation.native_label),
        ("sharedConfigDir", &relation.shared_config_dir),
    ] {
        if value.trim().is_empty() {
            return Err(format!(
                "Agent Catalog {provider}.adaptation.adapterRelation.{label} 不能为空"
            ));
        }
    }
    if !is_relative_dir(&relation.shared_config_dir) {
        return Err(format!(
            "Agent Catalog {provider}.adaptation.adapterRelation.sharedConfigDir 必须是配置目录内的相对路径"
        ));
    }
    for dir in &relation.extra_dirs {
        if !is_relative_dir(dir) {
            return Err(format!(
                "Agent Catalog {provider}.adaptation.adapterRelation.extraDirs 非法: {dir}"
            ));
        }
    }
    Ok(())
}

/// Closed version-gate identity.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogVersionGateId {
    SteeringPromptRequired,
    GoalControlOutOfBand,
    CursorAcpBackend,
}

/// Where a gate's evidence comes from. Closed: a gate that cannot name how it
/// is proven must not be declared.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogVersionEvidence {
    /// The running adapter's `agent_info.version` from `initialize`.
    AdapterAgentInfoVersion,
    /// A fact about the resolved launch recipe (e.g. `cursor-agent ... acp`).
    LaunchRecipe,
    /// A static policy bit no probe can change.
    StaticPolicy,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogVersionGate {
    pub id: CatalogVersionGateId,
    pub min_version: Option<String>,
    pub enabled: bool,
    pub evidence: CatalogVersionEvidence,
}

/// Codeg-shaped flat version-gate declaration. Kept in this shape because it is
/// also the on-disk catalog shape; `to_gates` is the only reader. Every key is
/// known, so an unknown gate name fails closed instead of being ignored.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogVersionGates {
    #[serde(default)]
    pub steering_prompt_required_min_version: Option<String>,
    #[serde(default)]
    pub goal_control_out_of_band: Option<bool>,
    #[serde(default)]
    pub cursor_acp_backend: Option<bool>,
}

fn is_version_like(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.contains('.')
        && trimmed.chars().all(|c| c.is_ascii_digit() || c == '.')
        && trimmed
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

impl CatalogVersionGates {
    pub fn to_gates(&self, provider: &str) -> Result<Vec<CatalogVersionGate>, String> {
        let mut gates = Vec::new();
        if let Some(min_version) = &self.steering_prompt_required_min_version {
            if !is_version_like(min_version) {
                return Err(format!(
                    "Agent Catalog {provider}.adaptation.versionGates.steeringPromptRequiredMinVersion 非法: {min_version}"
                ));
            }
            gates.push(CatalogVersionGate {
                id: CatalogVersionGateId::SteeringPromptRequired,
                min_version: Some(min_version.clone()),
                enabled: true,
                evidence: CatalogVersionEvidence::AdapterAgentInfoVersion,
            });
        }
        if let Some(enabled) = self.goal_control_out_of_band {
            gates.push(CatalogVersionGate {
                id: CatalogVersionGateId::GoalControlOutOfBand,
                min_version: None,
                enabled,
                evidence: CatalogVersionEvidence::StaticPolicy,
            });
        }
        if let Some(enabled) = self.cursor_acp_backend {
            gates.push(CatalogVersionGate {
                id: CatalogVersionGateId::CursorAcpBackend,
                min_version: None,
                enabled,
                evidence: CatalogVersionEvidence::LaunchRecipe,
            });
        }
        if gates.is_empty() {
            return Err(format!(
                "Agent Catalog {provider}.adaptation.versionGates 不能为空对象"
            ));
        }
        Ok(gates)
    }
}

/// Closed session-establishment method.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSessionMethod {
    Resume,
    Load,
    New,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSessionEstablishmentPolicy {
    pub order: Vec<CatalogSessionMethod>,
}

impl Default for CatalogSessionEstablishmentPolicy {
    fn default() -> Self {
        Self {
            order: vec![
                CatalogSessionMethod::Resume,
                CatalogSessionMethod::Load,
                CatalogSessionMethod::New,
            ],
        }
    }
}

/// Validate a session-establishment policy against the catalog's order
/// contract (`new` last, no repeats). Shared with the Codeg profile transform
/// so both entry points enforce one rule instead of two drifting copies.
pub fn validate_session_establishment_policy(
    provider: &str,
    policy: &CatalogSessionEstablishmentPolicy,
) -> Result<(), String> {
    validate_session_establishment(provider, policy)
}

/// A policy that never falls back to `new` cannot establish a session at all,
/// and a repeated method would silently drop a fallback reason.
fn validate_session_establishment(
    provider: &str,
    policy: &CatalogSessionEstablishmentPolicy,
) -> Result<(), String> {
    if policy.order.is_empty() {
        return Err(format!(
            "Agent Catalog {provider}.adaptation.sessionEstablishment.order 不能为空"
        ));
    }
    if !matches!(policy.order.last(), Some(CatalogSessionMethod::New)) {
        return Err(format!(
            "Agent Catalog {provider}.adaptation.sessionEstablishment.order 必须以 new 收尾"
        ));
    }
    let mut seen = HashSet::new();
    for method in &policy.order {
        if !seen.insert(*method) {
            return Err(format!(
                "Agent Catalog {provider}.adaptation.sessionEstablishment.order 不能重复"
            ));
        }
    }
    Ok(())
}

/// Strong-typed provider projection: the launch recipe plus the closed
/// adaptation policies that preflight and the ACP launch seams consume.
///
/// This is the only place the catalog's `Value`-typed adaptation block is read
/// as policy; unknown strategy names fail closed here instead of reaching a
/// consumer as untyped JSON.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PylonAgentProfile {
    pub provider: String,
    pub display_name: String,
    pub launch: CatalogLaunchProfile,
    pub adapter_relation: Option<CatalogAdapterRelation>,
    pub version_gates: Vec<CatalogVersionGate>,
    pub session_establishment: CatalogSessionEstablishmentPolicy,
    /// A3: declared client capabilities (typed reads, provider payload kept as data).
    pub client_capabilities: Option<CatalogClientCapabilities>,
    /// A3: declared launch environment additions, validated like the recipe env.
    pub launch_env: Vec<CatalogLaunchEnv>,
    /// A3: closed private-interaction bridges. An empty list means the provider
    /// declares no catalog-level bridge restriction.
    pub interaction_bridges: Vec<CatalogInteractionBridge>,
}

/// Closed bridge identity. One enum for both the catalog declaration and the
/// adapter that consumes it, so an unknown parser name cannot be "handled" by
/// a second, looser matching table.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CatalogBridgeId {
    GrokExtQuestions,
    PiSelectAsk,
    GrokExitPlan,
    CodexElicitation,
}

/// One catalog-declared private interaction bridge.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogInteractionBridge {
    pub method: String,
    pub parser: CatalogBridgeId,
}

/// Declared client capabilities. The payload is provider DATA — arbitrary
/// extension keys such as `_meta.jetbrains.air` — so it stays a map rather than
/// a set of invented strategy ids; readers use the typed accessors below instead
/// of parsing JSON at the call site.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct CatalogClientCapabilities {
    declarations: serde_json::Map<String, serde_json::Value>,
}

impl CatalogClientCapabilities {
    /// Validated from a catalog object: every key must be a boolean flag or an
    /// object payload. Anything else is a shape the merge step cannot apply.
    pub(crate) fn from_value(provider: &str, value: &serde_json::Value) -> Result<Self, String> {
        let object = value.as_object().ok_or_else(|| {
            format!("Agent Catalog {provider}.adaptation.clientCapabilities 必须是对象")
        })?;
        for (key, entry) in object {
            if key.trim().is_empty() {
                return Err(format!(
                    "Agent Catalog {provider}.adaptation.clientCapabilities 含空键"
                ));
            }
            if !(entry.is_boolean() || entry.is_object()) {
                return Err(format!(
                    "Agent Catalog {provider}.adaptation.clientCapabilities.{key} 必须是 boolean 或对象"
                ));
            }
        }
        Ok(Self {
            declarations: object.clone(),
        })
    }

    pub fn declarations(&self) -> &serde_json::Map<String, serde_json::Value> {
        &self.declarations
    }

    /// Declared boolean flag (`subagent-transcript` style). Codeg's shape nests
    /// these inside the provider `meta` payload, so both places are honored.
    pub fn flag(&self, key: &str) -> Option<bool> {
        self.declarations
            .get(key)
            .and_then(serde_json::Value::as_bool)
            .or_else(|| {
                self.meta()
                    .and_then(|meta| meta.get(key))
                    .and_then(serde_json::Value::as_bool)
            })
    }

    /// Provider-specific extension payload (`_meta` / `meta`).
    pub fn meta(&self) -> Option<&serde_json::Map<String, serde_json::Value>> {
        self.declarations
            .get("_meta")
            .or_else(|| self.declarations.get("meta"))
            .and_then(serde_json::Value::as_object)
    }
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
    pub version_args: Vec<String>,
    pub package_manager: Option<CatalogPackageManager>,
    pub requires: CatalogRequirements,
    pub checks: Vec<CatalogCheck>,
    /// A1: declared when this provider's ACP entry wraps a separate vendor CLI.
    /// Detection uses the native command and extra dirs as additional evidence;
    /// preflight uses it to tell `adapterMissing` from `nativeMissing`.
    pub adapter_relation: Option<CatalogAdapterRelation>,
    /// A1: declared version gates, projected to closed identities. Empty when
    /// the provider declares none.
    pub version_gates: Vec<CatalogVersionGate>,
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
        if let Some(launch) = &entry.launch {
            launch.validate(&entry.provider)?;
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

/// Adaptation policies read out of the catalog's untyped adaptation block.
///
/// One reader for both `detection_profiles` and `provider_profile`: an unknown
/// strategy fails closed here instead of reaching a consumer as loose JSON.
#[derive(Debug, Clone, Default)]
struct ProjectedAdaptation {
    adapter_relation: Option<CatalogAdapterRelation>,
    version_gates: Vec<CatalogVersionGate>,
    session_establishment: Option<CatalogSessionEstablishmentPolicy>,
    client_capabilities: Option<CatalogClientCapabilities>,
    launch_env: Vec<CatalogLaunchEnv>,
    interaction_bridges: Vec<CatalogInteractionBridge>,
}

fn project_adaptation(
    provider: &str,
    adaptation: Option<&CatalogAdaptation>,
) -> Result<ProjectedAdaptation, String> {
    let mut projected = ProjectedAdaptation::default();
    let Some(adaptation) = adaptation else {
        return Ok(projected);
    };
    if let Some(value) = &adaptation.adapter_relation {
        let relation: CatalogAdapterRelation = parse_policy(provider, "adapterRelation", value)?;
        validate_adapter_relation(provider, &relation)?;
        projected.adapter_relation = Some(relation);
    }
    if let Some(value) = &adaptation.version_gates {
        let gates: CatalogVersionGates = parse_policy(provider, "versionGates", value)?;
        projected.version_gates = gates.to_gates(provider)?;
    }
    if let Some(value) = &adaptation.session_establishment {
        let policy: CatalogSessionEstablishmentPolicy =
            parse_policy(provider, "sessionEstablishment", value)?;
        validate_session_establishment(provider, &policy)?;
        projected.session_establishment = Some(policy);
    }
    if let Some(value) = &adaptation.client_capabilities {
        projected.client_capabilities =
            Some(CatalogClientCapabilities::from_value(provider, value)?);
    }
    if let Some(value) = &adaptation.launch_env {
        let entries: Vec<CatalogLaunchEnv> = parse_policy(provider, "launchEnv", value)?;
        // 复用 launch recipe 的 env 校验：名称必须合法且不得声明凭据。
        for entry in &entries {
            validate_launch_env_entry(provider, entry)?;
        }
        projected.launch_env = entries;
    }
    if let Some(value) = &adaptation.interaction_bridges {
        let bridges: Vec<CatalogInteractionBridge> =
            parse_policy(provider, "interactionBridges", value)?;
        validate_interaction_bridges(provider, &bridges)?;
        projected.interaction_bridges = bridges;
    }
    // 尚无消费者的策略块（promptCapabilities/configAdaptation/mcp）只做形状校验：
    // 没有消费者就不发明策略 id（否则是投机 schema），但已声明就得是对象。
    for (name, value) in [
        ("promptCapabilities", &adaptation.prompt_capabilities),
        ("configAdaptation", &adaptation.config_adaptation),
        ("mcp", &adaptation.mcp),
    ] {
        if let Some(value) = value {
            if !value.is_object() {
                return Err(format!(
                    "Agent Catalog {provider}.adaptation.{name} 必须是对象"
                ));
            }
        }
    }
    Ok(projected)
}

/// Runtime checks derived from a provider's declared `requires`.
///
/// The catalog may state `requires.node` / `requires.uv` without spelling out the
/// matching check. Codeg builds exactly these items in
/// `acp/preflight.rs::build_node_version_check` (Node fix = OpenUrl
/// `https://nodejs.org/`; uv fix = InstallUv with an empty payload), so a
/// declared requirement must become a visible check rather than staying inert
/// data — before this projection, `requires` was parsed and projected but read
/// by nothing, so a catalog Node floor produced no state at all.
///
/// A declared check of the same kind wins: a provider that spells out its own
/// node/uv check is not given a duplicate. That is also what keeps the detection
/// fixture byte-stable.
fn runtime_requirement_checks(
    requires: &CatalogRequirements,
    declared: &[CatalogCheck],
) -> Vec<CatalogCheck> {
    let mut checks = declared.to_vec();
    let present =
        |checks: &[CatalogCheck], kind: CatalogCheckKind| checks.iter().any(|c| c.kind == kind);
    let mut synthesize =
        |kind: CatalogCheckKind, id: &str, label: &str, min: &str, fix: CatalogFix| {
            if present(&checks, kind) {
                return;
            }
            let mut params = serde_json::Map::new();
            params.insert("min".into(), serde_json::Value::String(min.to_string()));
            checks.push(CatalogCheck {
                id: id.to_string(),
                label: label.to_string(),
                kind,
                params,
                fix: Some(fix),
            });
        };
    let trimmed_min = |value: &Option<String>| -> Option<String> {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    if let Some(min) = trimmed_min(&requires.node) {
        synthesize(
            CatalogCheckKind::NodeMin,
            "node-min",
            "Node.js",
            &min,
            CatalogFix {
                kind: CatalogFixKind::OpenUrl,
                payload: "https://nodejs.org/".into(),
            },
        );
    }
    if let Some(min) = trimmed_min(&requires.uv) {
        synthesize(
            CatalogCheckKind::UvMin,
            "uv-min",
            "uv",
            &min,
            CatalogFix {
                kind: CatalogFixKind::InstallUv,
                payload: String::new(),
            },
        );
    }
    checks
}

pub fn detection_profiles() -> Result<Vec<AgentDetectionProfile>, String> {
    let document = catalog()?;
    let mut profiles = Vec::with_capacity(document.providers.len());
    for entry in &document.providers {
        let adaptation = project_adaptation(&entry.provider, entry.adaptation.as_ref())?;
        profiles.push(AgentDetectionProfile {
            detector_id: entry.detection.detector_id.clone(),
            provider: entry.provider.clone(),
            display_name: entry.display_name.clone(),
            priority: entry.detection.priority,
            invocations: entry.detection.invocations.clone(),
            config_dirs: entry.detection.config_dirs.clone(),
            config_evidence: entry.detection.config_evidence.clone(),
            version_args: entry.detection.version_args.clone(),
            package_manager: entry.detection.package_manager.clone(),
            requires: entry.detection.requires.clone(),
            checks: runtime_requirement_checks(&entry.detection.requires, &entry.detection.checks),
            adapter_relation: adaptation.adapter_relation,
            version_gates: adaptation.version_gates,
        });
    }
    // Stable sort preserves catalog order for equal-priority providers.
    profiles.sort_by_key(|profile| std::cmp::Reverse(profile.priority));
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

/// Return the single declarative adaptation policy for a provider. Consumers
/// must interpret this projection; no provider-specific behavior lives here.
pub fn adaptation(provider: &str) -> Result<Option<CatalogAdaptation>, String> {
    Ok(catalog()?
        .providers
        .iter()
        .find(|entry| entry.provider.eq_ignore_ascii_case(provider))
        .and_then(|entry| entry.adaptation.clone()))
}

fn parse_policy<T: serde::de::DeserializeOwned>(
    provider: &str,
    field: &str,
    value: &serde_json::Value,
) -> Result<T, String> {
    serde_json::from_value(value.clone())
        .map_err(|error| format!("Agent Catalog {provider}.adaptation.{field} 非法: {error}"))
}

/// Return the strong-typed projection for one provider.
///
/// `Ok(None)` means the provider is not in the catalog at all. A declared
/// provider whose launch recipe or adaptation policy is malformed returns
/// `Err` — an incomplete profile is never silently treated as absent.
pub fn provider_profile(provider: &str) -> Result<Option<PylonAgentProfile>, String> {
    let document = catalog()?;
    let Some(entry) = document
        .providers
        .iter()
        .find(|entry| entry.provider.eq_ignore_ascii_case(provider))
    else {
        return Ok(None);
    };
    let launch = entry
        .launch
        .clone()
        .ok_or_else(|| format!("Agent Catalog {}.launch 未声明", entry.provider))?;
    launch.validate(&entry.provider)?;
    let adaptation = project_adaptation(&entry.provider, entry.adaptation.as_ref())?;
    Ok(Some(PylonAgentProfile {
        provider: entry.provider.clone(),
        display_name: entry.display_name.clone(),
        launch,
        adapter_relation: adaptation.adapter_relation,
        version_gates: adaptation.version_gates,
        session_establishment: adaptation.session_establishment.unwrap_or_default(),
        client_capabilities: adaptation.client_capabilities,
        launch_env: adaptation.launch_env,
        interaction_bridges: adaptation.interaction_bridges,
    }))
}

/// Return the protocol baseline in stable shared-catalog order.
///
/// This is deliberately a projection rather than a direct reference to the
/// deserialized document: the desktop runtime can safely merge its actual
/// adapter registry without exposing the catalog's private schema types.
pub fn protocol_profiles() -> Result<Vec<CatalogProtocolProfile>, String> {
    Ok(catalog()?
        .providers
        .iter()
        .map(|entry| CatalogProtocolProfile {
            provider: entry.provider.clone(),
            display_name: entry.display_name.clone(),
            session_updates: entry.capabilities.session_updates,
            interaction_events: entry.capabilities.interaction_events,
            permission_requests: entry.capabilities.permission_requests,
            replay: entry.capabilities.replay,
            response_methods: entry.capabilities.response_methods.clone(),
            interaction_kinds: entry.interaction_kinds.clone(),
            set_model_api: entry.protocol_defaults.set_model_api,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_v2_fixture_and_empty_defaults() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/agent-catalog-detection.fixture.json"
        ))
        .unwrap();
        let mut document: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        let detection = document["providers"][0]["detection"]
            .as_object_mut()
            .unwrap();
        detection.extend(fixture.as_object().unwrap().clone());
        let parsed = parse_catalog(&document.to_string()).unwrap();
        let policy = &parsed.providers[0].detection;
        assert_eq!(
            serde_json::to_value(&policy.version_args).unwrap(),
            fixture["versionArgs"]
        );
        assert_eq!(
            serde_json::to_value(&policy.package_manager).unwrap(),
            fixture["packageManager"]
        );
        assert_eq!(
            serde_json::to_value(&policy.requires).unwrap(),
            fixture["requires"]
        );
        assert_eq!(
            serde_json::to_value(&policy.checks).unwrap(),
            fixture["checks"]
        );
        let detection = document["providers"][0]["detection"]
            .as_object_mut()
            .unwrap();
        for key in fixture.as_object().unwrap().keys() {
            detection.remove(key);
        }
        let parsed = parse_catalog(&document.to_string()).unwrap();
        let policy = &parsed.providers[0].detection;
        assert!(policy.version_args.is_empty() && policy.checks.is_empty());
        assert!(policy.package_manager.is_none());
        assert_eq!(
            serde_json::to_value(&policy.requires).unwrap(),
            serde_json::json!({"node": null, "uv": null})
        );
    }

    #[test]
    fn detection_v2_rejects_wrong_shapes_and_unknown_kinds() {
        for invalid in [
            serde_json::json!({"packageManager": "npx"}),
            serde_json::json!({"requires": []}),
            serde_json::json!({"checks": ["node-min"]}),
            serde_json::json!({"packageManager": {"kind": "npm"}}),
            serde_json::json!({"requires": {"python": "3"}}),
            serde_json::json!({"checks": [{"id":"x", "label":"x", "kind":"shell", "params":{}}]}),
            serde_json::json!({"checks": [{"id":"x", "label":"x", "kind":"node-min", "params":{}, "fix":{"kind":"execute", "payload":"command"}}]}),
        ] {
            let mut document: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
            document["providers"][0]["detection"]
                .as_object_mut()
                .unwrap()
                .extend(invalid.as_object().unwrap().clone());
            assert!(
                parse_catalog(&document.to_string()).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn shared_catalog_is_valid_and_excludes_rpc_only_pi() {
        let catalog = parse_catalog(CATALOG_JSON).expect("shared catalog must remain valid");
        assert_eq!(catalog.schema_version, 3);
        // A5①：catalog 新增 codex（wrapper relation + 双证据探测）。列表仍为精确断言。
        assert_eq!(
            catalog
                .providers
                .iter()
                .map(|entry| entry.provider.as_str())
                .collect::<Vec<_>>(),
            ["peri", "hermes", "claude-code", "codex"]
        );
        assert!(catalog.providers.iter().all(|entry| entry.provider != "pi"));
    }

    /// Schema v3 契约：只有 v3 被接受，v1/v2 一律 fail-closed 拒绝。
    ///
    /// 既有断言（v1 拒绝）保留，只补 v2 一行；前提变更是 A0 的 schema 升级本身。
    #[test]
    fn catalog_rejects_older_schemas_and_unknown_top_level_fields() {
        for version in [1, 2] {
            let mut older: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
            older["schemaVersion"] = serde_json::json!(version);
            assert!(
                parse_catalog(&older.to_string()).is_err(),
                "schemaVersion {version} 必须被拒绝"
            );
        }

        let mut unknown: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        unknown["unexpected"] = serde_json::json!(true);
        assert!(parse_catalog(&unknown.to_string()).is_err());
    }

    fn catalog_with_launch(launch: serde_json::Value) -> serde_json::Value {
        let mut document: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        document["providers"][0]["launch"] = launch;
        document
    }

    /// B0：catalog 声明的 `requires` 变成**可见检查**（修复「解析并投影但无人读」的缺口）。
    ///
    /// 三件事一起锁：合成规则、真源 fix 载荷、以及「未声明就不新增检查」的既有前提。
    #[test]
    fn declared_runtime_requirements_become_visible_checks() {
        // 只声明 requires.node → 合成 node-min，fix 与 Codeg 真源一致。
        let node = runtime_requirement_checks(
            &CatalogRequirements {
                node: Some("20.0.0".into()),
                uv: None,
            },
            &[],
        );
        assert_eq!(node.len(), 1);
        assert_eq!(node[0].id, "node-min");
        assert_eq!(node[0].kind, CatalogCheckKind::NodeMin);
        assert_eq!(node[0].params["min"], "20.0.0");
        let fix = node[0].fix.as_ref().expect("合成检查必须带 fix");
        assert_eq!(fix.kind, CatalogFixKind::OpenUrl);
        assert_eq!(fix.payload, "https://nodejs.org/");

        // requires.uv → uv-min，fix = InstallUv + 空载荷（真源如此）。
        let uv = runtime_requirement_checks(
            &CatalogRequirements {
                node: None,
                uv: Some("0.5.0".into()),
            },
            &[],
        );
        assert_eq!(uv.len(), 1);
        assert_eq!(uv[0].kind, CatalogCheckKind::UvMin);
        let fix = uv[0].fix.as_ref().expect("合成检查必须带 fix");
        assert_eq!(fix.kind, CatalogFixKind::InstallUv);
        assert_eq!(fix.payload, "");

        // 已显式声明同种检查 → 不重复产出，且顺序保持声明优先。
        let declared = vec![CatalogCheck {
            id: "node-min".into(),
            label: "Node.js".into(),
            kind: CatalogCheckKind::NodeMin,
            params: serde_json::Map::new(),
            fix: None,
        }];
        let merged = runtime_requirement_checks(
            &CatalogRequirements {
                node: Some("22.12.0".into()),
                uv: None,
            },
            &declared,
        );
        assert_eq!(merged.len(), 1, "显式声明同种检查时不得重复产出");
        assert_eq!(merged[0].id, "node-min");

        // 空/空白 requires 不产生任何检查。
        assert!(runtime_requirement_checks(
            &CatalogRequirements {
                node: Some("   ".into()),
                uv: None,
            },
            &[]
        )
        .is_empty());

        // 真实 catalog：codex 声明了 node 下限，未声明 requires 的 provider 不受影响。
        let profiles = detection_profiles().expect("catalog 必须可解析");
        let codex = profiles
            .iter()
            .find(|profile| profile.provider == "codex")
            .expect("codex 必须在 catalog 中");
        assert!(codex.checks.iter().any(
            |check| check.kind == CatalogCheckKind::NodeMin && check.params["min"] == "20.0.0"
        ));
        for provider in ["peri", "hermes", "claude-code"] {
            let profile = profiles
                .iter()
                .find(|profile| profile.provider == provider)
                .expect("provider 必须在 catalog 中");
            assert!(
                profile.checks.is_empty(),
                "{provider} 未声明 requires 且未声明 checks，不得新增检查项"
            );
        }
    }

    #[test]
    fn every_declared_provider_has_a_windows_only_launch_recipe() {
        for provider in ["peri", "hermes", "claude-code"] {
            let profile = provider_profile(provider)
                .unwrap_or_else(|error| panic!("{provider}: {error}"))
                .unwrap_or_else(|| panic!("{provider} 必须在 catalog 中"));
            assert_eq!(profile.launch.kind, CatalogLaunchKind::Path);
            assert_eq!(
                profile.session_establishment.order,
                vec![
                    CatalogSessionMethod::Resume,
                    CatalogSessionMethod::Load,
                    CatalogSessionMethod::New,
                ]
            );
            assert!(
                profile.launch.env.is_empty(),
                "{provider} 不得在 profile 内声明环境变量"
            );
        }
        assert!(provider_profile("missing").unwrap().is_none());
    }

    #[test]
    fn unknown_launch_strategy_and_unknown_launch_field_fail_closed() {
        assert!(parse_catalog(
            &catalog_with_launch(serde_json::json!({
                "kind": "deno",
                "command": "x"
            }))
            .to_string()
        )
        .is_err());
        assert!(parse_catalog(
            &catalog_with_launch(serde_json::json!({
                "kind": "path",
                "command": "x",
                "shellExpansion": true
            }))
            .to_string()
        )
        .is_err());
    }

    #[test]
    fn windows_only_launch_rejects_unix_argv_and_credentials() {
        for launch in [
            serde_json::json!({"kind": "path", "command": "agent", "args": ["/bin/sh", "-c", "agent"]}),
            serde_json::json!({"kind": "path", "command": "sh", "args": ["-c", "agent"]}),
            serde_json::json!({"kind": "path", "command": "agent", "args": ["--signal", "SIGTERM"]}),
            serde_json::json!({"kind": "path", "command": "agent", "args": ["--signal", "SIGTERM"]}),
            serde_json::json!({"kind": "path", "command": "C:\\tools\\agent.exe"}),
            serde_json::json!({"kind": "path", "command": "agent", "env": [{"name": "ANTHROPIC_API_KEY", "value": ""}]}),
        ] {
            assert!(
                parse_catalog(&catalog_with_launch(launch.clone()).to_string()).is_err(),
                "accepted {launch}"
            );
        }
    }

    #[test]
    fn provider_profile_projects_closed_claude_wrapper_policy() {
        let profile = provider_profile("claude-code").unwrap().unwrap();
        let relation = profile.adapter_relation.expect("claude-code 是 adapter");
        assert_eq!(relation.native_cmd, "claude");
        assert_eq!(relation.shared_config_dir, "~/.claude");
        assert_eq!(relation.extra_dirs, vec![".local/bin", ".claude/local"]);
        assert_eq!(
            profile.version_gates,
            vec![
                CatalogVersionGate {
                    id: CatalogVersionGateId::SteeringPromptRequired,
                    min_version: Some("0.65.0".into()),
                    enabled: true,
                    evidence: CatalogVersionEvidence::AdapterAgentInfoVersion,
                },
                CatalogVersionGate {
                    id: CatalogVersionGateId::GoalControlOutOfBand,
                    min_version: None,
                    enabled: false,
                    evidence: CatalogVersionEvidence::StaticPolicy,
                },
                CatalogVersionGate {
                    id: CatalogVersionGateId::CursorAcpBackend,
                    min_version: None,
                    enabled: false,
                    evidence: CatalogVersionEvidence::LaunchRecipe,
                },
            ]
        );
        // 原生 ACP provider 没有 adapter relation，也没有版本 gate。
        let peri = provider_profile("peri").unwrap().unwrap();
        assert!(peri.adapter_relation.is_none());
        assert!(peri.version_gates.is_empty());
    }

    #[test]
    fn provider_profile_fails_closed_on_unknown_adaptation_policy() {
        let mut unknown_gate: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        unknown_gate["providers"][2]["adaptation"]["versionGates"]["futureGate"] =
            serde_json::json!(true);
        assert!(parse_catalog(&unknown_gate.to_string()).is_ok());
        // `parse_catalog` accepts the raw block (it is `Value` until projection),
        // but the strong projection must refuse to invent a gate identity.
        let document: serde_json::Value = serde_json::from_str(&unknown_gate.to_string()).unwrap();
        let raw = document["providers"][2]["adaptation"]["versionGates"].clone();
        assert!(serde_json::from_value::<CatalogVersionGates>(raw).is_err());

        let mut bad_order: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        bad_order["providers"][2]["adaptation"]["sessionEstablishment"] =
            serde_json::json!({"order": ["new", "resume"]});
        assert!(parse_catalog(&bad_order.to_string()).is_ok());
        let policy: CatalogSessionEstablishmentPolicy = serde_json::from_value(
            bad_order["providers"][2]["adaptation"]["sessionEstablishment"].clone(),
        )
        .unwrap();
        assert!(validate_session_establishment("claude-code", &policy).is_err());
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

    #[test]
    fn protocol_projection_is_serializable_and_keeps_catalog_order() {
        let profiles = protocol_profiles().expect("protocol baseline must parse");
        assert_eq!(
            profiles
                .iter()
                .map(|entry| entry.provider.as_str())
                .collect::<Vec<_>>(),
            ["peri", "hermes", "claude-code", "codex"]
        );
        let hermes = profiles
            .iter()
            .find(|entry| entry.provider == "hermes")
            .unwrap();
        assert!(!hermes.permission_requests);
        assert_eq!(hermes.set_model_api, CatalogSetModelApi::SetModel);
        let json = serde_json::to_value(&profiles).expect("projection must serialize");
        assert_eq!(json[0]["displayName"], "Peri");
        assert_eq!(json[1]["setModelApi"], "set_model");
    }

    #[test]
    fn catalog_rejects_interaction_bridge_secret_env_and_capability_shapes() {
        // 未知 parser id：强投影即拒（没有第二张宽松的字符串表）。
        let mut unknown_parser: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        unknown_parser["providers"][2]["adaptation"]["interactionBridges"] =
            serde_json::json!([{ "method": "future/m", "parser": "future" }]);
        let document = parse_catalog(&unknown_parser.to_string()).unwrap();
        assert!(project_adaptation(
            &document.providers[2].provider,
            document.providers[2].adaptation.as_ref()
        )
        .is_err());

        // 重复 method 必须拒绝（否则“声明集合”是不确定的）。
        let mut duplicate: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        duplicate["providers"][2]["adaptation"]["interactionBridges"] = serde_json::json!([
            { "method": "pi/select_ask", "parser": "pi_select_ask" },
            { "method": "pi/select_ask", "parser": "grok_ext_questions" }
        ]);
        let document = parse_catalog(&duplicate.to_string()).unwrap();
        assert!(project_adaptation(
            &document.providers[2].provider,
            document.providers[2].adaptation.as_ref()
        )
        .is_err());

        // launchEnv 不得声明凭据类名称，也不得给空值。
        for entry in [
            serde_json::json!([{ "name": "ANTHROPIC_API_KEY", "value": "x" }]),
            serde_json::json!([{ "name": "1BAD", "value": "x" }]),
            serde_json::json!([{ "name": "OK", "value": "  " }]),
        ] {
            let mut document: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
            document["providers"][0]["adaptation"] = serde_json::json!({ "launchEnv": entry });
            let parsed = parse_catalog(&document.to_string()).unwrap();
            assert!(
                project_adaptation(
                    &parsed.providers[0].provider,
                    parsed.providers[0].adaptation.as_ref()
                )
                .is_err(),
                "accepted {entry}"
            );
        }

        // clientCapabilities 只接受 boolean / object 值。
        for invalid in [
            serde_json::json!("nope"),
            serde_json::json!({ "flag": "yes" }),
            serde_json::json!({ "flag": [1, 2] }),
        ] {
            let mut document: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
            document["providers"][0]["adaptation"] =
                serde_json::json!({ "clientCapabilities": invalid });
            let parsed = parse_catalog(&document.to_string()).unwrap();
            assert!(
                project_adaptation(
                    &parsed.providers[0].provider,
                    parsed.providers[0].adaptation.as_ref()
                )
                .is_err(),
                "accepted {invalid}"
            );
        }

        // 已声明但无消费者的策略块必须是对象（没有消费者就不发明策略 id）。
        let mut non_object: serde_json::Value = serde_json::from_str(CATALOG_JSON).unwrap();
        non_object["providers"][0]["adaptation"] = serde_json::json!({ "mcp": ["x"] });
        let parsed = parse_catalog(&non_object.to_string()).unwrap();
        assert!(project_adaptation(
            &parsed.providers[0].provider,
            parsed.providers[0].adaptation.as_ref()
        )
        .is_err());
    }

    #[test]
    fn declared_capabilities_keep_provider_payload_as_data() {
        let profile = provider_profile("claude-code").unwrap().unwrap();
        let capabilities = profile.client_capabilities.expect("claude 声明了 caps");
        // 已声明的布尔旗标与 meta 内嵌旗标都能读到。
        assert_eq!(capabilities.flag("subagent-transcript"), Some(true));
        assert_eq!(capabilities.flag("missing-flag"), None);
        assert!(capabilities
            .meta()
            .is_some_and(|meta| meta.contains_key("jetbrains.air")));
        // 非 wrapper provider 不声明 caps，也不声明 bridge。
        let peri = provider_profile("peri").unwrap().unwrap();
        assert!(peri.client_capabilities.is_none());
        assert!(peri.interaction_bridges.is_empty());
        assert!(peri.launch_env.is_empty());
    }

    #[test]
    fn legacy_adaptation_value_projection_is_unchanged() {
        // A3 之前 `provider_adapter` 仍读 `Value` 形状；A0 新增强类型 projection
        // 不得暗中改变既有 adapterRelation/versionGates 的序列化外形。
        let claude = adaptation("claude-code").unwrap().unwrap();
        assert_eq!(
            claude.adapter_relation.unwrap()["extraDirs"],
            serde_json::json!([".local/bin", ".claude/local"])
        );
    }

    /// A0 起三个内置 provider 都声明了 sessionEstablishment，因此「未声明即为空」
    /// 的旧前提已失效：改为验证 `Value` 形状仍按声明范围投影（未声明字段为
    /// null，未声明 provider 仍为 None），以及 claude-code 的既有值不变。
    #[test]
    fn adaptation_policy_is_provider_scoped_and_keeps_declared_values() {
        assert!(adaptation("missing").unwrap().is_none());
        let peri = adaptation("peri").unwrap().unwrap();
        assert!(peri.adapter_relation.is_none());
        assert!(peri.version_gates.is_none());
        assert!(peri.session_establishment.is_some());
        let claude = adaptation("claude-code").unwrap().unwrap();
        assert_eq!(
            claude.version_gates.unwrap()["steeringPromptRequiredMinVersion"],
            "0.65.0"
        );
        assert_eq!(claude.adapter_relation.unwrap()["nativeCmd"], "claude");
    }
}
