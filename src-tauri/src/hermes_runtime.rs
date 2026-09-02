//! Windows-only runtime adaptation for Hermes ACP.
//!
//! Hermes' local environment backend uses Git for Windows' Bash.  A user's
//! `PATH` is not a reliable source for that dependency: on a stock Windows
//! machine it may resolve to the WSL launcher (`System32\bash.exe`) or to a
//! partially removed Git installation.  This module deliberately keeps the
//! adaptation scoped to the normalized `hermes` provider and to the child
//! `Command` that launches that provider.
//!
//! The release packager places a complete PortableGit tree at
//! `resources/runtime/git`.  Development builds may use the same location,
//! `PYLON_HERMES_RUNTIME_DIR`, or fall back to a healthy system Git Bash.  No
//! process-global PATH or user environment variable is changed here.

use crate::agent_config::{AcpProtocolConfig, AgentDef};
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Hermes' supported environment override.  Hermes reads this before PATH
/// lookup, so it is the most deterministic way to select the bundled Bash.
pub(crate) const HERMES_GIT_BASH_PATH_ENV: &str = "HERMES_GIT_BASH_PATH";
/// Coarse Hermes-side fallback for a wedged concurrent tool batch.  The fast
/// user-visible liveness guard lives in Pylon's ACP prompt path; this value is
/// intentionally only a last line of defence inside Hermes.
pub(crate) const HERMES_CONCURRENT_TOOL_TIMEOUT_ENV: &str = "HERMES_CONCURRENT_TOOL_TIMEOUT_S";
pub(crate) const HERMES_CONCURRENT_TOOL_TIMEOUT_DEFAULT: &str = "30";

/// Hermes-only defaults.  They are applied only when the user did not provide
/// an explicit value in `agents.yaml`.  The idle budget deliberately follows
/// the normal prompt budget: a provider may spend a long interval thinking
/// without emitting a session/update heartbeat, and a short compatibility
/// window would terminate a healthy turn while it is still making progress.
pub(crate) const HERMES_IDLE_TIMEOUT_DEFAULT_SECS: u64 = crate::acp::DEFAULT_PROMPT_TIMEOUT_SECS;
pub(crate) const HERMES_CANCEL_SETTLE_DEFAULT_SECS: u64 = 5;

const BASH_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const BASH_PROBE_POLL: Duration = Duration::from_millis(25);
const BASH_EXTERNAL_PROBE: &str =
    "/usr/bin/true; /usr/bin/cat --version >/dev/null; /usr/bin/mktemp -u >/dev/null";

#[derive(Debug, Clone)]
pub(crate) struct HermesRuntimeSelection {
    pub(crate) bash_path: PathBuf,
    pub(crate) root: PathBuf,
    pub(crate) bundled: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct HermesRuntimeError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl HermesRuntimeError {
    fn missing(message: impl Into<String>) -> Self {
        Self {
            code: "hermes_bash_runtime_missing",
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "hermes_bash_runtime_invalid",
            message: message.into(),
        }
    }
}

/// Provider gate used by every Hermes-specific behavior.  The provider is
/// already normalized by `agent_config::resolve_provider`; comparing the
/// provider (rather than the Agent name/id or executable basename) prevents
/// accidental activation for another Agent.
pub(crate) fn is_hermes_agent(agent: &AgentDef) -> bool {
    agent
        .provider
        .as_deref()
        .is_some_and(|provider| provider.trim().eq_ignore_ascii_case("hermes"))
}

pub(crate) fn should_apply(agent: &AgentDef) -> bool {
    cfg!(windows)
        && agent.transport.trim().eq_ignore_ascii_case("subprocess")
        && is_hermes_agent(agent)
}

/// Apply safe Hermes defaults without overwriting explicit configuration.
///
/// `first_token_timeout_secs` needs special handling: the existing accessor
/// falls back to `idle_timeout_secs`.  Keep the prompt/first-token budget for
/// the idle window unless the user explicitly supplied an idle value; Hermes
/// must not silently turn a configured 180s prompt into a 12s local cutoff.
pub(crate) fn effective_protocol(agent: &AgentDef) -> AcpProtocolConfig {
    let mut protocol = agent.protocol().clone();
    if !should_apply(agent) {
        return protocol;
    }

    let idle_was_explicit = protocol.idle_timeout_secs.is_some();
    if !idle_was_explicit {
        let preserved_idle = protocol
            .prompt_timeout_secs
            .or(protocol.first_token_timeout_secs)
            .unwrap_or(HERMES_IDLE_TIMEOUT_DEFAULT_SECS);
        protocol.idle_timeout_secs = Some(preserved_idle);
        if protocol.first_token_timeout_secs.is_none() {
            protocol.first_token_timeout_secs = Some(preserved_idle);
        }
    }
    if protocol.cancel_settle_timeout_secs.is_none() {
        protocol.cancel_settle_timeout_secs = Some(HERMES_CANCEL_SETTLE_DEFAULT_SECS);
    }
    protocol
}

/// Resolve and preflight the Bash runtime for a Hermes child.
///
/// The blocking probe runs on Tokio's blocking pool because a broken MSYS
/// launcher can hang while creating its child process.  Non-Hermes and
/// non-Windows agents return `None` without even inspecting the host PATH.
pub(crate) async fn prepare(
    agent: &AgentDef,
) -> Result<Option<HermesRuntimeSelection>, HermesRuntimeError> {
    if !should_apply(agent) {
        return Ok(None);
    }

    let configured_env = agent.env.clone();
    tokio::task::spawn_blocking(move || select_and_probe(&configured_env))
        .await
        .map_err(|error| HermesRuntimeError::invalid(format!("Bash 预检线程失败: {error}")))?
        .map(Some)
}

/// Apply a selected runtime to one child command.  `Command::env` is
/// intentionally used instead of `std::env::set_var`: the parent Pylon
/// process and all other Agent children retain their original environment.
pub(crate) fn apply_to_command(
    command: &mut Command,
    agent: &AgentDef,
    selection: &HermesRuntimeSelection,
) {
    let bash = selection.bash_path.to_string_lossy().into_owned();
    command.env(HERMES_GIT_BASH_PATH_ENV, &bash);

    let path_key = agent
        .env
        .keys()
        .find(|key| key.eq_ignore_ascii_case("PATH"))
        .cloned()
        .unwrap_or_else(|| "PATH".to_string());
    let current_path = agent
        .env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let path = prepend_runtime_path(&current_path, &selection.root);
    command.env(path_key, path);

    // Respect explicit values from agents.yaml or the parent environment;
    // otherwise make the path behavior deterministic for the bundled MSYS.
    set_child_default(command, agent, "MSYS_NO_PATHCONV", "1");
    set_child_default(command, agent, "MSYS2_ARG_CONV_EXCL", "*");
    set_child_default(
        command,
        agent,
        HERMES_CONCURRENT_TOOL_TIMEOUT_ENV,
        HERMES_CONCURRENT_TOOL_TIMEOUT_DEFAULT,
    );

    tracing::info!(
        provider = "hermes",
        bash = %selection.bash_path.display(),
        root = %selection.root.display(),
        bundled = selection.bundled,
        "Hermes Windows runtime selected"
    );
}

fn set_child_default(command: &mut Command, agent: &AgentDef, key: &str, value: &str) {
    let explicitly_configured = agent
        .env
        .keys()
        .any(|candidate| candidate.eq_ignore_ascii_case(key));
    if !explicitly_configured && std::env::var_os(key).is_none() {
        command.env(key, value);
    }
}

fn select_and_probe(
    configured_env: &std::collections::HashMap<String, String>,
) -> Result<HermesRuntimeSelection, HermesRuntimeError> {
    let mut candidates: Vec<(PathBuf, bool)> = Vec::new();

    // A developer/CI override is deliberately separate from Hermes' own env
    // variable so a stale user value cannot outrank the packaged runtime.
    if let Some(root) = std::env::var_os("PYLON_HERMES_RUNTIME_DIR") {
        add_root_candidates(&mut candidates, PathBuf::from(root), true);
    }

    for root in bundled_runtime_roots() {
        add_root_candidates(&mut candidates, root, true);
    }

    // Explicit agent configuration is considered only after the bundled tree.
    for key in [HERMES_GIT_BASH_PATH_ENV] {
        if let Some(path) = configured_env
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
            .map(|(_, value)| PathBuf::from(value))
        {
            candidates.push((path, false));
        }
    }
    if let Some(path) = std::env::var_os(HERMES_GIT_BASH_PATH_ENV) {
        candidates.push((PathBuf::from(path), false));
    }

    add_system_candidates(&mut candidates);

    let mut seen = HashSet::new();
    let mut failures = Vec::new();
    for (candidate, bundled) in candidates {
        let key = candidate.to_string_lossy().to_lowercase();
        if !seen.insert(key) || is_wsl_launcher(&candidate) {
            continue;
        }
        let Some(root) = runtime_root(&candidate) else {
            failures.push(format!("{}（无法解析运行时根目录）", candidate.display()));
            continue;
        };
        if let Err(reason) = validate_layout(&candidate, &root) {
            failures.push(format!("{}（{}）", candidate.display(), reason));
            continue;
        }
        match probe_bash(&candidate, &root) {
            Ok(()) => {
                return Ok(HermesRuntimeSelection {
                    bash_path: candidate,
                    root,
                    bundled,
                });
            }
            Err(reason) => failures.push(format!("{}（{}）", candidate.display(), reason)),
        }
    }

    if failures.is_empty() {
        Err(HermesRuntimeError::missing(
            "未找到可用的 Git for Windows Bash。Pylon 发布包应包含 resources\\runtime\\git。",
        ))
    } else {
        Err(HermesRuntimeError::invalid(format!(
            "Hermes 所需 Bash 均无法启动：{}",
            failures.join("；")
        )))
    }
}

fn bundled_runtime_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("resources/runtime/git"));
        }
    }

    // `CARGO_MANIFEST_DIR` keeps `cargo run`/unit smoke usable when Tauri has
    // not copied resources to target/debug yet.  It is harmless in release
    // builds and never outranks the executable-adjacent tree.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    roots.push(manifest.join("../resources/runtime/git"));
    roots.push(manifest.join("resources/runtime/git"));
    roots
}

fn add_root_candidates(candidates: &mut Vec<(PathBuf, bool)>, root: PathBuf, bundled: bool) {
    candidates.push((root.join("bin/bash.exe"), bundled));
    candidates.push((root.join("usr/bin/bash.exe"), bundled));
}

fn add_system_candidates(candidates: &mut Vec<(PathBuf, bool)>) {
    let local_appdata = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    if let Some(home) = &local_appdata {
        candidates.push((home.join("hermes/git/bin/bash.exe"), false));
        candidates.push((home.join("hermes/git/usr/bin/bash.exe"), false));
        candidates.push((home.join("Programs/Git/bin/bash.exe"), false));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push((PathBuf::from(program_files).join("Git/bin/bash.exe"), false));
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        candidates.push((
            PathBuf::from(program_files_x86).join("Git/bin/bash.exe"),
            false,
        ));
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push((dir.join("bash.exe"), false));
        }
    }
}

fn runtime_root(bash: &Path) -> Option<PathBuf> {
    let bin = bash.parent()?;
    let bin_name = bin.file_name()?.to_string_lossy().to_lowercase();
    if bin_name != "bin" {
        return None;
    }
    let parent = bin.parent()?;
    if parent
        .file_name()?
        .to_string_lossy()
        .eq_ignore_ascii_case("usr")
    {
        parent.parent().map(Path::to_path_buf)
    } else {
        Some(parent.to_path_buf())
    }
}

fn validate_layout(bash: &Path, root: &Path) -> Result<(), String> {
    if !bash.is_file() {
        return Err("bash.exe 不存在".to_string());
    }
    let usr_bin = root.join("usr/bin");
    let required = [
        "true.exe",
        "cat.exe",
        "mktemp.exe",
        "mv.exe",
        "awk.exe",
        "grep.exe",
    ];
    let missing = required
        .iter()
        .filter(|name| !usr_bin.join(name).is_file())
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!("缺少 usr\\bin\\{}", missing.join(", ")));
    }
    let has_msys = [
        root.join("usr/bin/msys-2.0.dll"),
        root.join("bin/msys-2.0.dll"),
    ]
    .iter()
    .any(|path| path.is_file());
    if !has_msys {
        return Err("缺少 msys-2.0.dll".to_string());
    }
    Ok(())
}

fn prepend_runtime_path(existing: &str, root: &Path) -> OsString {
    let mut entries = runtime_path_entries(root);
    entries.extend(
        std::env::split_paths(OsStr::new(existing)).filter(|entry| !entry.as_os_str().is_empty()),
    );
    std::env::join_paths(entries).unwrap_or_else(|_| OsString::from(existing))
}

fn runtime_path_entries(root: &Path) -> Vec<PathBuf> {
    [
        root.join("mingw64/bin"),
        root.join("mingw32/bin"),
        root.join("usr/local/bin"),
        root.join("usr/bin"),
        root.join("bin"),
        root.join("cmd"),
    ]
    .into_iter()
    .filter(|path| path.is_dir())
    .collect()
}

fn is_wsl_launcher(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('/', "\\").to_lowercase();
    let windows_root = std::env::var("WINDIR")
        .unwrap_or_else(|_| String::from(r"C:\Windows"))
        .replace('/', "\\")
        .to_lowercase();
    normalized == format!(r"{windows_root}\system32\bash.exe")
        || normalized.contains(r"\windowsapps\bash.exe")
}

fn probe_bash(bash: &Path, root: &Path) -> Result<(), String> {
    let path = prepend_runtime_path(&std::env::var("PATH").unwrap_or_default(), root);
    run_probe(
        bash,
        &["--noprofile", "--norc", "-c", BASH_EXTERNAL_PROBE],
        &path,
        None,
    )?;

    // Test the login path in an empty HOME so a user's interactive rc file
    // cannot make the runtime selection nondeterministic. Hermes itself has a
    // fallback for a broken user login shell; this probe verifies the bundled
    // `/etc/profile` and MSYS startup files are healthy.
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_else(|_| Instant::now().elapsed().as_nanos());
    let probe_home = std::env::temp_dir().join(format!(
        "pylon-hermes-bash-probe-{}-{nonce}",
        std::process::id(),
    ));
    std::fs::create_dir_all(&probe_home)
        .map_err(|error| format!("创建登录预检 HOME 失败: {error}"))?;
    let result = run_probe(bash, &["-l", "-c", "true"], &path, Some(&probe_home));
    let _ = std::fs::remove_dir_all(&probe_home);
    result
}

fn run_probe(bash: &Path, args: &[&str], path: &OsStr, home: Option<&Path>) -> Result<(), String> {
    let mut command = Command::new(bash);
    command
        .args(args)
        .env("PATH", path)
        .env("MSYS_NO_PATHCONV", "1")
        .env("MSYS2_ARG_CONV_EXCL", "*")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(home) = home {
        command.env("HOME", home).env("USERPROFILE", home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW keeps a preflight from flashing a console window.
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动失败: {error}"))?;
    let deadline = Instant::now() + BASH_PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|error| format!("读取预检输出失败: {error}"))?;
                if status.success() {
                    return Ok(());
                }
                let detail = format_probe_output(&output.stdout, &output.stderr);
                return Err(if detail.is_empty() {
                    format!("退出码 {}", status)
                } else {
                    format!("退出码 {}: {detail}", status)
                });
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("预检超过 {} 秒", BASH_PROBE_TIMEOUT.as_secs()));
            }
            Ok(None) => std::thread::sleep(BASH_PROBE_POLL),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("检查进程状态失败: {error}"));
            }
        }
    }
}

fn format_probe_output(stdout: &[u8], stderr: &[u8]) -> String {
    let mut combined = String::from_utf8_lossy(stderr).trim().to_string();
    if combined.is_empty() {
        combined = String::from_utf8_lossy(stdout).trim().to_string();
    }
    combined.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn agent(provider: Option<&str>, transport: &str) -> AgentDef {
        AgentDef {
            name: "test".to_string(),
            provider: provider.map(str::to_string),
            transport: transport.to_string(),
            exe: "test.exe".to_string(),
            args: Vec::new(),
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        }
    }

    #[test]
    fn provider_gate_does_not_use_agent_name_or_exe() {
        let mut named = agent(None, "subprocess");
        named.name = "Hermes".to_string();
        named.exe = "hermes.exe".to_string();
        assert!(!is_hermes_agent(&named));
        assert!(!should_apply(&named));
    }

    #[test]
    fn provider_gate_is_case_insensitive_but_transport_scoped() {
        let hermes = agent(Some("HeRmEs"), "SUBPROCESS");
        assert!(is_hermes_agent(&hermes));
        let mut other_transport = hermes.clone();
        other_transport.transport = "embedded".to_string();
        assert!(!should_apply(&other_transport));
    }

    #[test]
    fn non_hermes_protocol_defaults_remain_untouched() {
        let peri = agent(Some("peri"), "subprocess");
        let effective = effective_protocol(&peri);
        assert_eq!(effective.idle_timeout_secs, None);
        assert_eq!(effective.first_token_timeout_secs, None);
        assert_eq!(effective.cancel_settle_timeout_secs, None);

        let mut embedded_hermes = agent(Some("hermes"), "embedded");
        embedded_hermes.acp = Some(AcpProtocolConfig {
            idle_timeout_secs: Some(77),
            ..AcpProtocolConfig::default()
        });
        assert_eq!(
            effective_protocol(&embedded_hermes).idle_timeout_secs,
            Some(77)
        );
        assert!(!should_apply(&embedded_hermes));
    }

    #[test]
    fn runtime_root_handles_portable_and_mingit_layouts() {
        assert_eq!(
            runtime_root(Path::new(r"C:\pylon\git\bin\bash.exe")),
            Some(PathBuf::from(r"C:\pylon\git"))
        );
        assert_eq!(
            runtime_root(Path::new(r"C:\pylon\git\usr\bin\bash.exe")),
            Some(PathBuf::from(r"C:\pylon\git"))
        );
    }

    #[test]
    fn wsl_launchers_are_rejected() {
        assert!(is_wsl_launcher(Path::new(r"C:\Windows\System32\bash.exe")));
        assert!(is_wsl_launcher(Path::new(
            r"C:\Users\x\AppData\Local\Microsoft\WindowsApps\bash.exe"
        )));
        assert!(!is_wsl_launcher(Path::new(r"C:\Git\bin\bash.exe")));
    }

    #[test]
    fn hermes_defaults_preserve_first_token_budget() {
        let mut hermes = agent(Some("hermes"), "subprocess");
        hermes.acp = Some(AcpProtocolConfig {
            prompt_timeout_secs: Some(180),
            ..AcpProtocolConfig::default()
        });
        let effective = effective_protocol(&hermes);
        if cfg!(windows) {
            assert_eq!(
                effective.idle_timeout_secs,
                Some(180),
                "未显式配置 idle 时不得把 180s prompt 预算收紧为短闲置窗口"
            );
            assert_eq!(effective.first_token_timeout_secs, Some(180));
            assert_eq!(
                effective.cancel_settle_timeout_secs,
                Some(HERMES_CANCEL_SETTLE_DEFAULT_SECS)
            );
        } else {
            assert_eq!(effective.idle_timeout_secs, None);
            assert_eq!(effective.first_token_timeout_secs, None);
        }
    }

    #[test]
    fn hermes_default_idle_budget_follows_prompt_budget() {
        let hermes = agent(Some("hermes"), "subprocess");
        let effective = effective_protocol(&hermes);
        if cfg!(windows) {
            assert_eq!(
                effective.idle_timeout_secs,
                Some(crate::acp::DEFAULT_PROMPT_TIMEOUT_SECS),
                "Hermes 默认闲置窗口必须允许长思考，不得固定为 12s"
            );
        } else {
            assert_eq!(effective.idle_timeout_secs, None);
        }
    }
}
