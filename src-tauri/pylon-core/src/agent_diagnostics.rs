//! Read-only environment diagnostics. Values are deliberately allow-listed.
use serde::Serialize;
use std::collections::BTreeMap;

const SAFE_KEYS: &[&str] = &["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "NODE_PATH", "UV_TOOL_DIR"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport { pub environment: BTreeMap<String, String>, pub path_entries: Vec<String>, pub verdict: DiagnosticsVerdict }

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticsVerdict { Ready, PathMismatch, MissingRuntime }

pub fn sanitize_value(key: &str, value: &str) -> String {
    if matches!(key, "PATH" | "HOME" | "USERPROFILE" | "APPDATA" | "LOCALAPPDATA" | "NODE_PATH" | "UV_TOOL_DIR") {
        value.replace(['\r', '\n'], "")
    } else { "[redacted]".into() }
}

pub fn compute_verdict(runtime_found: bool, gui_path: &[String], shell_path: &[String]) -> DiagnosticsVerdict {
    if !runtime_found { return DiagnosticsVerdict::MissingRuntime; }
    if gui_path != shell_path { DiagnosticsVerdict::PathMismatch } else { DiagnosticsVerdict::Ready }
}

pub fn collect_environment() -> BTreeMap<String, String> {
    SAFE_KEYS.iter().filter_map(|key| std::env::var(key).ok().map(|value| ((*key).into(), sanitize_value(key, &value)))).collect()
}

pub fn report(runtime_found: bool, shell_path: &[String]) -> DiagnosticsReport {
    let gui_path: Vec<String> = std::env::var_os("PATH").map(|v| std::env::split_paths(&v).map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>()).unwrap_or_default();
    // An empty shell snapshot means no terminal probe was performed; it is
    // not evidence that the GUI PATH differs from the terminal PATH.
    let verdict = if shell_path.is_empty() && runtime_found {
        DiagnosticsVerdict::Ready
    } else {
        compute_verdict(runtime_found, &gui_path, shell_path)
    };
    DiagnosticsReport { environment: collect_environment(), path_entries: gui_path, verdict }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_shell_path_is_not_reported_as_a_mismatch() {
        assert_ne!(report(true, &[]).verdict, DiagnosticsVerdict::PathMismatch);
    }
    #[test] fn path_mismatch_explains_gui_install_failure() { assert_eq!(compute_verdict(true, &["gui".into()], &["shell".into()]), DiagnosticsVerdict::PathMismatch); }
    #[test] fn secrets_are_not_returned() { assert_eq!(sanitize_value("TOKEN", "secret"), "[redacted]"); }
}
