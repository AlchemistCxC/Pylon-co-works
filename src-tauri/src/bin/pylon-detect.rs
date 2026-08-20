use pylon_core::agent_detection::{
    detect_agent_runtime_candidates, AgentDetectionOptions, AgentDetectionReport,
    AgentRuntimeCandidate, IdentityConfidence, ProtocolAvailability,
};
use serde_json::json;
use std::path::PathBuf;

fn usage() -> &'static str {
    "usage: pylon-detect [--json] [--detector <id>] [--home <path>] [--search-root <path>]\n       pylon-detect help | --help\n       pylon-detect --version"
}

fn help() -> String {
    format!(
        "Pylon Agent Detector — discover supported local ACP runtimes\n\n{}\n\nOptions:\n  --json                 Emit a stable JSON document\n  --detector <id>        Limit detection to one detector; repeatable\n  --home <path>          Override the home used for config evidence\n  --search-root <path>   Search only this executable directory; repeatable\n\nConfiguration values are never emitted. Evidence includes paths and matched field names only.\n",
        usage()
    )
}

#[derive(Debug, PartialEq, Eq)]
enum CliAction {
    Help,
    Version,
    Detect {
        json_output: bool,
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
        detector_ids,
        home_dir,
        search_roots,
    })
}

fn human_output(report: &AgentDetectionReport) -> String {
    let mut output = if report.candidates.is_empty() {
        "No supported Agent runtimes detected.\n".into()
    } else {
        format!("Detected {} Agent runtime(s):\n", report.candidates.len())
    };
    for candidate in &report.candidates {
        output.push_str(&format!(
            "\n{} ({}) [identity={:?}, acp={:?}]\n  executable: {}\n  args: {}\n",
            candidate.name,
            candidate.provider,
            candidate.identity_confidence,
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
    let (json_output, detector_ids, home_dir, search_roots) = match action {
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
            detector_ids,
            home_dir,
            search_roots,
        } => (json_output, detector_ids, home_dir, search_roots),
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
            if json_output {
                println!("{}", serde_json::to_string(&report).unwrap());
            } else {
                print!("{}", human_output(&report));
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
                detector_ids: vec![
                    "builtin.detector.hermes".into(),
                    "builtin.detector.peri".into(),
                ],
                home_dir: Some(PathBuf::from("fixture-home")),
                search_roots: vec![PathBuf::from("bin-a"), PathBuf::from("bin-b")],
            }
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
            protocol_availability: ProtocolAvailability::NotTested,
            already_imported_agent_id: None,
            warnings: Vec::new(),
        };
        let output = human_output(&AgentDetectionReport {
            candidates: vec![candidate],
            diagnostics: Vec::new(),
            elapsed_ms: 5,
            truncated: false,
        });
        assert!(output.contains("config.yaml [provider, model]"));
        assert!(!output.contains("api_key"));
    }
}
