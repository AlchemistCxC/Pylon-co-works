use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::LazyLock;

#[derive(Deserialize)]
struct CliManifest {
    commands: Vec<String>,
    aliases: BTreeMap<String, String>,
}

static CLI_MANIFEST: LazyLock<CliManifest> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../shared/pylon-cli-manifest.json"))
        .expect("shared/pylon-cli-manifest.json must be valid")
});

fn usage() -> &'static str {
    "usage: pylon-cli [--json] [--timeout <ms>] <command> [positionals] [--key <value>] [--args <json>]\n       pylon-cli help | --help\n       pylon-cli --version"
}

fn help() -> String {
    let mut output = String::from("Pylon CLI — control a running Pylon application\n\n");
    output.push_str(usage());
    output.push_str("\n\nCommands:\n");
    for command in &CLI_MANIFEST.commands {
        output.push_str(&format!("  {command}\n"));
    }
    output.push_str("\nAliases:\n");
    for (alias, target) in &CLI_MANIFEST.aliases {
        output.push_str(&format!("  {alias:<10} {target}\n"));
    }
    output.push_str(
        "\nFirst command segments accept an unambiguous prefix (for example `plug list`).\n",
    );
    output
}

fn parse_value(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_string()))
}

fn camel_case(value: &str) -> String {
    let mut output = String::new();
    let mut upper = false;
    for character in value.chars() {
        if character == '-' {
            upper = true;
        } else if upper {
            output.extend(character.to_uppercase());
            upper = false;
        } else {
            output.push(character);
        }
    }
    output
}

#[derive(Debug, PartialEq)]
enum CliAction {
    Help,
    Version,
    Invoke {
        command: String,
        args: Value,
        timeout_ms: u64,
        json_output: bool,
    },
}

fn resolve_command(
    raw: &[String],
    command_start: usize,
) -> Result<(String, usize, Vec<Value>), String> {
    let first = raw.get(command_start).ok_or_else(|| usage().to_string())?;
    if let Some(target) = CLI_MANIFEST.aliases.get(first) {
        let parts = target.split_whitespace().collect::<Vec<_>>();
        let command = parts.iter().take(2).copied().collect::<Vec<_>>().join(" ");
        let injected = parts
            .iter()
            .skip(2)
            .map(|value| Value::String((*value).into()))
            .collect();
        return Ok((command, 1, injected));
    }

    let mut exact = CLI_MANIFEST
        .commands
        .iter()
        .filter_map(|candidate| {
            let parts = candidate.split_whitespace().collect::<Vec<_>>();
            raw.iter()
                .skip(command_start)
                .take(parts.len())
                .map(String::as_str)
                .eq(parts.iter().copied())
                .then_some((candidate.to_string(), parts.len()))
        })
        .collect::<Vec<_>>();
    exact.sort_by(|left, right| right.1.cmp(&left.1));
    if let Some(value) = exact.first() {
        return Ok((value.0.clone(), value.1, Vec::new()));
    }

    let second = raw.get(command_start + 1).map(String::as_str);
    let prefix_matches = CLI_MANIFEST
        .commands
        .iter()
        .filter(|candidate| {
            let parts = candidate.split_whitespace().collect::<Vec<_>>();
            parts.first().is_some_and(|group| group.starts_with(first))
                && second.is_some_and(|action| parts.get(1).copied() == Some(action))
        })
        .map(String::as_str)
        .collect::<Vec<_>>();
    if prefix_matches.len() == 1 {
        return Ok((prefix_matches[0].into(), 2, Vec::new()));
    }
    if prefix_matches.len() > 1 {
        return Err(format!(
            "ambiguous command: {}\ncandidates: {}",
            raw[command_start..=command_start + 1].join(" "),
            prefix_matches.join(" / ")
        ));
    }

    let single_matches = CLI_MANIFEST
        .commands
        .iter()
        .filter(|candidate| candidate.split_whitespace().nth(1) == Some(first.as_str()))
        .map(String::as_str)
        .collect::<Vec<_>>();
    if single_matches.len() == 1 {
        return Ok((single_matches[0].into(), 1, Vec::new()));
    }
    if single_matches.len() > 1 {
        return Err(format!(
            "ambiguous command: {first}\ncandidates: {}",
            single_matches.join(" / ")
        ));
    }
    Err(format!("unknown command: {first}\n{}", usage()))
}

fn parse_raw(raw: &[String]) -> Result<CliAction, String> {
    let action_tokens = raw
        .iter()
        .filter(|value| value.as_str() != "--json")
        .collect::<Vec<_>>();
    if raw.is_empty()
        || (action_tokens.len() == 1
            && matches!(action_tokens[0].as_str(), "help" | "--help" | "-h"))
    {
        return Ok(CliAction::Help);
    }
    if action_tokens.len() == 1 && matches!(action_tokens[0].as_str(), "--version" | "-V") {
        return Ok(CliAction::Version);
    }
    let json_output = raw.iter().any(|value| value == "--json");
    let mut command_start = 0usize;
    while command_start < raw.len() {
        match raw[command_start].as_str() {
            "--json" => command_start += 1,
            "--timeout" | "--args" => command_start += 2,
            _ => break,
        }
    }
    let (command, consumed_raw_parts, mut positionals) = resolve_command(raw, command_start)?;
    let mut consumed_command_parts = 0usize;
    let mut args = Map::new();
    let mut timeout_ms = pylon_core::cli_client::DEFAULT_TIMEOUT_MS;
    let mut index = 0usize;
    while index < raw.len() {
        let token = &raw[index];
        if token == "--json" {
            index += 1;
            continue;
        }
        if token == "--timeout" {
            let value = raw
                .get(index + 1)
                .ok_or("--timeout requires milliseconds")?;
            timeout_ms = value
                .parse::<u64>()
                .map_err(|_| "--timeout must be an integer")?;
            index += 2;
            continue;
        }
        if token == "--args" {
            let value = raw.get(index + 1).ok_or("--args requires JSON")?;
            let parsed: Value = serde_json::from_str(value)
                .map_err(|error| format!("invalid --args JSON: {error}"))?;
            let object = parsed.as_object().ok_or("--args must be a JSON object")?;
            args.extend(object.clone());
            index += 2;
            continue;
        }
        if let Some(flag) = token.strip_prefix("--") {
            let key = camel_case(flag);
            let next = raw.get(index + 1).filter(|value| !value.starts_with("--"));
            if let Some(value) = next {
                args.insert(key, parse_value(value));
                index += 2;
            } else {
                if flag == "stderr" || flag == "stdout" {
                    args.insert("stream".into(), Value::String(flag.into()));
                } else {
                    args.insert(key, Value::Bool(true));
                }
                index += 1;
            }
            continue;
        }
        if index >= command_start && consumed_command_parts < consumed_raw_parts {
            consumed_command_parts += 1;
        } else {
            positionals.push(parse_value(token));
        }
        index += 1;
    }
    if !positionals.is_empty() {
        args.insert("positionals".into(), Value::Array(positionals));
    }
    Ok(CliAction::Invoke {
        command,
        args: Value::Object(args),
        timeout_ms,
        json_output,
    })
}

fn parse() -> Result<CliAction, String> {
    parse_raw(&std::env::args().skip(1).collect::<Vec<_>>())
}

fn main() {
    let (command, args, timeout_ms, json_output) = match parse() {
        Ok(CliAction::Help) => {
            print!("{}", help());
            return;
        }
        Ok(CliAction::Version) => {
            println!("pylon-cli {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Ok(CliAction::Invoke {
            command,
            args,
            timeout_ms,
            json_output,
        }) => (command, args, timeout_ms, json_output),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("failed to initialize CLI runtime: {error}");
            std::process::exit(1);
        }
    };
    match runtime.block_on(pylon_core::cli_client::invoke_running_kernel(
        command, args, timeout_ms, "cli",
    )) {
        Ok(result) => {
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string(&json!({ "ok": true, "result": result })).unwrap()
                );
            } else if let Some(operation_id) = result.get("operationId").and_then(Value::as_str) {
                println!("Operation: {operation_id}");
                println!(
                    "{}",
                    serde_json::to_string_pretty(result.get("result").unwrap_or(&Value::Null))
                        .unwrap()
                );
            } else {
                println!("{}", serde_json::to_string_pretty(&result).unwrap());
            }
        }
        Err(error) => {
            if json_output {
                eprintln!(
                    "{}",
                    serde_json::to_string(&json!({
                        "ok": false,
                        "error": { "code": "pylon_cli_error", "message": error }
                    }))
                    .unwrap()
                );
            } else {
                eprintln!("pylon-cli: {error}");
            }
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_cases_cli_flags_and_parses_json_values() {
        assert_eq!(camel_case("runtime-instance-id"), "runtimeInstanceId");
        assert_eq!(parse_value("true"), Value::Bool(true));
        assert_eq!(parse_value("plain"), Value::String("plain".into()));
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parses_new_commands_aliases_and_unique_prefixes() {
        let CliAction::Invoke { command, args, .. } = parse_raw(&strings(&[
            "command",
            "exec",
            "compact",
            "--args",
            "{\"force\":true}",
        ]))
        .unwrap() else {
            panic!()
        };
        assert_eq!(command, "command exec");
        assert_eq!(args["positionals"], json!(["compact"]));
        assert_eq!(args["force"], Value::Bool(true));

        let CliAction::Invoke { command, args, .. } = parse_raw(&strings(&["compact"])).unwrap()
        else {
            panic!()
        };
        assert_eq!(command, "command exec");
        assert_eq!(args["positionals"], json!(["compact"]));

        let CliAction::Invoke { command, .. } = parse_raw(&strings(&["sess", "list"])).unwrap()
        else {
            panic!()
        };
        assert_eq!(command, "session list");
    }

    #[test]
    fn help_and_version_are_success_actions_and_ambiguity_lists_candidates() {
        assert_eq!(parse_raw(&strings(&["--help"])).unwrap(), CliAction::Help);
        assert_eq!(
            parse_raw(&strings(&["--version"])).unwrap(),
            CliAction::Version
        );
        let error = parse_raw(&strings(&["list"])).unwrap_err();
        assert!(error.contains("ambiguous command"));
        assert!(error.contains("plugin list"));
        assert!(error.contains("session list"));
        let CliAction::Invoke { command, args, .. } =
            parse_raw(&strings(&["session", "send", "s-1", "help"])).unwrap()
        else {
            panic!()
        };
        assert_eq!(command, "session send");
        assert_eq!(args["positionals"], json!(["s-1", "help"]));
    }
}
