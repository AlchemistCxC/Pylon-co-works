//! Controlled first-party Agent runtime discovery. No recursive disk scan and no ACP initialize.
use crate::agent_catalog::{
    AgentDetectionProfile, CatalogConfigEvidence, CatalogConfigFormat, CatalogInvocation,
};

use futures_util::StreamExt;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
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

#[derive(Debug, Clone)]
pub struct AgentDetectionOptions {
    pub detector_ids: Option<Vec<String>>,
    pub home_dir: Option<PathBuf>,
    pub search_roots: Option<Vec<PathBuf>>,
    pub limits: AgentDetectionLimits,
}

impl Default for AgentDetectionOptions {
    fn default() -> Self {
        Self {
            detector_ids: None,
            home_dir: None,
            search_roots: None,
            limits: AgentDetectionLimits::default(),
        }
    }
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
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return Vec::new();
    };
    let root = PathBuf::from(local).join("Programs").join(&rule.provider);
    vec![root.clone(), root.join("bin")]
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

fn find_rule(
    rule: &AgentDetectionProfile,
    search_roots: Option<&[PathBuf]>,
) -> Vec<LocatedRuntime> {
    let path_roots = controlled_roots(search_roots);
    let include_platform_roots = search_roots.is_none();
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for (alias_index, invocation) in rule.invocations.iter().enumerate() {
        let mut locations = Vec::new();
        for root in path_roots
            .iter()
            .cloned()
            .chain(provider_roots(rule, include_platform_roots))
        {
            for name in executable_names(&invocation.command) {
                let candidate = root.join(name);
                if candidate.is_file() {
                    locations.push((
                        candidate,
                        if path_roots.iter().any(|path| path == &root)
                            && std::env::var_os("PATH")
                                .map(|value| std::env::split_paths(&value).any(|path| path == root))
                                .unwrap_or(false)
                        {
                            "path".into()
                        } else {
                            "known-path".into()
                        },
                    ));
                }
            }
        }
        if include_platform_roots {
            locations.extend(app_path_candidates(invocation));
        }
        for (candidate, source) in locations {
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

struct VersionProbeOutcome {
    version: Option<String>,
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

async fn version_probe(
    detector_id: &str,
    executable: PathBuf,
    budget: Duration,
) -> VersionProbeOutcome {
    if budget.is_zero() {
        return VersionProbeOutcome {
            version: None,
            diagnostic: Some(probe_diagnostic(
                detector_id,
                "detection_budget_exhausted",
                "Agent discovery 总预算已耗尽，未启动 version probe".into(),
                true,
            )),
        };
    }
    let mut command = tokio::process::Command::new(&executable);
    command
        .arg("--version")
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
                diagnostic: Some(probe_diagnostic(
                    detector_id,
                    "version_probe_spawn_failed",
                    format!(
                        "无法执行 {} --version: {error}",
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
                diagnostic: Some(probe_diagnostic(
                    detector_id,
                    "version_probe_timeout",
                    format!("{} --version 超时", executable.to_string_lossy()),
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
                diagnostic: Some(probe_diagnostic(
                    detector_id,
                    "version_probe_wait_failed",
                    format!(
                        "等待 {} --version 失败: {error}",
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
            diagnostic: Some(probe_diagnostic(
                detector_id,
                "version_probe_non_zero",
                format!("{} --version 返回 {status}", executable.to_string_lossy()),
                false,
            )),
        };
    }
    let stdout = stdout.unwrap_or_default();
    let stderr = stderr.unwrap_or_default();
    let text = if stdout.is_empty() { stderr } else { stdout };
    let version = String::from_utf8_lossy(&text)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(160)
        .collect::<String>();
    if version.is_empty() {
        VersionProbeOutcome {
            version: None,
            diagnostic: Some(probe_diagnostic(
                detector_id,
                "version_probe_empty",
                format!("{} --version 未返回版本文本", executable.to_string_lossy()),
                false,
            )),
        }
    } else {
        VersionProbeOutcome {
            version: Some(version),
            diagnostic: None,
        }
    }
}

type ConfiguredRuntimes = HashMap<String, (String, String, Vec<String>)>;

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
    let home_dir = options.home_dir.clone();
    let scan_budget = deadline.saturating_duration_since(Instant::now());
    let scanned = tokio::time::timeout(
        scan_budget,
        tokio::task::spawn_blocking(move || {
            let mut discovered = Vec::new();
            for rule in selected_rules {
                let located = find_rule(&rule, search_roots.as_deref());
                let config = config_evidence(&rule, home_dir.as_deref());
                discovered.extend(
                    located
                        .into_iter()
                        .map(|located| (rule.clone(), located, config.clone())),
                );
            }
            discovered
        }),
    )
    .await;
    let mut discovered = match scanned {
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
                (
                    rule,
                    located,
                    config,
                    version_probe(&detector_id, path, probe_budget).await,
                )
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
    let candidates = ranked_candidates
        .into_iter()
        .map(|(candidate, ..)| candidate)
        .collect();
    Ok(AgentDetectionReport {
        candidates,
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

        assert_eq!(report.candidates.len(), 1, "PATH 后段的精确命令名也必须被发现");
        assert_eq!(
            Path::new(&report.candidates[0].executable),
            roots[16].join(&executable_names("peri")[0]),
        );
        assert!(!report.truncated, "精确文件名检查不应被搜索目录数量截断");
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
        std::fs::remove_dir_all(root).unwrap();
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
