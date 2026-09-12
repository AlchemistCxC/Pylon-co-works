//! Read-only environment diagnostics. Values are deliberately allow-listed.
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

const SAFE_KEYS: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SHELL",
    "NVM_DIR",
    "FNM_DIR",
    "FNM_MULTISHELL_PATH",
    "VOLTA_HOME",
    "ASDF_DATA_DIR",
    "MISE_DATA_DIR",
    "N_PREFIX",
    "HOMEBREW_PREFIX",
    "npm_config_prefix",
    "LANG",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub environment: BTreeMap<String, String>,
    pub path_entries: Vec<String>,
    pub verdict: DiagnosticsVerdict,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticsVerdict {
    Ready,
    PathMismatch,
    MissingRuntime,
}

impl DiagnosticsVerdict {
    /// The serde spelling, so text output and JSON cannot name one verdict twice.
    pub fn as_str(&self) -> &'static str {
        match self {
            DiagnosticsVerdict::Ready => "ready",
            DiagnosticsVerdict::PathMismatch => "path_mismatch",
            DiagnosticsVerdict::MissingRuntime => "missing_runtime",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathGapReport {
    /// New-process dirs absent from the app PATH, in persisted order.
    pub missing_from_app_path: Vec<String>,
    /// Whether the new-process PATH was actually read. `false` means the gap is
    /// **unknown**, not empty: a caller must not report "no gap" from this, and
    /// must not read it as "the environment is fine".
    pub observed: bool,
}

impl PathGapReport {
    /// The gap is known to be non-empty.
    pub fn has_gap(&self) -> bool {
        self.observed && !self.missing_from_app_path.is_empty()
    }
}

/// Directories a newly started process would have on `PATH` but this process
/// does not — the Windows form of the terminal-vs-GUI PATH mismatch.
///
/// Windows GUI processes inherit the `PATH` their parent had at launch, so a CLI
/// installed afterwards is invisible to the app while working in a terminal
/// opened later. Codeg answers this with a login-shell probe and documents that
/// the probe does not run on Windows; reading the persisted user and machine
/// `PATH` is the Windows source of truth for the same fact.
///
/// Read-only by construction: two `reg.exe query` calls, no shell, no PATH
/// mutation, no environment dump.
pub fn persisted_path_gap() -> PathGapReport {
    let app_path = app_path_entries();
    persisted_path_gap_from(&app_path, persisted_path_entries())
}

/// Pure half of [`persisted_path_gap`], so the set arithmetic is testable
/// without a registry.
fn persisted_path_gap_from(app_path: &[String], persisted: Option<Vec<String>>) -> PathGapReport {
    let Some(persisted) = persisted else {
        // Unknown, not empty. Returning an empty gap here would let a caller
        // claim the environment is healthy precisely when it could not be read.
        return PathGapReport::default();
    };
    let app: HashSet<String> = app_path.iter().map(|entry| path_key(entry)).collect();
    let mut missing_from_app_path = Vec::new();
    let mut seen = HashSet::new();
    for entry in persisted {
        let key = path_key(&entry);
        if app.contains(&key) || !seen.insert(key) {
            continue;
        }
        missing_from_app_path.push(entry);
    }
    PathGapReport {
        missing_from_app_path,
        observed: true,
    }
}

pub fn app_path_entries() -> Vec<String> {
    std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .map(|path| path.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn path_key(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// Persisted user + machine PATH, or `None` when neither could be read.
#[cfg(windows)]
fn persisted_path_entries() -> Option<Vec<String>> {
    let mut entries = Vec::new();
    let mut observed = false;
    for (hive, key) in [
        ("HKCU", r"Environment"),
        (
            "HKLM",
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    ] {
        if let Some(value) = read_persisted_path(hive, key) {
            observed = true;
            entries.extend(
                expand_percent_vars(&value, |name| std::env::var_os(name))
                    .split(';')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_string),
            );
        }
    }
    observed.then_some(entries)
}

#[cfg(not(windows))]
fn persisted_path_entries() -> Option<Vec<String>> {
    None
}

/// One `reg.exe query <hive>\<key> /v Path` read, returning the raw value.
#[cfg(windows)]
fn read_persisted_path(hive: &str, key: &str) -> Option<String> {
    let output = std::process::Command::new("reg.exe")
        .args(["query", &format!(r"{hive}\{key}"), "/v", "Path"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().find_map(|line| {
        // `    Path    REG_EXPAND_SZ    C:\a;C:\b` — split on the type token so a
        // value that itself contains "REG_SZ" is not truncated.
        let (_, value) = line
            .split_once("REG_EXPAND_SZ")
            .or_else(|| line.split_once("REG_SZ"))?;
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Expand `%NAME%` placeholders using `lookup`, leaving unknown names verbatim.
///
/// Persisted PATH values are `REG_EXPAND_SZ`, so they hold literals such as
/// `%USERPROFILE%\bin`. Unknown names are kept as written rather than dropped:
/// a directory we cannot expand is still evidence that the PATH changed, and
/// silently discarding it would under-report the gap.
fn expand_percent_vars(text: &str, lookup: impl Fn(&str) -> Option<std::ffi::OsString>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            // Unterminated: the remainder is literal text.
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        if name.is_empty() {
            // `%%` is an escaped percent sign in the Windows convention.
            out.push('%');
        } else {
            match lookup(name) {
                Some(value) => out.push_str(&value.to_string_lossy()),
                None => {
                    out.push('%');
                    out.push_str(name);
                    out.push('%');
                }
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

pub fn sanitize_value(key: &str, value: &str) -> String {
    let lower = key.to_ascii_lowercase();
    let secretish = [
        "key",
        "token",
        "secret",
        "password",
        "passwd",
        "auth",
        "credential",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if !secretish {
        return value.replace(['\r', '\n'], "");
    }
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 8 {
        return "•".repeat(chars.len());
    }
    let first: String = chars[..2].iter().collect();
    let last: String = chars[chars.len() - 2..].iter().collect();
    format!(
        "{first}{}{last}",
        "•".repeat(chars.len().saturating_sub(4).min(16))
    )
}

pub fn compute_verdict(
    runtime_found: bool,
    gui_path: &[String],
    shell_path: &[String],
) -> DiagnosticsVerdict {
    if !runtime_found {
        return DiagnosticsVerdict::MissingRuntime;
    }
    if gui_path != shell_path {
        DiagnosticsVerdict::PathMismatch
    } else {
        DiagnosticsVerdict::Ready
    }
}

pub fn collect_environment() -> BTreeMap<String, String> {
    SAFE_KEYS
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| ((*key).into(), sanitize_value(key, &value)))
        })
        .collect()
}

pub fn report(runtime_found: bool, shell_path: &[String]) -> DiagnosticsReport {
    let gui_path = app_path_entries();
    let new_process_path = if shell_path.is_empty() {
        // No explicit snapshot: use what this machine would hand a newly started
        // process. Before this the parameter was always empty in practice, so
        // the mismatch verdict could never fire on Windows.
        persisted_path_entries().unwrap_or_default()
    } else {
        shell_path.to_vec()
    };
    // An empty snapshot means no new-process PATH could be read; it is not
    // evidence that the GUI PATH differs. `path_gap(..).observed` carries that
    // distinction, while the verdict keeps its three-value shape.
    let gap = persisted_path_gap_from(&gui_path, Some(new_process_path.clone()));
    let verdict = if shell_path.is_empty() && runtime_found && !gap.has_gap() {
        DiagnosticsVerdict::Ready
    } else {
        compute_verdict(runtime_found, &gui_path, &new_process_path)
    };
    DiagnosticsReport {
        environment: collect_environment(),
        path_entries: gui_path,
        verdict,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_shell_path_is_not_reported_as_a_mismatch() {
        assert_ne!(report(true, &[]).verdict, DiagnosticsVerdict::PathMismatch);
    }
    #[test]
    fn path_mismatch_explains_gui_install_failure() {
        assert_eq!(
            compute_verdict(true, &["gui".into()], &["shell".into()]),
            DiagnosticsVerdict::PathMismatch
        );
    }
    #[test]
    fn secrets_are_not_returned() {
        assert_eq!(sanitize_value("API_TOKEN", "secret"), "••••••");
    }
    #[test]
    fn long_multibyte_secrets_are_masked_without_panicking() {
        assert_eq!(sanitize_value("密码", "abcdefghijk"), "abcdefghijk");
        assert!(sanitize_value("API_KEY", "密钥值很长很长").contains('•'));
    }

    /// 持久化 PATH 里的 `%NAME%` 必须展开（它是 REG_EXPAND_SZ）。
    #[test]
    fn percent_vars_expand_and_unknown_names_are_kept_verbatim() {
        let lookup = |name: &str| match name {
            "USERPROFILE" => Some(std::ffi::OsString::from(r"C:\Users\me")),
            _ => None,
        };
        assert_eq!(
            expand_percent_vars(r"%USERPROFILE%\bin;C:\tools", lookup),
            r"C:\Users\me\bin;C:\tools"
        );
        // 未知变量按原样保留，而不是丢掉：展开不了也不能减报缺口。
        assert_eq!(expand_percent_vars(r"%NOPE%\bin", lookup), r"%NOPE%\bin");
        // `%%` 是转义百分号；未闭合的 `%` 之后全是字面量。
        assert_eq!(expand_percent_vars("a%%b", lookup), "a%b");
        assert_eq!(expand_percent_vars("a%UNCLOSED", lookup), "a%UNCLOSED");
    }

    /// 缺口只列「新进程有、本进程没有」的目录，去重、保序、大小写不敏感。
    #[test]
    fn gap_lists_only_new_process_dirs_absent_from_the_app_path() {
        let app = vec![r"C:\Windows".to_string(), r"C:\tools".to_string()];
        let persisted = vec![
            // 已在 app PATH 上（大小写不同也算命中）
            r"c:\windows".to_string(),
            r"C:\Users\me\AppData\Roaming\npm".to_string(),
            // 重复项只报一次
            r"C:\Users\me\AppData\Roaming\npm".to_string(),
            // 尾部反斜杠不应造成伪缺口
            r"C:\tools\".to_string(),
            r"C:\Users\me\.local\bin".to_string(),
        ];
        let gap = persisted_path_gap_from(&app, Some(persisted));
        assert!(gap.observed);
        assert_eq!(
            gap.missing_from_app_path,
            vec![
                r"C:\Users\me\AppData\Roaming\npm".to_string(),
                r"C:\Users\me\.local\bin".to_string(),
            ]
        );
        assert!(gap.has_gap());
    }

    /// 读不到持久化 PATH 是「未知」，不是「无缺口」。
    ///
    /// 这个区分是必需的：把未知当空会让调用方在恰恰读不到环境时声称环境正常。
    #[test]
    fn an_unreadable_persisted_path_is_unknown_not_empty() {
        let app = vec![r"C:\Windows".to_string()];
        let gap = persisted_path_gap_from(&app, None);
        assert!(!gap.observed);
        assert!(!gap.has_gap());
        assert!(gap.missing_from_app_path.is_empty());
    }

    /// 持久化 PATH 与 app PATH 完全一致时无缺口。
    #[test]
    fn an_identical_path_has_no_gap() {
        let app = vec![r"C:\Windows".to_string(), r"C:\tools".to_string()];
        let gap = persisted_path_gap_from(&app, Some(app.clone()));
        assert!(gap.observed);
        assert!(!gap.has_gap());
    }
}
