#[cfg_attr(not(test), allow(unused_imports))]
// 后三项仅测试目标消费（bin 内测试模块 + 回归测试）
use pylon_core::agent_detection::{
    detect_agent_runtime_candidates, AgentDetectionOptions, AgentDetectionReport,
    AgentRuntimeCandidate, IdentityConfidence, ProtocolAvailability, Startability,
};
use pylon_core::{agent_diagnostics, agent_preflight};
use serde_json::json;
use std::path::PathBuf;

fn usage() -> &'static str {
    "usage: pylon-detect [--json] [--detector <id>] [--home <path>] [--search-root <path>]\n       pylon-detect --diagnose\n       pylon-detect help | --help\n       pylon-detect --version"
}

fn help() -> String {
    format!(
        "Pylon Agent Detector — discover supported local ACP runtimes\n\n{}\n\nOptions:\n  --json                 Emit a stable JSON document\n  --detector <id>        Limit detection to one detector; repeatable\n  --home <path>          Override the home used for config evidence\n  --search-root <path>   Search only this executable directory; repeatable\n  --diagnose             Print a copyable environment + per-provider report\n\nConfiguration values are never emitted. Evidence includes paths and matched field names only.\n",
        usage()
    )
}

#[derive(Debug, PartialEq, Eq)]
enum CliAction {
    Help,
    Version,
    Detect {
        json_output: bool,
        diagnose_only: bool,
        detector_ids: Vec<String>,
        home_dir: Option<PathBuf>,
        search_roots: Vec<PathBuf>,
    },
}

fn parse_raw(raw: &[String]) -> Result<CliAction, String> {
    if raw.is_empty() || (raw.len() == 1 && matches!(raw[0].as_str(), "help" | "--help" | "-h")) {
        return Ok(CliAction::Help);
    }
    if raw.len() == 1 && matches!(raw[0].as_str(), "--version" | "-V") {
        return Ok(CliAction::Version);
    }
    let mut json_output = false;
    let mut diagnose_only = false;
    let mut detector_ids = Vec::new();
    let mut home_dir = None;
    let mut search_roots = Vec::new();
    let mut index = 0usize;
    while index < raw.len() {
        match raw[index].as_str() {
            "--json" => {
                json_output = true;
                index += 1;
            }
            "--diagnose" => {
                diagnose_only = true;
                index += 1;
            }
            "--detector" => {
                let value = raw.get(index + 1).ok_or("--detector requires an id")?;
                if value.trim().is_empty() {
                    return Err("--detector requires a non-empty id".into());
                }
                detector_ids.push(value.clone());
                index += 2;
            }
            "--home" => {
                let value = raw.get(index + 1).ok_or("--home requires a path")?;
                if home_dir.replace(PathBuf::from(value)).is_some() {
                    return Err("--home may only be provided once".into());
                }
                index += 2;
            }
            "--search-root" => {
                let value = raw.get(index + 1).ok_or("--search-root requires a path")?;
                search_roots.push(PathBuf::from(value));
                index += 2;
            }
            value => return Err(format!("unknown argument: {value}\n{}", usage())),
        }
    }
    Ok(CliAction::Detect {
        json_output,
        diagnose_only,
        detector_ids,
        home_dir,
        search_roots,
    })
}

fn human_output(
    report: &AgentDetectionReport,
    preflight: &[agent_preflight::PreflightResult],
    diagnostics: &agent_diagnostics::DiagnosticsReport,
) -> String {
    let mut output = if report.candidates.is_empty() {
        "No supported Agent runtimes detected.\n".into()
    } else {
        format!("Detected {} Agent runtime(s):\n", report.candidates.len())
    };
    for candidate in &report.candidates {
        output.push_str(&format!(
            "\n{} ({}) [identity={:?}, startability={:?}, acp={:?}]\n  executable: {}\n  args: {}\n",
            candidate.name,
            candidate.provider,
            candidate.identity_confidence,
            candidate.startability,
            candidate.protocol_availability,
            candidate.executable,
            if candidate.args.is_empty() {
                "(none)".into()
            } else {
                candidate.args.join(" ")
            },
        ));
        for evidence in &candidate.evidence {
            output.push_str(&format!(
                "  evidence: {} — {}\n",
                evidence.kind, evidence.detail
            ));
        }
        for warning in &candidate.warnings {
            output.push_str(&format!("  warning: {warning}\n"));
        }
    }
    if !report.diagnostics.is_empty() {
        output.push_str("\nDiagnostics:\n");
        for diagnostic in &report.diagnostics {
            output.push_str(&format!(
                "  {} [{}]{}: {}\n",
                diagnostic.code,
                diagnostic.stage,
                diagnostic
                    .detector_id
                    .as_deref()
                    .map(|id| format!(" ({id})"))
                    .unwrap_or_default(),
                diagnostic.message,
            ));
        }
    }
    if report.truncated {
        output.push_str("\nResult truncated.\n");
    }
    output.push_str(&provider_causes(preflight));
    output.push_str(&environment_section(diagnostics));
    output
}

/// Per-provider cause lines: the answer to "why does Pylon not see it?".
///
/// This is the part the text output used to drop entirely — the preflight was
/// computed for every provider and then only emitted under `--json`, so the
/// human-readable path showed candidates with no explanation of the ones that
/// were missing.
fn provider_causes(preflight: &[agent_preflight::PreflightResult]) -> String {
    if preflight.is_empty() {
        return String::new();
    }
    let mut output = String::from("\nProvider status:\n");
    for entry in preflight {
        output.push_str(&format!(
            "  {:<14} {:<16} [{}] {}\n",
            entry.provider,
            entry.status.as_str(),
            entry.cause.level.as_str(),
            entry.cause.summary
        ));
    }
    output
}

/// Environment evidence: the copyable part, and the section that answers "works
/// in my terminal but not in the app".
///
/// Values are the allow-listed, credential-masked set from `agent_diagnostics` —
/// never an arbitrary environment dump. It does contain absolute paths (that is
/// what makes a PATH gap diagnosable), so it is not anonymous.
fn environment_section(diagnostics: &agent_diagnostics::DiagnosticsReport) -> String {
    let mut output = format!(
        "\nEnvironment:\n  verdict: {}\n",
        diagnostics.verdict.as_str()
    );
    output.push_str(&format!(
        "  app PATH entries: {}\n",
        diagnostics.path_entries.len()
    ));
    let gap = agent_diagnostics::persisted_path_gap();
    if !gap.observed {
        output.push_str("  PATH gap: unknown (persisted PATH could not be read)\n");
    } else {
        output.push_str(&format!(
            "  PATH gap: {} dir(s) a new process would have but this one does not\n",
            gap.missing_from_app_path.len()
        ));
        for dir in &gap.missing_from_app_path {
            output.push_str(&format!("    + {dir}\n"));
        }
    }
    output
}

/// `--diagnose`: only the diagnosis, no candidate dump. This is the artifact a
/// user pastes into a report.
fn diagnostics_output(
    diagnostics: &agent_diagnostics::DiagnosticsReport,
    preflight: &[agent_preflight::PreflightResult],
) -> String {
    let mut output = String::from("Pylon environment diagnostics\n");
    output.push_str(&environment_section(diagnostics));
    output.push_str(&provider_causes(preflight));
    output.push_str("\nEnvironment variables (allow-listed; credential-looking values masked):\n");
    for (key, value) in &diagnostics.environment {
        output.push_str(&format!("  {key}={value}\n"));
    }
    output
}

fn main() {
    let action = match parse_raw(&std::env::args().skip(1).collect::<Vec<_>>()) {
        Ok(action) => action,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let (json_output, diagnose_only, detector_ids, home_dir, search_roots) = match action {
        CliAction::Help => {
            print!("{}", help());
            return;
        }
        CliAction::Version => {
            println!("pylon-detect {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        CliAction::Detect {
            json_output,
            diagnose_only,
            detector_ids,
            home_dir,
            search_roots,
        } => (
            json_output,
            diagnose_only,
            detector_ids,
            home_dir,
            search_roots,
        ),
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("failed to initialize detector runtime: {error}");
            std::process::exit(1);
        }
    };
    let options = AgentDetectionOptions {
        detector_ids: (!detector_ids.is_empty()).then_some(detector_ids),
        home_dir,
        search_roots: (!search_roots.is_empty()).then_some(search_roots),
        ..AgentDetectionOptions::default()
    };
    match runtime.block_on(detect_agent_runtime_candidates(options)) {
        Ok(report) => {
            let diagnostics = agent_diagnostics::report(!report.candidates.is_empty(), &[]);
            // A1：preflight 按 **provider** 展开，而不是只按已发现的候选。覆盖
            // `adapterMissing`/`configOnly` 这类「没有 ACP 候选但仍需要给用户一个可
            // 行动结论」的情形。
            let preflight = report
                .providers
                .iter()
                .filter_map(|evidence| {
                    agent_preflight::from_detection(evidence, &report.candidates).ok()
                })
                .collect::<Vec<_>>();
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string(&json!({
                        "report": report,
                        "diagnostics": diagnostics,
                        "preflight": preflight
                    }))
                    .unwrap()
                );
            } else if diagnose_only {
                print!("{}", diagnostics_output(&diagnostics, &preflight));
            } else {
                print!("{}", human_output(&report, &preflight, &diagnostics));
            }
        }
        Err(error) => {
            if json_output {
                eprintln!(
                    "{}",
                    serde_json::to_string(&json!({
                        "error": { "code": "agent_detection_failed", "message": error }
                    }))
                    .unwrap()
                );
            } else {
                eprintln!("pylon-detect: {error}");
            }
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parses_repeatable_filters_and_fixture_roots() {
        assert_eq!(
            parse_raw(&strings(&[
                "--json",
                "--detector",
                "builtin.detector.hermes",
                "--detector",
                "builtin.detector.peri",
                "--home",
                "fixture-home",
                "--search-root",
                "bin-a",
                "--search-root",
                "bin-b",
            ]))
            .unwrap(),
            CliAction::Detect {
                json_output: true,
                diagnose_only: false,
                detector_ids: vec![
                    "builtin.detector.hermes".into(),
                    "builtin.detector.peri".into(),
                ],
                home_dir: Some(PathBuf::from("fixture-home")),
                search_roots: vec![PathBuf::from("bin-a"), PathBuf::from("bin-b")],
            }
        );
    }

    /// `--diagnose` 是可复制的诊断报告开关，与 `--json` 各自独立。
    #[test]
    fn diagnose_is_parsed_as_its_own_mode() {
        assert_eq!(
            parse_raw(&strings(&["--diagnose"])).unwrap(),
            CliAction::Detect {
                json_output: false,
                diagnose_only: true,
                detector_ids: Vec::new(),
                home_dir: None,
                search_roots: Vec::new(),
            }
        );
        // 默认（未给 --diagnose）仍是普通文本输出。
        assert_eq!(
            parse_raw(&strings(&[])).unwrap_or(CliAction::Help),
            CliAction::Help
        );
    }

    #[test]
    fn help_version_and_invalid_arguments_are_explicit() {
        assert_eq!(parse_raw(&strings(&["--help"])).unwrap(), CliAction::Help);
        assert_eq!(
            parse_raw(&strings(&["--version"])).unwrap(),
            CliAction::Version
        );
        assert!(parse_raw(&strings(&["--home"]))
            .unwrap_err()
            .contains("requires"));
        assert!(parse_raw(&strings(&["--unknown"]))
            .unwrap_err()
            .contains("unknown"));
    }

    #[test]
    fn human_output_does_not_need_access_to_configuration_values() {
        let candidate = AgentRuntimeCandidate {
            candidate_id: "fixture:path".into(),
            detector_id: "fixture".into(),
            provider: "fixture".into(),
            suggested_agent_id: "fixture".into(),
            name: "Fixture".into(),
            executable: "fixture.exe".into(),
            args: vec!["acp".into()],
            evidence: vec![pylon_core::agent_detection::AgentDetectionEvidence {
                kind: "config-fields".into(),
                detail: "config.yaml [provider, model]".into(),
            }],
            identity_confidence: IdentityConfidence::High,
            startability: Startability::NotTested,
            protocol_availability: ProtocolAvailability::NotTested,
            already_imported_agent_id: None,
            warnings: Vec::new(),
        };
        let output = human_output(
            &AgentDetectionReport {
                candidates: vec![candidate],
                providers: Vec::new(),
                diagnostics: Vec::new(),
                elapsed_ms: 5,
                truncated: false,
            },
            &[],
            &agent_diagnostics::report(true, &[]),
        );
        assert!(output.contains("config.yaml [provider, model]"));
        assert!(!output.contains("api_key"));
    }

    /// C4：文本输出必须展示每个 provider 的**原因**，而不是算完只发 JSON。
    ///
    /// 这条测试锁的是一个真实缺口：`preflight` 原本在非 JSON 路径上被完整计算出
    /// 来却直接丢弃，于是“人读的那条路径”只列候选，对缺失的 provider 一言不发。
    #[test]
    fn text_output_reports_the_cause_for_providers_that_are_not_installable() {
        let preflight = agent_preflight::evaluate(
            "claude-code",
            &agent_preflight::PreflightInputs {
                acp_present: true,
                native_present: false,
                ..Default::default()
            },
        )
        .unwrap();
        let output = provider_causes(&[preflight]);
        assert!(output.contains("claude-code"), "必须点名 provider");
        assert!(
            output.contains("ok") && output.contains("ACP"),
            "必须给出可读原因: {output}"
        );
    }
}
