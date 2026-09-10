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
            question_policy::parse_questions(params)
        }
        PrivateBridge::GrokExitPlan => Err("plan bridge does not accept questions".into()),
    }
}
pub fn build_question_outcome(
    bridge: PrivateBridge,
    questions: &[question_policy::QuestionSpec],
    answer: &question_policy::QuestionAnswer,
) -> Result<Value, String> {
    match bridge {
        PrivateBridge::GrokExtQuestions | PrivateBridge::PiSelectAsk => {
            serde_json::to_value(question_policy::build_outcome(questions, answer))
                .map_err(|e| e.to_string())
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
            build_question_outcome(PrivateBridge::GrokExtQuestions, &questions, &answer).unwrap();
        assert_eq!(outcome["answers"][0]["selected"][0], "A");
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
}
