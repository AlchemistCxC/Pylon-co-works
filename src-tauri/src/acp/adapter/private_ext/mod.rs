//! Closed provider-specific parser/builder boundary.
use crate::acp::{plan_policy, question_policy};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivateBridge {
    GrokExtQuestions,
    PiSelectAsk,
    GrokExitPlan,
}

/// Validate Codeg-compatible private interaction request shapes before the
/// generic dispatcher rejects an unsupported bridge. This is deliberately a
/// fail-closed parser seam: it never fabricates an answer or RPC response.
pub fn validate_request(method: &str, params: &Value) -> Result<(), String> {
    match method {
        "_x.ai/ask_user_question" => {
            parse_questions(PrivateBridge::GrokExtQuestions, params).map(|_| ())
        }
        "pi/select_ask" => parse_questions(PrivateBridge::PiSelectAsk, params).map(|_| ()),
        "_x.ai/exit_plan_mode" => parse_exit_plan(PrivateBridge::GrokExitPlan, params).map(|_| ()),
        _ => Ok(()),
    }
}

pub fn parse_questions(
    bridge: PrivateBridge,
    params: &Value,
) -> Result<Vec<question_policy::QuestionSpec>, String> {
    match bridge {
        PrivateBridge::GrokExtQuestions | PrivateBridge::PiSelectAsk => {
            let specs = question_policy::parse_questions(params)?;
            question_policy::validate_specs(&specs)?;
            Ok(specs)
        }
        PrivateBridge::GrokExitPlan => Err("plan bridge does not accept questions".into()),
    }
}
/// Serialize the provider-specific response shape documented by Codeg. Grok
/// correlates answers by question text; pi expects an option id (or cancelled).
pub fn build_question_response(
    bridge: PrivateBridge,
    questions: &[question_policy::QuestionSpec],
    answer: &question_policy::QuestionAnswer,
) -> Result<Value, String> {
    let outcome = question_policy::build_outcome(questions, answer);
    match bridge {
        PrivateBridge::GrokExtQuestions => {
            if outcome.declined {
                return Ok(serde_json::json!({"outcome":"skip_interview"}));
            }
            let mut answers = serde_json::Map::new();
            for item in outcome.answers {
                let value = if item.multi_select {
                    Value::Array(item.selected.into_iter().map(Value::String).collect())
                } else if let Some(label) = item.selected.into_iter().next() {
                    Value::String(label)
                } else {
                    continue;
                };
                answers.insert(item.question, value);
            }
            Ok(serde_json::json!({"outcome":"accepted","answers":answers,"partial_answers":{}}))
        }
        PrivateBridge::PiSelectAsk => {
            let option = outcome
                .answers
                .first()
                .and_then(|item| item.selected.first())
                .cloned();
            Ok(match option {
                Some(option_id) => serde_json::json!({"optionId": option_id}),
                None => serde_json::json!({"cancelled":true}),
            })
        }
        PrivateBridge::GrokExitPlan => Err("plan bridge does not accept question answers".into()),
    }
}
pub fn parse_exit_plan(bridge: PrivateBridge, params: &Value) -> Result<(String, String), String> {
    match bridge {
        PrivateBridge::GrokExitPlan => plan_policy::parse_exit_plan_request(params),
        _ => Err("question bridge does not accept plans".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_question_bridge_reuses_shared_policy() {
        let questions = parse_questions(PrivateBridge::GrokExtQuestions, &serde_json::json!({"questions":[{"question":"Pick","header":"Choice","options":[{"label":"A"},{"label":"B"}]}]})).unwrap();
        let answer = question_policy::QuestionAnswer {
            answers: vec![question_policy::QuestionAnswerItem {
                question_id: questions[0].id.clone(),
                labels: vec!["A".into()],
            }],
            declined: false,
        };
        let outcome =
            build_question_response(PrivateBridge::GrokExtQuestions, &questions, &answer).unwrap();
        assert_eq!(outcome["answers"]["Pick"], "A");
    }
    #[test]
    fn private_plan_bridge_reuses_shared_policy() {
        assert_eq!(
            parse_exit_plan(
                PrivateBridge::GrokExitPlan,
                &serde_json::json!({"toolCallId":"t"})
            )
            .unwrap()
            .1,
            "t"
        );
    }

    #[test]
    fn validates_only_known_private_wire_methods() {
        assert!(validate_request(
            "_x.ai/ask_user_question",
            &serde_json::json!({"questions":[{"question":"Pick","header":"Choice","options":[{"label":"A"},{"label":"B"}]}]})
        ).is_ok());
        assert!(validate_request(
            "_x.ai/exit_plan_mode",
            &serde_json::json!({"toolCallId":"t"})
        )
        .is_ok());
        assert!(validate_request("unknown/private", &serde_json::json!(null)).is_ok());
        assert!(validate_request(
            "_x.ai/ask_user_question",
            &serde_json::json!({"questions":[]})
        )
        .is_err());
    }

    #[test]
    fn builds_codeg_provider_response_shapes() {
        let questions = parse_questions(PrivateBridge::GrokExtQuestions, &serde_json::json!({"questions":[{"question":"Pick","header":"Choice","options":[{"label":"A"},{"label":"B"}]}]})).unwrap();
        let answer = question_policy::QuestionAnswer {
            answers: vec![question_policy::QuestionAnswerItem {
                question_id: questions[0].id.clone(),
                labels: vec!["A".into()],
            }],
            declined: false,
        };
        let grok =
            build_question_response(PrivateBridge::GrokExtQuestions, &questions, &answer).unwrap();
        assert_eq!(grok["outcome"], "accepted");
        assert_eq!(grok["answers"]["Pick"], "A");
        let pi = build_question_response(PrivateBridge::PiSelectAsk, &questions, &answer).unwrap();
        assert_eq!(pi["optionId"], "A");
    }
}
