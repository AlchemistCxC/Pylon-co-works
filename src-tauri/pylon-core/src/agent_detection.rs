//! Controlled first-party Agent runtime discovery. No recursive disk scan and no ACP initialize.
use crate::agent_catalog::{
    AgentDetectionProfile, CatalogConfigEvidence, CatalogConfigFormat, CatalogInvocation,
};
use crate::agent_preflight::ToolVersion;

use futures_util::StreamExt;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};

const MAX_PACKAGE_MANAGER_CHILDREN: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetectionEvidence {
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetectionDiagnostic {
    pub code: String,
    pub stage: String,
    pub detector_id: Option<String>,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetectionReport {
    pub candidates: Vec<AgentRuntimeCandidate>,
    /// Dual ACP/vendor-CLI evidence per selected provider. Present even when a
    /// provider has no ACP candidate, which is what makes `adapterMissing`
    /// observable instead of indistinguishable from "provider absent".
    pub providers: Vec<AgentProviderEvidence>,
    pub diagnostics: Vec<AgentDetectionDiagnostic>,
    pub elapsed_ms: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IdentityConfidence {
    Exact,
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolAvailability {
    NotTested,
    Verified,
    Failed,
}

/// Evidence that the discovered executable can be started independently of
/// whether it completed an ACP handshake.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Startability {
    NotTested,
    Verified,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCandidate {
    pub candidate_id: String,
    pub detector_id: String,
    pub provider: String,
    pub suggested_agent_id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
    pub evidence: Vec<AgentDetectionEvidence>,
    pub identity_confidence: IdentityConfidence,
    pub startability: Startability,
    pub protocol_availability: ProtocolAvailability,
    pub already_imported_agent_id: Option<String>,
    pub warnings: Vec<String>,
}

/// Standalone detection inputs. Supplying search roots disables platform root
/// expansion and registry lookup, which keeps CLI fixtures deterministic.
#[derive(Debug, Clone)]
pub struct AgentDetectionLimits {
    pub total_budget: Duration,
    pub version_probe_budget: Duration,
    pub max_candidates: usize,
    pub max_concurrent_probes: usize,
}

impl Default for AgentDetectionLimits {
    fn default() -> Self {
        Self {
            total_budget: Duration::from_secs(8),
            version_probe_budget: Duration::from_secs(2),
            max_candidates: 32,
            max_concurrent_probes: 4,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct AgentDetectionOptions {
    pub detector_ids: Option<Vec<String>>,
    pub home_dir: Option<PathBuf>,
    pub search_roots: Option<Vec<PathBuf>>,
    pub limits: AgentDetectionLimits,
}

fn path_key(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = canonical.to_string_lossy().to_string();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn stable_candidate_id(detector_id: &str, executable_key: &str, args: &[String]) -> String {
    // Stable FNV-1a over unambiguous length-prefixed fields. This is an identity
    // key, not a security boundary; length prefixes prevent concatenation aliasing.
    let mut hash = 0xcbf29ce484222325u64;
    for field in std::iter::once(detector_id.as_bytes())
        .chain(std::iter::once(executable_key.as_bytes()))
        .chain(args.iter().map(String::as_bytes))
    {
        for byte in (field.len() as u64).to_le_bytes().iter().chain(field) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{detector_id}:{hash:016x}")
}

fn executable_names(command: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![
            format!("{command}.exe"),
            format!("{command}.cmd"),
            format!("{command}.bat"),
            command.into(),
        ]
    } else {
        vec![command.into()]
    }
}

fn controlled_roots(overrides: Option<&[PathBuf]>) -> Vec<PathBuf> {
    if let Some(roots) = overrides {
        let mut roots = roots.to_vec();
        let mut seen = HashSet::new();
        roots.retain(|root| seen.insert(path_key(root)));
        return roots;
    }
    let mut roots: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    let additions = [
        std::env::var_os("LOCALAPPDATA").map(|v| PathBuf::from(v).join("Microsoft/WinGet/Links")),
        std::env::var_os("APPDATA").map(|v| PathBuf::from(v).join("npm")),
        std::env::var_os("USERPROFILE").map(|v| PathBuf::from(v).join(".local/bin")),
        std::env::var_os("USERPROFILE").map(|v| PathBuf::from(v).join(".cargo/bin")),
    ];
    roots.extend(additions.into_iter().flatten());
    // Python console scripts are not always added to PATH (pip --user, uv tool).
    // Only enumerate one bounded level under standard package-manager roots.
    for base in [
        std::env::var_os("APPDATA").map(|v| PathBuf::from(v).join("Python")),
        std::env::var_os("LOCALAPPDATA").map(|v| PathBuf::from(v).join("Programs/Python")),
        std::env::var_os("APPDATA").map(|v| PathBuf::from(v).join("uv/tools")),
    ]
    .into_iter()
    .flatten()
    {
        let Ok(children) = std::fs::read_dir(base) else {
            continue;
        };
        for child in children
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .take(MAX_PACKAGE_MANAGER_CHILDREN)
        {
            roots.push(child.join("Scripts"));
            roots.push(child.join("bin"));
        }
    }
    let mut seen = HashSet::new();
    roots.retain(|root| seen.insert(path_key(root)));
    roots
}

fn provider_roots(rule: &AgentDetectionProfile, include_platform_roots: bool) -> Vec<PathBuf> {
    if !include_platform_roots {
        return Vec::new();
    }
    // A1: adapter-relation extra dirs are probed after the platform roots, in
    // catalog order. Codeg's own Claude entry lists `.local/bin` and
    // `.claude/local` because a GUI app's PATH commonly lacks the vendor
    // installer's target; the relation is data, so the order comes from it.
    let mut roots: Vec<PathBuf> = rule
        .adapter_relation
        .as_ref()
        .map(|relation| {
            relation
                .extra_dirs
                .iter()
                .filter_map(|dir| home_relative_dir(dir))
                .collect()
        })
        .unwrap_or_default();
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return roots;
    };
    let root = PathBuf::from(local).join("Programs").join(&rule.provider);
    roots.push(root.clone());
    roots.push(root.join("bin"));
    roots
}

/// Expand one catalog-declared home-relative dir (`~/.claude/local`) against the
/// user profile. Returns `None` when the entry is not home-relative, so a
/// malformed relation cannot make detection read an arbitrary absolute path.
fn home_relative_dir(declared: &str) -> Option<PathBuf> {
    let trimmed = declared.trim();
    let relative = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
        .unwrap_or(trimmed);
    if relative.is_empty() || Path::new(relative).is_absolute() {
        return None;
    }
    if Path::new(relative)
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return None;
    }
    let home = resolved_home_dir(None)?;
    Some(home.join(relative))
}

#[cfg(windows)]
fn app_path_candidates(invocation: &CatalogInvocation) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    for hive in ["HKCU", "HKLM"] {
        let key = format!(
            r"{}\Software\Microsoft\Windows\CurrentVersion\App Paths\{}.exe",
            hive, invocation.command
        );
        let Ok(output) = std::process::Command::new("reg.exe")
            .args(["query", &key, "/ve"])
            .output()
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        if let Some(value) = text.lines().find_map(|line| {
            line.split_once("REG_SZ")
                .map(|(_, value)| value.trim())
                .filter(|value| !value.is_empty())
        }) {
            let path = PathBuf::from(value.trim_matches('"'));
            if path.is_file() {
                found.push((path, "app-path-registry".into()))
            }
        }
    }
    found
}

#[cfg(not(windows))]
fn app_path_candidates(_invocation: &CatalogInvocation) -> Vec<(PathBuf, String)> {
    Vec::new()
}

#[derive(Debug, PartialEq, Eq)]
enum LauncherResolution {
    Direct,
    Resolved(PathBuf),
    Incompatible,
}

fn detached_windows_launcher_target(content: &str) -> Result<Option<String>, ()> {
    for line in content.lines() {
        let trimmed = line.trim().trim_start_matches('@').trim_start();
        let lower = trimmed.to_ascii_lowercase();
        if !lower.starts_with("start ") {
            continue;
        }
        let quoted = trimmed.split('"').skip(1).step_by(2).collect::<Vec<_>>();
        if let Some(target) = quoted
            .into_iter()
            .find(|value| value.to_ascii_lowercase().ends_with(".exe"))
        {
            return Ok(Some(target.to_string()));
        }
        return Err(());
    }
    Ok(None)
}

fn resolve_stdio_executable(path: &Path) -> LauncherResolution {
    if !cfg!(windows)
        || !matches!(
            path.extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("cmd" | "bat")
        )
    {
        return LauncherResolution::Direct;
    }
    let Ok(metadata) = std::fs::metadata(path) else {
        return LauncherResolution::Direct;
    };
    if metadata.len() > 64 * 1024 {
        return LauncherResolution::Direct;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return LauncherResolution::Direct;
    };
    match detached_windows_launcher_target(&content) {
        Ok(None) => LauncherResolution::Direct,
        Ok(Some(target)) => {
            let target = PathBuf::from(target);
            let target = if target.is_absolute() {
                target
            } else {
                path.parent().unwrap_or(Path::new(".")).join(target)
            };
            if target.is_file() {
                LauncherResolution::Resolved(target)
            } else {
                LauncherResolution::Incompatible
            }
        }
        Err(()) => LauncherResolution::Incompatible,
    }
}

struct LocatedRuntime {
    executable: PathBuf,
    source: String,
    args: Vec<String>,
    alias_index: usize,
    evidence: Vec<AgentDetectionEvidence>,
    warnings: Vec<String>,
}

/// One located executable on the ACP or the vendor-CLI side of a provider.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvidenceHit {
    pub kind: String,
    pub path: String,
    pub source: String,
}

/// Per-provider dual evidence, emitted for every selected provider whether or
/// not an ACP candidate exists.
///
/// This is what makes `adapterMissing` observable: a wrapper provider whose ACP
/// command is absent still has a probe result here, so preflight can tell the
/// user whether the vendor CLI they already installed was actually found.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderEvidence {
    pub provider: String,
    pub detector_id: String,
    /// True when the catalog declares an adapter relation for this provider.
    pub adapter_relation_declared: bool,
    pub acp_commands: Vec<AgentEvidenceHit>,
    pub native_commands: Vec<AgentEvidenceHit>,
    /// Presence only — never the path and never a file's contents. The shared
    /// config/credential dir may contain secrets, so the detector reports that
    /// it was seen, not where or what was in it.
    pub shared_config_present: bool,
    /// Node.js state on this machine. Probed once per scan and attached to every
    /// provider, because the tool is a machine fact and not a per-provider one;
    /// only providers whose catalog `requires` names Node read it.
    pub node: ToolVersion,
    /// uv state on this machine; see `node`.
    pub uv: ToolVersion,
    /// The provider's own installed version when a local source could supply it
    /// (npm global metadata, which the executable probe cannot provide). The
    /// direct executable probe wins when it produced a version.
    pub adapter_version: Option<String>,
}

/// Bounded, read-only search for one command name across the same roots a
/// candidate search uses. Never spawns anything.
/// Where a located executable came from.
///
/// C2: shared by the candidate scan and the evidence scan, which label these
/// differently — the evidence side reports presence only (every root hit is
/// `known-path`), while the candidate side distinguishes an on-PATH root (it
/// warns when an off-PATH executable is about to be saved as an absolute path).
/// Both keep their own vocabulary; only the disk walk is shared.
enum FoundVia {
    /// A searched directory; `true` when that directory came from the process PATH.
    Root { on_path: bool },
    /// The Windows `App Paths` registry entry (never a PATH root).
    Registry { source: String },
}

/// The root set for one provider: the process PATH plus its controlled
/// additions, then the provider's own declared platform roots.
///
/// C2: computed in one place. The candidate scan and the evidence scan each
/// built their own copy of this expression, so the two walks could disagree
/// about where a provider is allowed to live.
fn resolve_roots(rule: &AgentDetectionProfile, search_roots: Option<&[PathBuf]>) -> Vec<PathBuf> {
    let include_platform_roots = search_roots.is_none();
    dedup_roots(
        controlled_roots(search_roots)
            .into_iter()
            .chain(provider_roots(rule, include_platform_roots))
            .collect(),
    )
}

/// Every `roots × executable_names(command)` hit, plus the Windows `App Paths`
/// registry entry when platform roots are in play.
///
/// C2: the one place a command lookup touches the disk. PATH membership is
/// resolved once per scan rather than once per candidate, which is what the
/// previous candidate loop did by re-splitting PATH for every file it tested.
fn scan_roots(
    roots: &[PathBuf],
    command: &str,
    include_registry: bool,
) -> Vec<(PathBuf, FoundVia)> {
    let on_path: HashSet<String> = std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .map(|path| path_key(&path))
                .collect()
        })
        .unwrap_or_default();
    let mut found = Vec::new();
    for root in roots {
        let root_on_path = on_path.contains(&path_key(root));
        for name in executable_names(command) {
            let candidate = root.join(name);
            if candidate.is_file() {
                found.push((
                    candidate,
                    FoundVia::Root {
                        on_path: root_on_path,
                    },
                ));
            }
        }
    }
    if include_registry {
        #[cfg(windows)]
        found.extend(
            app_path_candidates(&CatalogInvocation {
                command: command.to_string(),
                args: Vec::new(),
            })
            .into_iter()
            .map(|(path, source)| (path, FoundVia::Registry { source })),
        );
        #[cfg(not(windows))]
        let _ = include_registry;
    }
    found
}

fn locate_command(
    command: &str,
    roots: &[PathBuf],
    include_registry: bool,
) -> Vec<AgentEvidenceHit> {
    let mut hits: Vec<AgentEvidenceHit> = Vec::new();
    let mut seen = HashSet::new();
    for (path, via) in scan_roots(roots, command, include_registry) {
        if !seen.insert(path_key(&path)) {
            continue;
        }
        // Evidence reports presence, not how it was found: every root hit is
        // `known-path` here even when the root is on PATH.
        let source = match via {
            FoundVia::Root { .. } => "known-path".to_string(),
            FoundVia::Registry { source } => source,
        };
        hits.push(AgentEvidenceHit {
            kind: "native-command".into(),
            path: path.to_string_lossy().to_string(),
            source,
        });
    }
    hits
}

fn shared_config_present(
    relation: Option<&crate::agent_catalog::CatalogAdapterRelation>,
    explicit_home: Option<&Path>,
) -> bool {
    let Some(relation) = relation else {
        return false;
    };
    let declared = relation.shared_config_dir.trim();
    let relative = declared
        .strip_prefix("~/")
        .or_else(|| declared.strip_prefix("~\\"))
        .unwrap_or(declared);
    if relative.is_empty() || Path::new(relative).is_absolute() {
        return false;
    }
    let Some(home) = resolved_home_dir(explicit_home) else {
        return false;
    };
    home.join(relative).is_dir()
}

/// Find one command by name across the given roots. Returns the resolved path
/// when the command exists, `None` otherwise. Pure filesystem lookup.
fn locate_command_path(command: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    for root in roots {
        for name in executable_names(command) {
            let candidate = root.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Measure one required runtime tool (Node.js / uv).
///
/// Bounded and read-only: a plain executable lookup plus the same managed
/// version probe the provider search uses (timeout, output cap, process-tree
/// cleanup). No install, no cache write, no environment mutation.
///
/// The three outcomes are deliberately distinct — a missing tool is `Absent`
/// (a real, fixable failure) while an unreadable version is `Unknown` (never
/// reported as a violation).
async fn probe_tool_version(
    command: &str,
    version_args: &[String],
    roots: &[PathBuf],
    budget: Duration,
) -> ToolVersion {
    let Some(path) = locate_command_path(command, roots) else {
        return ToolVersion::Absent;
    };
    if budget.is_zero() {
        return ToolVersion::Unknown;
    }
    let outcome = version_probe("builtin.tool", path, version_args, budget).await;
    match outcome.version {
        Some(version) => ToolVersion::Known(version),
        None => ToolVersion::Unknown,
    }
}

/// ACP + vendor-CLI evidence for one provider. The native side is probed only
/// when the catalog declares an adapter relation, which is the only case where
/// a second CLI is part of the story.
fn provider_evidence(
    rule: &AgentDetectionProfile,
    search_roots: Option<&[PathBuf]>,
    explicit_home: Option<&Path>,
) -> AgentProviderEvidence {
    let include_registry = search_roots.is_none();
    let roots = resolve_roots(rule, search_roots);
    let mut acp_commands: Vec<AgentEvidenceHit> = Vec::new();
    let mut seen = HashSet::new();
    for invocation in &rule.invocations {
        for hit in locate_command(&invocation.command, &roots, include_registry) {
            let key = format!("{}|", hit.path);
            if seen.insert(key) {
                acp_commands.push(AgentEvidenceHit {
                    kind: "acp-command".into(),
                    ..hit
                });
            }
        }
    }
    let native_commands = rule
        .adapter_relation
        .as_ref()
        .map(|relation| locate_command(&relation.native_cmd, &roots, include_registry))
        .unwrap_or_default();
    AgentProviderEvidence {
        provider: rule.provider.clone(),
        detector_id: rule.detector_id.clone(),
        adapter_relation_declared: rule.adapter_relation.is_some(),
        acp_commands,
        native_commands,
        shared_config_present: shared_config_present(rule.adapter_relation.as_ref(), explicit_home),
        // Runtime tools and the provider package version are machine facts that
        // need an async probe (and an npm query). This sync scan phase leaves
        // them at "not measured"; the caller fills them in.
        node: ToolVersion::default(),
        uv: ToolVersion::default(),
        adapter_version: None,
    }
}

fn dedup_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(path_key(root)))
        .collect()
}

fn find_rule(
    rule: &AgentDetectionProfile,
    search_roots: Option<&[PathBuf]>,
) -> Vec<LocatedRuntime> {
    let include_platform_roots = search_roots.is_none();
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let roots = resolve_roots(rule, search_roots);
    for (alias_index, invocation) in rule.invocations.iter().enumerate() {
        for (candidate, via) in scan_roots(&roots, &invocation.command, include_platform_roots) {
            // `FoundVia` is moved into the match, so each arm must produce an
            // owned label — borrowing the registry's `source` would dangle.
            let source = match via {
                FoundVia::Root { on_path: true } => "path".to_string(),
                FoundVia::Root { on_path: false } => "known-path".to_string(),
                FoundVia::Registry { source } => source,
            };
            let original = candidate.clone();
            let (executable, launcher_evidence, warnings) =
                match resolve_stdio_executable(&candidate) {
                    LauncherResolution::Direct => (candidate, Vec::new(), Vec::new()),
                    LauncherResolution::Resolved(target) => {
                        let evidence = vec![AgentDetectionEvidence {
                            kind: "stdio-launcher-target".into(),
                            detail: target.to_string_lossy().into_owned(),
                        }];
                        let warnings = vec![
                            "检测到会新开窗口的 launcher；已改用其真实可执行文件以保留 ACP stdio"
                                .into(),
                        ];
                        (target, evidence, warnings)
                    }
                    LauncherResolution::Incompatible => continue,
                };
            if !seen.insert((path_key(&executable), invocation.args.clone())) {
                continue;
            }
            let mut evidence = vec![AgentDetectionEvidence {
                kind: source,
                detail: original.to_string_lossy().into_owned(),
            }];
            evidence.extend(launcher_evidence);
            found.push(LocatedRuntime {
                executable,
                source: evidence[0].kind.clone(),
                args: invocation.args.clone(),
                alias_index,
                evidence,
                warnings,
            });
        }
    }
    found
}

pub fn configured_executable_key(executable: &str) -> String {
    let path = Path::new(executable);
    if path.is_absolute() || path.components().count() > 1 {
        return match resolve_stdio_executable(path) {
            LauncherResolution::Resolved(target) => path_key(&target),
            _ => path_key(path),
        };
    }
    for root in controlled_roots(None) {
        for name in executable_names(executable) {
            let candidate = root.join(name);
            if candidate.is_file() {
                return match resolve_stdio_executable(&candidate) {
                    LauncherResolution::Resolved(target) => path_key(&target),
                    _ => path_key(&candidate),
                };
            }
        }
    }
    path_key(path)
}

fn resolved_home_dir(explicit: Option<&Path>) -> Option<PathBuf> {
    explicit.map(Path::to_path_buf).or_else(|| {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    })
}

fn field_present(value: &serde_json::Value, field_path: &str) -> bool {
    let mut current = value;
    for segment in field_path.split('.') {
        let Some(next) = current.get(segment) else {
            return false;
        };
        current = next;
    }
    match current {
        serde_json::Value::Null => false,
        serde_json::Value::String(value) => !value.trim().is_empty(),
        serde_json::Value::Array(value) => !value.is_empty(),
        serde_json::Value::Object(value) => !value.is_empty(),
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => true,
    }
}

fn structured_config_evidence(
    config_dir: &Path,
    rule: &CatalogConfigEvidence,
) -> Option<AgentDetectionEvidence> {
    let path = config_dir.join(&rule.relative_path);
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    let document: serde_json::Value = match rule.format {
        CatalogConfigFormat::Json => serde_json::from_str(&content).ok()?,
        CatalogConfigFormat::Yaml => serde_yml::from_str(&content).ok()?,
    };
    let matched = rule
        .fields
        .iter()
        .filter(|field| field_present(&document, field))
        .cloned()
        .collect::<Vec<_>>();
    if matched.is_empty() {
        return None;
    }
    // Deliberately report field names only. Values may contain credentials and
    // must never cross the detector boundary into GUI/CLI output.
    Some(AgentDetectionEvidence {
        kind: "config-fields".into(),
        detail: format!("{} [{}]", path.to_string_lossy(), matched.join(", ")),
    })
}

fn config_evidence(
    rule: &AgentDetectionProfile,
    explicit_home: Option<&Path>,
) -> Vec<AgentDetectionEvidence> {
    let mut dirs = Vec::new();
    if let Some(home) = resolved_home_dir(explicit_home) {
        dirs.extend(rule.config_dirs.iter().map(|name| home.join(name)));
    }
    if explicit_home.is_none() && rule.provider == "hermes" {
        if let Some(value) = std::env::var_os("HERMES_HOME") {
            dirs.push(PathBuf::from(value))
        }
    }
    let mut seen = HashSet::new();
    dirs.retain(|path| seen.insert(path_key(path)));
    let mut evidence = Vec::new();
    for path in dirs.into_iter().filter(|path| path.is_dir()) {
        evidence.push(AgentDetectionEvidence {
            kind: "config-directory".into(),
            detail: path.to_string_lossy().to_string(),
        });
        evidence.extend(
            rule.config_evidence
                .iter()
                .filter_map(|config_rule| structured_config_evidence(&path, config_rule)),
        );
    }
    evidence
}

const PROBE_OUTPUT_LIMIT: usize = 4 * 1024;

// Migrated from codeg `probe_cli_version_token`/`extract_version_token`.
// Keep parsing conservative: only version-looking tokens, never URLs or paths.
fn extract_version_token(text: &str) -> Option<String> {
    fn candidate(piece: &str) -> Option<String> {
        let piece = piece.trim_matches(|c: char| matches!(c, '(' | ')' | ',' | ';' | ':'));
        let value = piece
            .strip_prefix('v')
            .or_else(|| piece.strip_prefix('V'))
            .unwrap_or(piece);
        (value.chars().next().is_some_and(|c| c.is_ascii_digit())
            && value.contains('.')
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
        .then(|| value.to_string())
    }
    for line in text.lines() {
        for token in line.split_whitespace() {
            if token.contains("://") {
                continue;
            }
            if let Some(value) = token.split(['/', '@']).find_map(candidate) {
                return Some(value);
            }
        }
    }
    None
}

#[derive(Clone)]
struct VersionProbeOutcome {
    version: Option<String>,
    startability: Startability,
    diagnostic: Option<AgentDetectionDiagnostic>,
}

#[cfg(windows)]
struct ProbeJobObject {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Drop for ProbeJobObject {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(windows)]
unsafe impl Send for ProbeJobObject {}

struct ManagedProbeChild {
    child: tokio::process::Child,
    pid: Option<u32>,
    reaped: bool,
    #[cfg(windows)]
    job: Option<ProbeJobObject>,
}

impl ManagedProbeChild {
    fn new(child: tokio::process::Child) -> Self {
        let pid = child.id();
        #[cfg(windows)]
        let job = Self::attach_job(&child);
        Self {
            child,
            pid,
            reaped: false,
            #[cfg(windows)]
            job,
        }
    }

    #[cfg(windows)]
    fn attach_job(child: &tokio::process::Child) -> Option<ProbeJobObject> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return None;
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let Some(process) = child.raw_handle() else {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return None;
        };
        if configured == 0 || unsafe { AssignProcessToJobObject(job, process) } == 0 {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return None;
        }
        Some(ProbeJobObject { handle: job })
    }

    fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.child.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child.stderr.take()
    }

    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let result = self.child.wait().await;
        if result.is_ok() {
            self.reaped = true;
        }
        result
    }

    async fn kill_and_wait(&mut self) {
        if self.reaped {
            return;
        }
        #[cfg(windows)]
        if self.job.take().is_some() {
            let _ = self.child.wait().await;
            self.reaped = true;
            return;
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            let _ = tokio::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output()
                .await;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        self.reaped = true;
    }
}

impl Drop for ManagedProbeChild {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        // Windows job close kills the tree; kill_on_drop below covers the
        // direct child when job attachment was unavailable.
    }
}

async fn read_bounded<R: AsyncRead + Unpin>(mut reader: R) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(retained);
        }
        let remaining = PROBE_OUTPUT_LIMIT.saturating_sub(retained.len());
        retained.extend_from_slice(&chunk[..count.min(remaining)]);
    }
}

fn probe_diagnostic(
    detector_id: &str,
    code: &str,
    message: String,
    retryable: bool,
) -> AgentDetectionDiagnostic {
    AgentDetectionDiagnostic {
        code: code.into(),
        stage: "version_probe".into(),
        detector_id: Some(detector_id.into()),
        message,
        retryable,
    }
}

/// 版本探针缓存：(规范化路径, 版本参数, mtime) → 版本字符串。
/// One probe result per (executable, arguments, mtime).
///
/// The whole outcome is cached, not just the version: a CLI that does not
/// understand `--version` fails identically on every refresh, so remembering
/// nothing meant re-spawning it every time. A cached failure keeps its
/// diagnostic, so the second refresh reports the same reason as the first
/// rather than a bare failure.
///
/// Keyed by mtime so upgrading a CLI is a miss rather than a stale hit, which
/// also means each upgrade leaves its predecessor behind. Bounded and dropped
/// wholesale when full — it is a cache, and re-probing is always correct.
type VersionProbeCache =
    Mutex<HashMap<(String, Vec<String>, std::time::SystemTime), VersionProbeOutcome>>;

const MAX_VERSION_PROBE_CACHE_ENTRIES: usize = 64;

/// Cached wrapper around [`probe_version_uncached`].
async fn version_probe(
    detector_id: &str,
    executable: PathBuf,
    version_args: &[String],
    budget: Duration,
) -> VersionProbeOutcome {
    let cache_key = std::fs::metadata(&executable)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|mtime| (path_key(&executable), version_args.to_vec(), mtime));
    static CACHE: OnceLock<VersionProbeCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(key) = &cache_key {
        if let Some(cached) = cache.lock().ok().and_then(|c| c.get(key).cloned()) {
            return cached;
        }
    }
    // Budget exhaustion describes the caller's remaining deadline, not a fact
    // about the executable. Caching it would freeze "we ran out of time" into
    // "this CLI reports no version" for as long as the binary is unchanged.
    if budget.is_zero() {
        return VersionProbeOutcome {
            version: None,
            startability: Startability::NotTested,
            diagnostic: Some(probe_diagnostic(
                detector_id,
                "detection_budget_exhausted",
                "Agent discovery 总预算已耗尽，未启动 version probe".into(),
                true,
            )),
        };
    }
    let outcome = probe_version_uncached(detector_id, &executable, version_args, budget).await;
    if let Some(key) = &cache_key {
        if let Ok(mut cache) = cache.lock() {
            if cache.len() >= MAX_VERSION_PROBE_CACHE_ENTRIES {
                cache.clear();
            }
            cache.insert(key.clone(), outcome.clone());
        }
    }
    outcome
}

async fn probe_version_uncached(
    detector_id: &str,
    executable: &Path,
    version_args: &[String],
    budget: Duration,
) -> VersionProbeOutcome {
    let mut command = tokio::process::Command::new(executable);
    // Catalog's empty argument list selects the standard version probe.
    // Invocation args (e.g. `acp`) belong to session launch, never discovery.
    if version_args.is_empty() {
        command.arg("--version");
    } else {
        command.args(version_args);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return VersionProbeOutcome {
                version: None,
                startability: Startability::Failed,
                diagnostic: Some(probe_diagnostic(
                    detector_id,
                    "version_probe_spawn_failed",
                    format!(
                        "无法执行 {} 版本探针: {error}",
                        executable.to_string_lossy()
                    ),
                    false,
                )),
            };
        }
    };
    let mut child = ManagedProbeChild::new(child);
    let stdout = child.take_stdout().expect("version probe stdout piped");
    let stderr = child.take_stderr().expect("version probe stderr piped");
    let completed = tokio::time::timeout(budget, async {
        let (stdout, stderr, status) =
            tokio::join!(read_bounded(stdout), read_bounded(stderr), child.wait(),);
        (stdout, stderr, status)
    })
    .await;
    let (stdout, stderr, status) = match completed {
        Ok(result) => result,
        Err(_) => {
            child.kill_and_wait().await;
            return VersionProbeOutcome {
                version: None,
                startability: Startability::Failed,
                diagnostic: Some(probe_diagnostic(
                    detector_id,
                    "version_probe_timeout",
                    format!("{} 版本探针超时", executable.to_string_lossy()),
                    true,
                )),
            };
        }
    };
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            return VersionProbeOutcome {
                version: None,
                startability: Startability::Failed,
                diagnostic: Some(probe_diagnostic(
                    detector_id,
                    "version_probe_wait_failed",
                    format!(
                        "等待 {} 版本探针失败: {error}",
                        executable.to_string_lossy()
                    ),
                    true,
                )),
            };
        }
    };
    if !status.success() {
        return VersionProbeOutcome {
            version: None,
            startability: Startability::Failed,
            diagnostic: Some(probe_diagnostic(
                detector_id,
                "version_probe_non_zero",
                format!("{} 版本探针返回 {status}", executable.to_string_lossy()),
                false,
            )),
        };
    }
    let stdout = stdout.unwrap_or_default();
    let stderr = stderr.unwrap_or_default();
    let version = extract_version_token(&String::from_utf8_lossy(&stdout))
        .or_else(|| extract_version_token(&String::from_utf8_lossy(&stderr)))
        .map(|value| value.chars().take(160).collect::<String>());
    if version.is_none() {
        VersionProbeOutcome {
            version: None,
            startability: Startability::Failed,
            diagnostic: Some(probe_diagnostic(
                detector_id,
                "version_probe_empty",
                format!("{} 版本探针未返回版本文本", executable.to_string_lossy()),
                false,
            )),
        }
    } else {
        VersionProbeOutcome {
            version,
            startability: Startability::Verified,
            diagnostic: None,
        }
    }
}

type ConfiguredRuntimes = HashMap<String, (String, String, Vec<String>)>;

/// Whether a catalog requirement actually constrains anything.
fn requires_tool(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|declared| !declared.trim().is_empty())
}

/// Whether the npm-global version source should be consulted for this provider.
///
/// Both conditions matter: the direct executable probe is authoritative and has
/// already run, so the fallback is only worth a process spawn when that probe
/// produced nothing AND a declared gate actually consumes the value. Without the
/// second condition every scan would pay for an npm query whose result nobody
/// reads.
fn needs_npm_version_fallback(
    rule: &AgentDetectionProfile,
    candidate_version: Option<&str>,
) -> bool {
    candidate_version.is_none()
        && rule.version_gates.iter().any(|gate| {
            gate.evidence == crate::agent_catalog::CatalogVersionEvidence::AdapterAgentInfoVersion
        })
}

/// npm global metadata version for a provider whose catalog entry ships as an npm
/// package.
///
/// This is the unique half of Codeg's `detect_local_version`: the
/// executable-probe fallback in that function is redundant at every call site
/// here, because the caller only asks when the candidate probe ran against the
/// resolved executable and produced no version. Keeping the fallback would
/// re-spawn a probe that has already failed. No install, no cache mutation.
async fn npm_global_package_version(rule: &AgentDetectionProfile) -> Option<String> {
    let manager = rule.package_manager.as_ref()?;
    if !matches!(
        manager.kind,
        crate::agent_catalog::CatalogPackageManagerKind::Npx
    ) {
        return None;
    }
    npm_global_version(manager.package.as_deref()?).await
}

async fn npm_global_version(package: &str) -> Option<String> {
    let mut command = tokio::process::Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" });
    command
        .args(["list", "-g", package, "--json", "--depth=0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    parse_npm_list_version(&output.stdout, package)
}

fn parse_npm_list_version(bytes: &[u8], package: &str) -> Option<String> {
    let document: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let key = if let Some(stripped) = package.strip_prefix('@') {
        stripped
            .find('@')
            .map(|index| &package[..index + 1])
            .unwrap_or(package)
    } else {
        package.split('@').next().unwrap_or(package)
    };
    let value = document
        .get("dependencies")?
        .get(key)?
        .get("version")?
        .as_str()?;
    extract_version_token(value)
}

/// Keep uvx interpreter pin construction identical across launch and probes;
/// this is the pure portion of codeg's `uvx_python_args`.
pub fn uvx_python_args(python: Option<&str>) -> Vec<String> {
    python
        .map(|version| vec!["--python".into(), version.into()])
        .unwrap_or_default()
}

pub async fn detect_agent_runtime_candidates_inner(
    options: AgentDetectionOptions,
    configured: &ConfiguredRuntimes,
) -> Result<AgentDetectionReport, String> {
    let started = Instant::now();
    let limits = options.limits.clone();
    let deadline = started + limits.total_budget;
    let rules = crate::agent_catalog::detection_profiles()
        .map_err(|error| format!("Agent Catalog: {error}"))?;
    let available = rules
        .iter()
        .map(|rule| rule.detector_id.as_str())
        .collect::<HashSet<_>>();
    let mut diagnostics = Vec::new();
    if let Some(requested) = options.detector_ids.as_ref() {
        let mut seen = HashSet::new();
        for detector_id in requested.iter().filter(|id| seen.insert(id.as_str())) {
            if !available.contains(detector_id.as_str()) {
                diagnostics.push(AgentDetectionDiagnostic {
                    code: "unknown_detector_id".into(),
                    stage: "selection".into(),
                    detector_id: Some(detector_id.clone()),
                    message: format!("未知 Agent detector: {detector_id}"),
                    retryable: false,
                });
            }
        }
    }
    let enabled: Option<HashSet<String>> =
        options.detector_ids.map(|ids| ids.into_iter().collect());
    let selected_rules = rules
        .iter()
        .filter(|rule| {
            enabled
                .as_ref()
                .map(|ids| ids.contains(&rule.detector_id))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>();
    let search_roots = options.search_roots.clone();
    // The runtime-tool probe runs after the scan, so it needs its own handle on
    // the roots (the scan closure takes ownership of the original).
    let tool_roots = search_roots.clone();
    let home_dir = options.home_dir.clone();
    let scan_budget = deadline.saturating_duration_since(Instant::now());
    let discovered = tokio::time::timeout(
        scan_budget,
        tokio::task::spawn_blocking(move || {
            let mut discovered = Vec::new();
            let mut providers = Vec::new();
            for rule in selected_rules {
                let located = find_rule(&rule, search_roots.as_deref());
                let config = config_evidence(&rule, home_dir.as_deref());
                providers.push(provider_evidence(
                    &rule,
                    search_roots.as_deref(),
                    home_dir.as_deref(),
                ));
                discovered.extend(
                    located
                        .into_iter()
                        .map(|located| (rule.clone(), located, config.clone())),
                );
            }
            (discovered, providers)
        }),
    )
    .await;
    let (mut discovered, providers) = match discovered {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => return Err(format!("Agent detection scan task failed: {error}")),
        Err(_) => {
            diagnostics.push(AgentDetectionDiagnostic {
                code: "detection_budget_exhausted".into(),
                stage: "scan".into(),
                detector_id: None,
                message: "Agent discovery 扫描超过总预算".into(),
                retryable: true,
            });
            return Ok(AgentDetectionReport {
                candidates: Vec::new(),
                providers: Vec::new(),
                diagnostics,
                elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                truncated: true,
            });
        }
    };
    discovered.sort_by(|left, right| {
        let left_config = left
            .2
            .iter()
            .any(|evidence| evidence.kind == "config-fields");
        let right_config = right
            .2
            .iter()
            .any(|evidence| evidence.kind == "config-fields");
        right
            .0
            .priority
            .cmp(&left.0.priority)
            .then(right_config.cmp(&left_config))
            .then(left.1.alias_index.cmp(&right.1.alias_index))
            .then((left.1.source != "path").cmp(&(right.1.source != "path")))
            .then(path_key(&left.1.executable).cmp(&path_key(&right.1.executable)))
            .then(left.1.args.cmp(&right.1.args))
    });
    let discovered_truncated = discovered.len() > limits.max_candidates;
    if discovered_truncated {
        diagnostics.push(AgentDetectionDiagnostic {
            code: "candidate_limit_reached".into(),
            stage: "selection".into(),
            detector_id: None,
            message: format!(
                "Agent 候选超过上限 {}，已在 version probe 前按稳定优先级截断",
                limits.max_candidates
            ),
            retryable: false,
        });
        discovered.truncate(limits.max_candidates);
    }

    // Version commands are independent but bounded. Each probe receives only
    // the remaining total budget, so queued work cannot extend discovery
    // indefinitely after the deadline.
    let probed = futures_util::stream::iter(discovered)
        .map(|(rule, located, config)| {
            let path = located.executable.clone();
            let detector_id = rule.detector_id.clone();
            let probe_budget = limits
                .version_probe_budget
                .min(deadline.saturating_duration_since(Instant::now()));
            async move {
                let probe =
                    version_probe(&detector_id, path, &rule.version_args, probe_budget).await;
                (rule, located, config, probe)
            }
        })
        .buffer_unordered(limits.max_concurrent_probes.max(1))
        .collect::<Vec<_>>()
        .await;

    let mut ranked_candidates = Vec::new();
    for (rule, located, config, probe) in probed {
        if let Some(diagnostic) = probe.diagnostic {
            diagnostics.push(diagnostic);
        }
        let version = probe.version;
        let startability = probe.startability;
        let alias_index = located.alias_index;
        let path = located.executable;
        let source = located.source;
        let key = path_key(&path);
        let candidate_args = located.args;
        let imported = configured
            .iter()
            .find(|(_, (provider, executable, args))| {
                provider == &rule.provider && executable == &key && args == &candidate_args
            })
            .map(|(id, _)| id.clone());
        let mut evidence = located.evidence;
        evidence.extend(config);
        let structured_config_match = evidence.iter().any(|item| item.kind == "config-fields");
        if let Some(version) = &version {
            evidence.push(AgentDetectionEvidence {
                kind: "version".into(),
                detail: version.clone(),
            })
        }
        let candidate_id = stable_candidate_id(&rule.detector_id, &key, &candidate_args);
        let identity_confidence = if version.is_some() || structured_config_match {
            IdentityConfidence::High
        } else {
            IdentityConfidence::Medium
        };
        let candidate = AgentRuntimeCandidate {
            candidate_id,
            detector_id: rule.detector_id.clone(),
            provider: rule.provider.clone(),
            suggested_agent_id: rule.provider.clone(),
            name: rule.display_name.clone(),
            executable: path.to_string_lossy().to_string(),
            args: candidate_args,
            evidence,
            identity_confidence,
            startability,
            protocol_availability: ProtocolAvailability::NotTested,
            already_imported_agent_id: imported,
            warnings: {
                let mut warnings = located.warnings;
                if source != "path" {
                    warnings.push("可执行文件不在当前 PATH；导入将保存本机绝对路径".into())
                }
                if version.is_none() && structured_config_match {
                    warnings.push(
                        "未能读取版本；已由结构化配置佐证，仍建议执行 ACP initialize 验证".into(),
                    )
                } else if version.is_none() {
                    warnings.push("未能读取版本；导入前建议执行 ACP initialize 验证".into())
                }
                warnings
            },
        };
        ranked_candidates.push((
            candidate,
            rule.priority,
            identity_confidence,
            alias_index,
            source != "path",
            key,
        ));
    }
    fn confidence_rank(confidence: IdentityConfidence) -> u8 {
        match confidence {
            IdentityConfidence::Exact => 0,
            IdentityConfidence::High => 1,
            IdentityConfidence::Medium => 2,
            IdentityConfidence::Low => 3,
        }
    }
    ranked_candidates.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then(confidence_rank(left.2).cmp(&confidence_rank(right.2)))
            .then(left.3.cmp(&right.3))
            .then(left.4.cmp(&right.4))
            .then(left.5.cmp(&right.5))
            .then(left.0.args.cmp(&right.0.args))
    });
    let candidates_truncated = ranked_candidates.len() > limits.max_candidates;
    if candidates_truncated && !discovered_truncated {
        diagnostics.push(AgentDetectionDiagnostic {
            code: "candidate_limit_reached".into(),
            stage: "selection".into(),
            detector_id: None,
            message: format!(
                "Agent 候选超过上限 {}，已按稳定优先级截断",
                limits.max_candidates
            ),
            retryable: false,
        });
        ranked_candidates.truncate(limits.max_candidates);
    }
    let candidates: Vec<AgentRuntimeCandidate> = ranked_candidates
        .into_iter()
        .map(|(candidate, ..)| candidate)
        .collect();
    // A version-gated provider whose declared minimum cannot be proven from the
    // discovered evidence is reported here rather than silently accepted.
    let mut providers = providers;
    // Node.js / uv are machine facts, not per-provider ones: probe each at most
    // once per scan, and only when a detected provider actually declares a
    // requirement for it. A scan limited to providers needing neither spawns
    // nothing extra.
    let mut needs_node = false;
    let mut needs_uv = false;
    for provider in &providers {
        let Some(rule) = rules.iter().find(|rule| rule.provider == provider.provider) else {
            continue;
        };
        needs_node |= requires_tool(&rule.requires.node);
        needs_uv |= requires_tool(&rule.requires.uv);
    }
    let tool_budget = limits
        .version_probe_budget
        .min(deadline.saturating_duration_since(Instant::now()));
    let tool_roots = match tool_roots.as_deref() {
        Some(roots) => dedup_roots(controlled_roots(Some(roots))),
        None => controlled_roots(None),
    };
    let node = if needs_node {
        probe_tool_version("node", &[], &tool_roots, tool_budget).await
    } else {
        ToolVersion::default()
    };
    let uv = if needs_uv {
        probe_tool_version("uv", &[], &tool_roots, tool_budget).await
    } else {
        ToolVersion::default()
    };
    for provider in &mut providers {
        provider.node = node.clone();
        provider.uv = uv.clone();
    }
    for provider in &mut providers {
        let Some(rule) = rules.iter().find(|r| r.provider == provider.provider) else {
            continue;
        };
        let Some(minimum) = rule
            .version_gates
            .iter()
            .find(|gate| gate.min_version.is_some())
            .and_then(|gate| gate.min_version.as_deref())
        else {
            continue;
        };
        let candidate_version: Option<String> = candidates
            .iter()
            .filter(|candidate| candidate.provider == provider.provider)
            .find_map(|candidate| {
                candidate
                    .evidence
                    .iter()
                    .find(|item| item.kind == "version")
                    .map(|item| item.detail.clone())
            });
        // The direct executable probe is authoritative; npm global metadata is the
        // one source it cannot supply, and is consulted only when a gate actually
        // consumes the value.
        if needs_npm_version_fallback(rule, candidate_version.as_deref()) {
            provider.adapter_version = npm_global_package_version(rule).await;
        }
        let observed = candidate_version.or_else(|| provider.adapter_version.clone());
        if let Some(version) = observed {
            if !crate::agent_preflight::version_at_least(Some(&version), Some(minimum)) {
                diagnostics.push(AgentDetectionDiagnostic {
                    code: "adapter_version_below_declared_minimum".into(),
                    stage: "version".into(),
                    detector_id: Some(provider.detector_id.clone()),
                    message: format!(
                        "{} 的版本 {version} 低于 catalog 声明的下限 {minimum}",
                        provider.provider
                    ),
                    retryable: true,
                });
            }
        }
    }
    Ok(AgentDetectionReport {
        candidates,
        providers,
        diagnostics,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        truncated: discovered_truncated || candidates_truncated,
    })
}

/// Shared library entry used by the standalone detector. GUI-specific
/// imported-agent matching stays in the Tauri adapter below.
pub async fn detect_agent_runtime_candidates(
    options: AgentDetectionOptions,
) -> Result<AgentDetectionReport, String> {
    detect_agent_runtime_candidates_inner(options, &HashMap::new()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pylon-detection-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// 写入一个名为 `command` 的假可执行文件；`version` 为 `None` 时以非零退出，
    /// 模拟「存在但读不出」（与 `make_hanging_executable` 同一夹具手法）。
    fn plant_version_tool(root: &Path, command: &str, version: Option<&str>) {
        std::fs::create_dir_all(root).unwrap();
        #[cfg(windows)]
        {
            let path = root.join(format!("{command}.cmd"));
            let body = match version {
                Some(version) => format!("@echo off\r\necho {version}\r\nexit /b 0\r\n"),
                None => "@echo off\r\nexit /b 7\r\n".to_string(),
            };
            std::fs::write(&path, body).unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = root.join(command);
            let body = match version {
                Some(version) => format!("#!/bin/sh\necho '{version}'\n"),
                None => "#!/bin/sh\nexit 7\n".to_string(),
            };
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn make_hanging_executable(root: &Path, command: &str) -> PathBuf {
        #[cfg(windows)]
        {
            let path = root.join(format!("{command}.cmd"));
            std::fs::write(&path, "@echo off\r\nping 127.0.0.1 -n 30 >nul\r\n").unwrap();
            path
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = root.join(command);
            std::fs::write(&path, "#!/bin/sh\nsleep 30\n").unwrap();
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).unwrap();
            path
        }
    }

    /// B0/缺口1：npm 全局元数据版本源只有在「声明的 gate 真的消费版本」且直接
    /// 探针未给出版本时才被咨询（否则每次扫描都会白跑一次 npm）。
    ///
    /// 这是对**接线判定**的断言，与机器上装了什么无关。
    #[test]
    fn npm_version_fallback_is_gate_and_probe_conditioned() {
        let rules = crate::agent_catalog::detection_profiles().unwrap();
        let rule = |provider: &str| {
            rules
                .iter()
                .find(|rule| rule.provider == provider)
                .unwrap_or_else(|| panic!("{provider} 必须在 catalog 中"))
                .clone()
        };
        // claude-code 的 gate 以「适配器版本」为证据，因此需要版本值。
        assert!(needs_npm_version_fallback(&rule("claude-code"), None));
        // 直接探针已经给出版本 → 不再花一次 npm 查询。
        assert!(!needs_npm_version_fallback(
            &rule("claude-code"),
            Some("0.75.1")
        ));
        // codex 的 gate 是静态策略（goalControlOutOfBand），不消费版本。
        assert!(!needs_npm_version_fallback(&rule("codex"), None));
        // 完全没有 gate 的 provider。
        assert!(!needs_npm_version_fallback(&rule("peri"), None));
    }

    /// B0：运行时工具探针（Node/uv）的三态与无副作用。
    ///
    /// 三态是关键：存在→Known、存在但读不出→Unknown（不是违规）、不存在→Absent。
    #[tokio::test]
    async fn runtime_tool_probe_maps_known_unknown_and_absent() {
        let root = fixture_root("tool-probe");
        std::fs::create_dir_all(&root).unwrap();

        // 1）存在且可读 → Known
        let readable = root.join("readable");
        plant_version_tool(&readable, "node", Some("22.19.0"));
        assert_eq!(
            probe_tool_version(
                "node",
                &[],
                std::slice::from_ref(&readable),
                Duration::from_secs(2)
            )
            .await,
            ToolVersion::Known("22.19.0".into())
        );

        // 2）存在但不可读 → Unknown
        let unreadable = root.join("unreadable");
        plant_version_tool(&unreadable, "node", None);
        assert_eq!(
            probe_tool_version(
                "node",
                &[],
                std::slice::from_ref(&unreadable),
                Duration::from_secs(2)
            )
            .await,
            ToolVersion::Unknown
        );

        // 3）不存在 → Absent
        assert_eq!(
            probe_tool_version("node", &[], &[root.join("missing")], Duration::from_secs(2)).await,
            ToolVersion::Absent
        );

        // 4）预算耗尽 → Unknown（不启动探针，也不假装读到版本）
        assert_eq!(
            probe_tool_version("node", &[], std::slice::from_ref(&readable), Duration::ZERO).await,
            ToolVersion::Unknown
        );

        // 5）无安装副作用：探针不创建任何文件
        let clean = root.join("clean");
        std::fs::create_dir_all(&clean).unwrap();
        let _ = probe_tool_version(
            "node",
            &[],
            std::slice::from_ref(&clean),
            Duration::from_secs(2),
        )
        .await;
        assert_eq!(
            std::fs::read_dir(&clean).unwrap().count(),
            0,
            "工具探针不得创建任何文件/目录"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_key_is_case_insensitive() {
        let key = path_key(Path::new("Peri.EXE"));
        if cfg!(windows) {
            assert_eq!(key, key.to_lowercase())
        }
    }
    #[test]
    fn detector_set_contains_only_verified_native_acp_servers() {
        let rules = crate::agent_catalog::detection_profiles().unwrap();
        assert_eq!(
            rules
                .iter()
                .map(|rule| rule.detector_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "builtin.detector.peri",
                "builtin.detector.hermes",
                "builtin.detector.claude-code",
                "builtin.detector.codex",
            ],
        );
        assert_eq!(
            rules[0].invocations[0].args,
            ["acp"],
            "Peri 的 ACP 入口必须是 peri acp"
        );
        assert_eq!(
            rules[1].invocations[0].args,
            ["acp"],
            "Hermes 的主 ACP 入口必须是 hermes acp"
        );
        assert_eq!(
            rules[2].invocations[0].args,
            ["--acp"],
            "Claude Code 的 ACP 入口必须显式带 --acp"
        );
        // A5①：codex 是第二个 wrapper。ACP 入口是适配器 `codex-acp`，
        // 而 vendor CLI `codex` 只作为 adapterRelation 的探测证据。
        let codex = rules
            .iter()
            .find(|rule| rule.provider == "codex")
            .expect("codex 必须在 catalog 中");
        assert_eq!(codex.invocations[0].command, "codex-acp");
        assert!(codex.invocations[0].args.is_empty());
        let relation = codex
            .adapter_relation
            .as_ref()
            .expect("codex 必须声明 adapter relation");
        assert_eq!(relation.native_cmd, "codex");
        assert_eq!(relation.shared_config_dir, "~/.codex");
        assert_eq!(relation.extra_dirs, vec![".local/bin"]);
        assert!(
            rules.iter().all(|rule| rule.provider != "pi"),
            "pi --mode rpc 是私有 JSONL RPC，不得伪装成 ACP runtime",
        );
    }

    #[test]
    fn detached_windows_launcher_resolves_real_stdio_executable() {
        assert_eq!(
            detached_windows_launcher_target(
                "@echo off\nstart \"Peri\" \"F:\\\\Agent\\\\peri.exe\" %*\n"
            ),
            Ok(Some(r"F:\\Agent\\peri.exe".to_string())),
        );
        assert_eq!(
            detached_windows_launcher_target("@echo off\nnode \"agent.js\" %*\n"),
            Ok(None)
        );
        assert_eq!(
            detached_windows_launcher_target("start \"Peri\" missing-target %*\n"),
            Err(())
        );
    }

    #[test]
    fn structured_config_evidence_reports_field_names_without_values() {
        let root = fixture_root("config");
        let home = root.join("home");
        let config_dir = home.join(".hermes");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("config.yaml"),
            "provider: private-provider\nmodel: private-model\napi_key: super-secret\n",
        )
        .unwrap();
        let rule = crate::agent_catalog::detection_profiles()
            .unwrap()
            .into_iter()
            .find(|rule| rule.provider == "hermes")
            .unwrap();

        let evidence = config_evidence(&rule, Some(&home));
        let structured = evidence
            .iter()
            .find(|item| item.kind == "config-fields")
            .expect("structured evidence");
        assert!(structured.detail.contains("provider"));
        assert!(structured.detail.contains("model"));
        assert!(!structured.detail.contains("private-provider"));
        assert!(!structured.detail.contains("private-model"));
        assert!(!structured.detail.contains("super-secret"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn all_installed_invocation_aliases_are_discovered() {
        let root = fixture_root("aliases");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(&executable_names("hermes")[0]), b"fixture").unwrap();
        std::fs::write(root.join(&executable_names("hermes-acp")[0]), b"fixture").unwrap();
        let rule = crate::agent_catalog::detection_profiles()
            .unwrap()
            .into_iter()
            .find(|rule| rule.provider == "hermes")
            .unwrap();

        let found = find_rule(&rule, Some(std::slice::from_ref(&root)));

        assert_eq!(found.len(), 2, "首个 alias 不得遮蔽后续已安装 alias");
        assert_eq!(found[0].args, ["acp"]);
        assert!(found[1].args.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn standalone_entry_uses_the_same_structured_evidence_engine() {
        let root = fixture_root("standalone");
        let home = root.join("home");
        let search = root.join("bin");
        std::fs::create_dir_all(home.join(".hermes")).unwrap();
        std::fs::create_dir_all(&search).unwrap();
        std::fs::write(
            home.join(".hermes/config.yaml"),
            "provider: fixture\nmodel: fixture-model\n",
        )
        .unwrap();
        std::fs::write(
            search.join(&executable_names("hermes")[0]),
            b"not-an-executable",
        )
        .unwrap();

        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.hermes".into()]),
            home_dir: Some(home),
            search_roots: Some(vec![search]),
            ..AgentDetectionOptions::default()
        })
        .await
        .unwrap();
        let candidates = report.candidates;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].provider, "hermes");
        assert_eq!(candidates[0].identity_confidence, IdentityConfidence::High);
        assert!(candidates[0]
            .evidence
            .iter()
            .any(|item| item.kind == "config-fields"));

        std::fs::remove_dir_all(root).unwrap();
    }

    /// A1 验收：wrapper provider 的 ACP 与原生 CLI 证据分开展开，且即使 ACP
    /// 候选缺失也会产出 provider 级证据（这是 `adapterMissing` 可观察的前提）。
    #[tokio::test]
    async fn wrapper_evidence_separates_acp_from_native_cli() {
        let root = fixture_root("adapter-relation");
        let home = root.join("home");
        let search = root.join("bin");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(&search).unwrap();
        // 只有原生 CLI，没有 wrapper 可执行文件。
        std::fs::write(
            search.join(&executable_names("claude")[0]),
            b"not-an-executable",
        )
        .unwrap();

        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.claude-code".into()]),
            home_dir: Some(home),
            search_roots: Some(vec![search]),
            ..AgentDetectionOptions::default()
        })
        .await
        .unwrap();
        assert!(
            report.candidates.is_empty(),
            "wrapper 命令不存在，不应有候选"
        );
        assert_eq!(report.providers.len(), 1);
        let evidence = &report.providers[0];
        assert_eq!(evidence.provider, "claude-code");
        assert!(evidence.adapter_relation_declared);
        assert!(evidence.acp_commands.is_empty());
        assert_eq!(evidence.native_commands.len(), 1);
        assert_eq!(
            Path::new(&evidence.native_commands[0].path)
                .file_stem()
                .and_then(|stem| stem.to_str()),
            Some("claude")
        );
        assert!(evidence.shared_config_present);

        std::fs::remove_dir_all(root).unwrap();
    }

    /// 非 wrapper provider 不探测第二 CLI，也不报共享配置目录存在。
    #[tokio::test]
    async fn native_acp_provider_has_no_second_cli_evidence() {
        let root = fixture_root("native-evidence");
        let home = root.join("home");
        let search = root.join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&search).unwrap();
        std::fs::write(
            search.join(&executable_names("peri")[0]),
            b"not-an-executable",
        )
        .unwrap();

        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.peri".into()]),
            home_dir: Some(home),
            search_roots: Some(vec![search]),
            ..AgentDetectionOptions::default()
        })
        .await
        .unwrap();
        let evidence = &report.providers[0];
        assert!(!evidence.adapter_relation_declared);
        assert!(evidence.native_commands.is_empty());
        assert!(!evidence.shared_config_present);
        assert_eq!(evidence.acp_commands.len(), 1);
        assert_eq!(evidence.acp_commands[0].kind, "acp-command");

        std::fs::remove_dir_all(root).unwrap();
    }

    /// A1 零安装副作用：探测只读，不创建目录。
    #[tokio::test]
    async fn evidence_scan_has_no_install_side_effects() {
        let root = fixture_root("no-side-effects");
        let home = root.join("home");
        let search = root.join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&search).unwrap();
        let before = std::fs::read_dir(&home).unwrap().count();
        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.claude-code".into()]),
            home_dir: Some(home.clone()),
            search_roots: Some(vec![search.clone()]),
            ..AgentDetectionOptions::default()
        })
        .await
        .unwrap();
        assert!(report.candidates.is_empty());
        // 既不建 `~/.claude`，也不建任何缓存/安装目录。
        assert!(!home.join(".claude").exists());
        assert_eq!(std::fs::read_dir(&home).unwrap().count(), before);
        assert_eq!(std::fs::read_dir(&search).unwrap().count(), 0);

        std::fs::remove_dir_all(root).unwrap();
    }

    /// A5①：codex 的 wrapper 双证据。本机真实状态是「vendor CLI 在、ACP 适配器
    /// 不在」（`codex` 已装、`codex-acp` 未装），必须产出可行动的 `adapterMissing`。
    #[tokio::test]
    async fn codex_wrapper_reports_adapter_missing_with_native_cli_present() {
        let root = fixture_root("codex-adapter-missing");
        let home = root.join("home");
        let search = root.join("bin");
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::create_dir_all(&search).unwrap();
        // 只有 vendor CLI `codex`，没有适配器 `codex-acp`。
        std::fs::write(
            search.join(&executable_names("codex")[0]),
            b"not-an-executable",
        )
        .unwrap();

        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.codex".into()]),
            home_dir: Some(home),
            search_roots: Some(vec![search]),
            ..AgentDetectionOptions::default()
        })
        .await
        .unwrap();
        assert!(
            report.candidates.is_empty(),
            "适配器不存在，不应有 ACP 候选"
        );
        let evidence = &report.providers[0];
        assert_eq!(evidence.provider, "codex");
        assert!(evidence.adapter_relation_declared);
        assert!(evidence.acp_commands.is_empty());
        assert_eq!(evidence.native_commands.len(), 1);
        assert!(evidence.shared_config_present);

        // 同一份证据经共享映射得到可行动状态（与设置页/CLI 一致）。
        let preflight =
            crate::agent_preflight::from_detection(evidence, &report.candidates).unwrap();
        assert_eq!(
            preflight.status,
            crate::agent_preflight::PreflightStatus::AdapterMissing
        );
        assert!(!preflight.passed);
        assert_eq!(
            crate::agent_preflight::action_code(preflight.status),
            "install-acp-adapter"
        );
        let adapter = preflight.adapter.expect("codex 是 wrapper");
        assert_eq!(adapter.native_cmd, "codex");
        assert_eq!(adapter.native_label, "Codex CLI");
        assert_eq!(adapter.shared_config_dir, "~/.codex");
        // 两侧证据必须分开：vendor CLI 已找到、ACP 适配器未找到。
        assert!(adapter.native_present);
        assert!(!adapter.acp_present);
        assert!(adapter.shared_config_present);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn unknown_detector_is_a_successful_empty_report_with_a_diagnostic() {
        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["missing.detector".into()]),
            ..AgentDetectionOptions::default()
        })
        .await
        .unwrap();

        assert!(report.candidates.is_empty());
        assert_eq!(report.diagnostics.len(), 1);
        assert_eq!(report.diagnostics[0].code, "unknown_detector_id");
        assert_eq!(report.diagnostics[0].stage, "selection");
        assert_eq!(
            report.diagnostics[0].detector_id.as_deref(),
            Some("missing.detector")
        );
    }

    #[tokio::test]
    async fn discovery_reports_identity_separately_from_protocol_availability() {
        let root = fixture_root("identity-protocol");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(&executable_names("hermes")[0]), b"fixture").unwrap();
        std::fs::write(root.join(&executable_names("hermes-acp")[0]), b"fixture").unwrap();

        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.hermes".into()]),
            home_dir: Some(root.join("home")),
            search_roots: Some(vec![root.clone()]),
            ..AgentDetectionOptions::default()
        })
        .await
        .unwrap();

        assert_eq!(report.candidates.len(), 2);
        assert_ne!(
            report.candidates[0].candidate_id, report.candidates[1].candidate_id,
            "不同 invocation 必须有不同稳定 id"
        );
        assert!(report.candidates.iter().all(|candidate| {
            candidate.identity_confidence == IdentityConfidence::Medium
                && candidate.startability == Startability::Failed
                && candidate.protocol_availability == ProtocolAvailability::NotTested
        }));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn candidate_limit_is_stable_and_explicitly_truncated() {
        let root = fixture_root("candidate-limit");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(&executable_names("hermes")[0]), b"fixture").unwrap();
        std::fs::write(root.join(&executable_names("hermes-acp")[0]), b"fixture").unwrap();

        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.hermes".into()]),
            home_dir: Some(root.join("home")),
            search_roots: Some(vec![root.clone()]),
            limits: AgentDetectionLimits {
                max_candidates: 1,
                ..AgentDetectionLimits::default()
            },
        })
        .await
        .unwrap();

        assert_eq!(report.candidates.len(), 1);
        assert!(report.truncated);
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "candidate_limit_reached"));
        assert_eq!(report.candidates[0].args, ["acp"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn exact_name_lookup_reaches_search_roots_after_the_sixteenth_entry() {
        let root = fixture_root("root-limit");
        let roots = (0..17)
            .map(|index| root.join(format!("bin-{index}")))
            .collect::<Vec<_>>();
        for path in &roots {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(roots[16].join(&executable_names("peri")[0]), b"fixture").unwrap();

        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.peri".into()]),
            home_dir: Some(root.join("home")),
            search_roots: Some(roots.clone()),
            limits: AgentDetectionLimits {
                version_probe_budget: Duration::from_millis(50),
                ..AgentDetectionLimits::default()
            },
        })
        .await
        .unwrap();

        assert_eq!(
            report.candidates.len(),
            1,
            "PATH 后段的精确命令名也必须被发现"
        );
        assert_eq!(
            Path::new(&report.candidates[0].executable),
            roots[16].join(&executable_names("peri")[0]),
        );
        assert!(!report.truncated, "精确文件名检查不应被搜索目录数量截断");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn version_probe_uses_catalog_arguments_and_standard_default() {
        let root = fixture_root("version-args");
        std::fs::create_dir_all(&root).unwrap();
        #[cfg(windows)]
        let (executable, args) = {
            let path = root.join("probe.cmd");
            std::fs::write(&path, "@echo off\r\necho startup notice\r\nif \"%1 %2\"==\"version --numeric\" (\r\n  echo 1.2.3 1>&2\r\n  exit /b 0\r\n)\r\nif \"%1 %2\"==\"--version \" (\r\n  echo 2.3.4 1>&2\r\n  exit /b 0\r\n)\r\nexit /b 7\r\n").unwrap();
            (path, vec!["version".to_string(), "--numeric".to_string()])
        };
        #[cfg(unix)]
        let (executable, args) = {
            let path = root.join("probe.sh");
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&path, "#!/bin/sh\necho 'startup notice'\ncase \"$*\" in\n'version --numeric') echo '1.2.3' >&2;;\n'--version') echo '2.3.4' >&2;;\n*) exit 7;;\nesac\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            (path, vec!["version".into(), "--numeric".into()])
        };
        let result =
            version_probe("fixture", executable.clone(), &args, Duration::from_secs(2)).await;
        assert_eq!(result.version.as_deref(), Some("1.2.3"));
        assert_eq!(result.startability, Startability::Verified);
        {
            let default =
                version_probe("fixture", executable.clone(), &[], Duration::from_secs(2)).await;
            assert_eq!(default.version.as_deref(), Some("2.3.4"));
            let invalid = version_probe(
                "fixture",
                executable,
                &["acp".into()],
                Duration::from_secs(2),
            )
            .await;
            assert_eq!(invalid.startability, Startability::Failed);
            assert_eq!(invalid.diagnostic.unwrap().code, "version_probe_non_zero");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// C1：失败也必须进缓存，而且缓存是**按 key** 而不是全局「记住最后一次」。
    ///
    /// 断言方式是「子进程真的只启动了一次」：夹具每次运行都往自身目录的
    /// `count.txt` 追加一行。仅断言「两次返回值相同」是抓不到这个缺陷的——旧实现
    /// 每次都返回同样的失败，只是白跑一次子进程，因此这个断言必须数进程。
    ///
    /// 计数文件用 `%~dp0` / `dirname "$0"` 定位（而不是把临时路径嵌进脚本），
    /// 既避开带空格的路径，也让两个夹具能各自独立计数。
    #[tokio::test]
    async fn a_failed_version_probe_is_cached_like_a_successful_one() {
        let root = fixture_root("probe-failure-cache");
        let failing_dir = root.join("failing");
        let working_dir = root.join("working");
        std::fs::create_dir_all(&failing_dir).unwrap();
        std::fs::create_dir_all(&working_dir).unwrap();
        let failing = plant_counting_probe(&failing_dir, "probe", None);
        let working = plant_counting_probe(&working_dir, "probe", Some("9.9.9"));

        // 第一次：真的跑了，失败带诊断。
        let first = version_probe("fixture", failing.clone(), &[], Duration::from_secs(5)).await;
        assert_eq!(first.startability, Startability::Failed);
        assert_eq!(
            first.diagnostic.as_ref().map(|d| d.code.as_str()),
            Some("version_probe_non_zero")
        );

        // 第二次：命中缓存——不但结果相同，而且**诊断还在**（缓存的失败必须保留
        // 理由，否则第二次刷新只会看到一个没有原因的失败）。
        let second = version_probe("fixture", failing.clone(), &[], Duration::from_secs(5)).await;
        assert_eq!(second.startability, Startability::Failed);
        assert_eq!(
            second.diagnostic.as_ref().map(|d| d.code.as_str()),
            Some("version_probe_non_zero"),
            "缓存的失败必须带着与首次相同的诊断"
        );

        // 成功路径同样只跑一次。
        let ok = version_probe("fixture", working.clone(), &[], Duration::from_secs(5)).await;
        assert_eq!(ok.version.as_deref(), Some("9.9.9"));
        let ok_again = version_probe("fixture", working.clone(), &[], Duration::from_secs(5)).await;
        assert_eq!(ok_again.version.as_deref(), Some("9.9.9"));

        let runs = |dir: &Path| {
            std::fs::read_to_string(dir.join("count.txt"))
                .unwrap_or_default()
                .lines()
                .count()
        };
        assert_eq!(
            runs(&failing_dir),
            1,
            "失败的探针不得在每次刷新时重回子进程"
        );
        assert_eq!(runs(&working_dir), 1, "成功的探针不得重复启动子进程");
        // 两个夹具各自只跑一次，证明缓存是按 key 存而不是只记住最后一次。
        assert_eq!(
            runs(&failing_dir) + runs(&working_dir),
            2,
            "缓存必须按 (路径, 参数, mtime) 分键，不得互相驱逐"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    /// 安置一个每次运行都向自身目录的 `count.txt` 追加一行的探针夹具。
    ///
    /// `version` 为 `None` 时以非零退出，模拟「存在但不认 --version」。
    fn plant_counting_probe(dir: &Path, name: &str, version: Option<&str>) -> PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join(format!("{name}.cmd"));
            let body = match version {
                Some(version) => format!(
                    "@echo off\r\n>>\"%~dp0count.txt\" echo x\r\necho {version}\r\nexit /b 0\r\n"
                ),
                None => "@echo off\r\n>>\"%~dp0count.txt\" echo x\r\nexit /b 3\r\n".to_string(),
            };
            std::fs::write(&path, body).unwrap();
            path
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join(name);
            let count = "echo x >> \"$(dirname \"$0\")/count.txt\"\n";
            let body = match version {
                Some(version) => format!("#!/bin/sh\n{count}echo '{version}'\n"),
                None => format!("#!/bin/sh\n{count}exit 3\n"),
            };
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    /// C2：候选扫描与证据扫描必须看到**同一组**可执行文件。
    ///
    /// 两者以前各自算一份 roots、各自走一遭文件系统，所以可以互相矛盾。现在共用
    /// `resolve_roots` + `scan_roots`；这条测试把「不再矛盾」钉成断言，并同时钉住两
    /// 侧各自**不同**的来源词汇（候选区分 path/known-path，证据只报 known-path）。
    #[tokio::test]
    async fn candidate_and_evidence_scans_agree_on_what_exists() {
        let root = fixture_root("scan-agreement");
        let on_path = root.join("on-path");
        let off_path = root.join("off-path");
        std::fs::create_dir_all(&on_path).unwrap();
        std::fs::create_dir_all(&off_path).unwrap();
        // peri 与 hermes 两个 provider 各放一个 ACP 入口，其中一个在 PATH 上。
        std::fs::write(on_path.join(&executable_names("peri")[0]), b"fixture").unwrap();
        std::fs::write(off_path.join(&executable_names("hermes")[0]), b"fixture").unwrap();
        // 只用夹具目录作为搜索根，不引入真实 PATH 条目：本机装了 peri 时会把真实
        // 安装拖进断言，测试就不再确定。`on_path`/`off_path` 都在临时目录下，因此
        // 两者都必然不在进程 PATH 上。
        let roots = vec![on_path.clone(), off_path.clone()];
        let options = AgentDetectionOptions {
            detector_ids: Some(vec![
                "builtin.detector.peri".into(),
                "builtin.detector.hermes".into(),
            ]),
            home_dir: Some(root.join("home")),
            search_roots: Some(roots),
            limits: AgentDetectionLimits {
                version_probe_budget: Duration::from_millis(50),
                ..AgentDetectionLimits::default()
            },
        };
        let report = detect_agent_runtime_candidates(options).await.unwrap();

        for provider in ["peri", "hermes"] {
            let evidence = report
                .providers
                .iter()
                .find(|evidence| evidence.provider == provider)
                .unwrap_or_else(|| panic!("{provider} 必须有 provider 证据"));
            let candidates = report
                .candidates
                .iter()
                .filter(|candidate| candidate.provider == provider)
                .collect::<Vec<_>>();

            let evidence_paths = evidence
                .acp_commands
                .iter()
                .map(|hit| path_key(Path::new(&hit.path)))
                .collect::<HashSet<_>>();
            let candidate_paths = candidates
                .iter()
                .map(|candidate| path_key(Path::new(&candidate.executable)))
                .collect::<HashSet<_>>();
            assert_eq!(
                evidence_paths, candidate_paths,
                "{provider}: 候选与证据必须定位到同一组可执行文件"
            );
            // 证据侧的词汇：根命中一律 known-path。
            for hit in &evidence.acp_commands {
                assert_eq!(
                    hit.source, "known-path",
                    "{provider}: 证据只报存在性，不区分是否在 PATH 上"
                );
            }
        }
        // 候选侧的词汇：显式根列表里的目录都不是进程 PATH，所以标 known-path 并带
        // 「不在 PATH」警告；这锁住了 C2 不得顺手把两侧标签合并成一种。
        let peri = report
            .candidates
            .iter()
            .find(|candidate| candidate.provider == "peri")
            .unwrap();
        assert_eq!(peri.evidence[0].kind, "known-path");
        assert!(
            peri.warnings.iter().any(|w| w.contains("不在当前 PATH")),
            "候选侧必须保留 off-PATH 警告"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn version_probe_timeout_is_bounded_and_visible() {
        let root = fixture_root("probe-timeout");
        std::fs::create_dir_all(&root).unwrap();
        make_hanging_executable(&root, "peri");

        let started = Instant::now();
        let report = detect_agent_runtime_candidates(AgentDetectionOptions {
            detector_ids: Some(vec!["builtin.detector.peri".into()]),
            home_dir: Some(root.join("home")),
            search_roots: Some(vec![root.clone()]),
            limits: AgentDetectionLimits {
                total_budget: Duration::from_millis(500),
                version_probe_budget: Duration::from_millis(100),
                ..AgentDetectionLimits::default()
            },
        })
        .await
        .unwrap();

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "version_probe_timeout"));
        assert_eq!(report.candidates[0].startability, Startability::Failed);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn npm_list_fixture_extracts_scoped_and_unscoped_versions() {
        assert_eq!(
            parse_npm_list_version(br#"{"dependencies":{"foo":{"version":"1.2.3"}}}"#, "foo")
                .as_deref(),
            Some("1.2.3")
        );
        assert_eq!(
            parse_npm_list_version(
                br#"{"dependencies":{"@scope/foo":{"version":"4.5.6"}}}"#,
                "@scope/foo@4.5.6"
            )
            .as_deref(),
            Some("4.5.6")
        );
        assert!(
            parse_npm_list_version(br#"{"dependencies":{"foo":{"version":"bad"}}}"#, "foo")
                .is_none()
        );
    }

    #[test]
    fn uvx_python_pin_is_explicit_and_empty_when_unset() {
        assert_eq!(uvx_python_args(Some("3.12")), vec!["--python", "3.12"]);
        assert!(uvx_python_args(None).is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn managed_probe_cleanup_kills_descendant_processes() {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let root = fixture_root("probe-tree");
        std::fs::create_dir_all(&root).unwrap();
        let pid_file = root.join("child.pid");
        let escaped_pid_file = pid_file.to_string_lossy().replace("'", "''");
        let script = format!(
            "$child = Start-Process ping.exe -ArgumentList '-t','127.0.0.1' -PassThru; Set-Content -LiteralPath '{escaped_pid_file}' -Value $child.Id; Wait-Process -Id $child.Id"
        );
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = ManagedProbeChild::new(command.spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(3);
        while !pid_file.is_file() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let pid = std::fs::read_to_string(&pid_file)
            .expect("descendant pid file")
            .trim()
            .parse::<u32>()
            .unwrap();

        child.kill_and_wait().await;
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if handle.is_null() {
                break;
            }
            let mut exit_code = 0u32;
            let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
            unsafe { CloseHandle(handle) };
            const STILL_ACTIVE: u32 = 259;
            if queried && exit_code != STILL_ACTIVE {
                break;
            }
            if Instant::now() >= deadline {
                panic!("version probe descendant {pid} survived cleanup");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
