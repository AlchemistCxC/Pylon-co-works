//! Pure Grok plan-approval wire policy migrated from codeg.

use serde_json::{json, Value};
pub const MAX_PLAN_MARKDOWN_CHARS: usize = 262_144;
pub const MAX_FEEDBACK_CHARS: usize = 16_384;

pub fn parse_exit_plan_request(params: &Value) -> Result<(String, String), String> {
    let object = params
        .as_object()
        .ok_or("exit_plan_mode params is not an object")?;
    let plan = object
        .get("planContent")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(MAX_PLAN_MARKDOWN_CHARS)
        .collect();
    let tool_call_id = object
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    Ok((plan, tool_call_id))
}

pub fn approval_response(outcome: &str, feedback: &str) -> Value {
    let outcome = match outcome {
        "approved" => "approved",
        "abandoned" => "abandoned",
        _ => "keep_planning",
    };
    json!({"outcome": outcome, "feedback": feedback.chars().take(MAX_FEEDBACK_CHARS).collect::<String>()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_empty_plan_and_tool_call_id() {
        assert_eq!(
            parse_exit_plan_request(&json!({"toolCallId":"tc"})).unwrap(),
            (String::new(), "tc".into())
        );
        assert!(parse_exit_plan_request(&json!(null)).is_err());
    }
    #[test]
    fn normalizes_known_and_unknown_outcomes() {
        assert_eq!(approval_response("approved", "ok")["outcome"], "approved");
        assert_eq!(
            approval_response("other", "note")["outcome"],
            "keep_planning"
        );
    }
}
