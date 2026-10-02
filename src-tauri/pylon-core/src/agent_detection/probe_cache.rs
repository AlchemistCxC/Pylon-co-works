//! 版本探针缓存（OnceLock + mtime 键 + 满员清空）与 npm 全局版本回退。
use super::locate::path_key;
use super::probe::{
    extract_version_token, probe_diagnostic, read_bounded, ManagedProbeChild, VersionProbeOutcome,
};
use super::types::Startability;
use crate::agent_catalog::AgentDetectionProfile;
use pylon_foundations::child_command::HideConsoleWindow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 版本探针缓存：(规范化路径, 版本参数, mtime) → 版本字符串。
/// One probe result per (executable, arguments, mtime).
///
/// The whole outcome is cached, not just the version: a CLI that does not
/// understand `--version` fails identically on every refresh, so remembering
/// nothing meant re-spawning it every time. A cached failure keeps its
/// diagnostic, so the second refresh reports the same reason as the first
/// rather than a bare failure.
/// Retryable timeouts and wait failures are not cached.
///
/// Keyed by mtime so upgrading a CLI is a miss rather than a stale hit, which
/// also means each upgrade leaves its predecessor behind. Bounded and dropped
/// wholesale when full — it is a cache, and re-probing is always correct.
pub(crate) type VersionProbeCache =
    Mutex<HashMap<(String, Vec<String>, std::time::SystemTime), VersionProbeOutcome>>;

pub(crate) const MAX_VERSION_PROBE_CACHE_ENTRIES: usize = 64;

/// Cached wrapper around [`probe_version_uncached`].
pub(crate) async fn version_probe(
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
                None,
                "detection_budget_exhausted",
                "Agent discovery 总预算已耗尽，未启动 version probe".into(),
                true,
            )),
        };
    }
    let outcome = probe_version_uncached(detector_id, &executable, version_args, budget).await;
    // Timeouts describe this attempt, not a permanent fact about an unchanged binary.
    if let Some(key) = cache_key
        .as_ref()
        .filter(|_| !outcome.diagnostic.as_ref().is_some_and(|d| d.retryable))
    {
        if let Ok(mut cache) = cache.lock() {
            if cache.len() >= MAX_VERSION_PROBE_CACHE_ENTRIES {
                cache.clear();
            }
            cache.insert(key.clone(), outcome.clone());
        }
    }
    outcome
}

pub(crate) async fn probe_version_uncached(
    detector_id: &str,
    executable: &Path,
    version_args: &[String],
    budget: Duration,
) -> VersionProbeOutcome {
    let mut command = tokio::process::Command::new(executable);
    command.hide_console_window();
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
                    Some(executable),
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
                startability: Startability::NotTested,
                diagnostic: Some(probe_diagnostic(
                    detector_id,
                    Some(executable),
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
                startability: Startability::NotTested,
                diagnostic: Some(probe_diagnostic(
                    detector_id,
                    Some(executable),
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
            startability: Startability::NotTested,
            diagnostic: Some(probe_diagnostic(
                detector_id,
                Some(executable),
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
            startability: Startability::NotTested,
            diagnostic: Some(probe_diagnostic(
                detector_id,
                Some(executable),
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

pub(crate) type ConfiguredRuntimes = HashMap<String, (String, String, Vec<String>)>;

/// Whether a catalog requirement actually constrains anything.
pub(crate) fn requires_tool(value: &Option<String>) -> bool {
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
pub(crate) fn needs_npm_version_fallback(
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
pub(crate) async fn npm_global_package_version(rule: &AgentDetectionProfile) -> Option<String> {
    let manager = rule.package_manager.as_ref()?;
    if !matches!(
        manager.kind,
        crate::agent_catalog::CatalogPackageManagerKind::Npx
    ) {
        return None;
    }
    npm_global_version(manager.package.as_deref()?).await
}

pub(crate) async fn npm_global_version(package: &str) -> Option<String> {
    let mut command = tokio::process::Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" });
    command.hide_console_window();
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

pub(crate) fn parse_npm_list_version(bytes: &[u8], package: &str) -> Option<String> {
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
