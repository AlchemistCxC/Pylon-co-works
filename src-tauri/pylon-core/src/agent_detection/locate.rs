//! 路径规范化 / launcher 解析 / 根集合推导与命令定位（纯路径层，仅 fs::canonicalize 一处 IO）。
use super::evidence::{dedup_roots, resolved_home_dir};
use super::types::{AgentDetectionEvidence, AgentEvidenceHit};
use crate::agent_catalog::{AgentDetectionProfile, CatalogInvocation};
use pylon_foundations::child_command::HideConsoleWindow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub(crate) const MAX_PACKAGE_MANAGER_CHILDREN: usize = 64;

pub(crate) fn path_key(path: &Path) -> String {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = canonical.to_string_lossy().to_string();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

pub(crate) fn stable_candidate_id(
    detector_id: &str,
    executable_key: &str,
    args: &[String],
) -> String {
    // Stable FNV-1a over unambiguous length-prefixed fields. This is an identity
    // key, not a security boundary; length prefixes prevent concatenation aliasing.
    let mut hash = crate::fnv1a::FNV_OFFSET_BASIS;
    for field in std::iter::once(detector_id.as_bytes())
        .chain(std::iter::once(executable_key.as_bytes()))
        .chain(args.iter().map(String::as_bytes))
    {
        hash = crate::fnv1a::fold64(hash, &(field.len() as u64).to_le_bytes());
        hash = crate::fnv1a::fold64(hash, field);
    }
    format!("{detector_id}:{hash:016x}")
}

pub(crate) fn executable_names(command: &str) -> Vec<String> {
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

pub(crate) fn controlled_roots(overrides: Option<&[PathBuf]>) -> Vec<PathBuf> {
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

pub(crate) fn provider_roots(
    rule: &AgentDetectionProfile,
    include_platform_roots: bool,
) -> Vec<PathBuf> {
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
pub(crate) fn home_relative_dir(declared: &str) -> Option<PathBuf> {
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
pub(crate) fn app_path_candidates(invocation: &CatalogInvocation) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    for hive in ["HKCU", "HKLM"] {
        let key = format!(
            r"{}\Software\Microsoft\Windows\CurrentVersion\App Paths\{}.exe",
            hive, invocation.command
        );
        let Ok(output) = std::process::Command::new("reg.exe")
            .args(["query", &key, "/ve"])
            .hide_console_window()
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
pub(crate) fn app_path_candidates(_invocation: &CatalogInvocation) -> Vec<(PathBuf, String)> {
    Vec::new()
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LauncherResolution {
    Direct,
    Resolved(PathBuf),
    Incompatible,
}

pub(crate) fn detached_windows_launcher_target(content: &str) -> Result<Option<String>, ()> {
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

pub(crate) fn resolve_stdio_executable(path: &Path) -> LauncherResolution {
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

pub(crate) struct LocatedRuntime {
    pub(crate) executable: PathBuf,
    pub(crate) source: String,
    pub(crate) args: Vec<String>,
    pub(crate) alias_index: usize,
    pub(crate) evidence: Vec<AgentDetectionEvidence>,
    pub(crate) warnings: Vec<String>,
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
pub(crate) enum FoundVia {
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
pub(crate) fn resolve_roots(
    rule: &AgentDetectionProfile,
    search_roots: Option<&[PathBuf]>,
) -> Vec<PathBuf> {
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
pub(crate) fn scan_roots(
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

pub(crate) fn locate_command(
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

pub(crate) fn shared_config_present(
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
pub(crate) fn locate_command_path(command: &str, roots: &[PathBuf]) -> Option<PathBuf> {
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
