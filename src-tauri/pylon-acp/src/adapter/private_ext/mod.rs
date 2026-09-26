//! Closed provider-specific parser/builder boundary.
use crate::{plan_policy, question_policy};
use agent_client_protocol_schema::v1::{CreateElicitationRequest, ElicitationScope};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivateBridge {
    GrokExtQuestions,
    PiSelectAsk,
    GrokExitPlan,
    /// #98：`elicitation/create` 通用协议桥——按方法名路由，不绑定任何
    /// provider。请求保持 raw（message/requestedSchema 原样观测），应答按
    /// ESM 风格 action 三值（accept/decline/cancel），不伪造 option 或成功。
    Elicitation,
}

impl PrivateBridge {
    /// 交互队列 canonical kind（#230：dispatcher admit 与 CLI
    /// interaction_list 投影共用此单一映射，防漂移）。
    pub fn queue_kind(self) -> &'static str {
        match self {
            Self::GrokExitPlan => "approval",
            Self::Elicitation => "elicitation",
            Self::GrokExtQuestions | Self::PiSelectAsk => "ask-user",
        }
    }
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
        "elicitation/create" => parse_elicitation(params).map(|_| ()),
        _ => Ok(()),
    }
}

/// `elicitation/create` 参数校验：message 必须是 string（可缺省）、
/// requestedSchema 缺省或 object、`mode` 显式给出时只能是 `"form"`。
/// #349 B2：Pylon 仅广告 form 模式（initialize_plan 只注入
/// `elicitation:{form:{}}`），官方语义「未广告的 mode 视为不支持，agent
/// 不得发起」——url 等其它 mode 在此 fail-closed（调用方按 -32602 拒绝），
/// 不再静默放行；缺省 `mode` 视为旧式隐式 form，保持兼容。
pub fn parse_elicitation(params: &Value) -> Result<(), String> {
    if !params.is_object() {
        return Err("elicitation/create params must be an object".into());
    }
    if let Some(mode) = params.get("mode").and_then(Value::as_str) {
        if mode != "form" {
            return Err(format!(
                "elicitation/create mode `{mode}` is not advertised (only form is supported)"
            ));
        }
    }
    if let Some(message) = params.get("message") {
        if !message.is_string() {
            return Err("elicitation/create message must be a string".into());
        }
    }
    if let Some(schema) = params.get("requestedSchema") {
        if !schema.is_object() {
            return Err("elicitation/create requestedSchema must be an object".into());
        }
    }
    Ok(())
}

/// #356：request-scoped elicitation 的 scope 投影结论。`Session` 携带投影出的
/// 非空 sessionId（与既有会话内路径同构）；`Request` 是会话外（auth/config
/// 阶段）elicitation——wire 上没有 sessionId，宿主以空串入队、身份由
/// requestId+agentId 收口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElicitationScopeProjection {
    Session { session_id: String },
    Request,
}

/// #356：空 `sessionId` 的 elicitation/create 走官方 typed
/// `CreateElicitationRequest` 解析并按 scope 投影。解析失败（mode/message/
/// requestedSchema/scope 任一不符合官方形状）回 Err，调用方按参数类错误
/// （-32602）拒绝；`Session` scope 的 id 为显式空串时同样 Err——空串在前后端
/// 三道门均当缺失，入队只会让 agent 挂等一个永不来的响应。未广告的
/// `mode:"url"` 在 [`parse_elicitation`] 已 fail-closed，不会到达本函数。
pub fn project_elicitation_scope(params: &Value) -> Result<ElicitationScopeProjection, String> {
    let request: CreateElicitationRequest =
        serde_json::from_value(params.clone()).map_err(|error| {
            format!("elicitation/create params do not match the official shape: {error}")
        })?;
    match request.scope() {
        ElicitationScope::Session(session) => {
            let session_id = session.session_id.0.to_string();
            if session_id.is_empty() {
                return Err("elicitation/create session scope carries an empty sessionId".into());
            }
            Ok(ElicitationScopeProjection::Session { session_id })
        }
        ElicitationScope::Request(_) => Ok(ElicitationScopeProjection::Request),
        // #[non_exhaustive]：schema 未来可能新增 scope 变体——fail-closed 拒绝
        // （issue 措辞「未知变体 fail-closed 拒绝」）。
        _ => Err("elicitation/create scope variant is not supported by this host".into()),
    }
}

/// elicitation 应答形状：action ∈ accept/decline/cancel；accept 携带 content
/// （用户 freeform/表单值，原样透传，宿主不解释 schema 语义）。
pub fn build_elicitation_response(action: &str, content: Option<&Value>) -> Result<Value, String> {
    match action {
        "accept" => Ok(serde_json::json!({
            "action": "accept",
            "content": content.cloned().unwrap_or(serde_json::json!({})),
        })),
        "decline" => Ok(serde_json::json!({"action": "decline"})),
        "cancel" => Ok(serde_json::json!({"action": "cancel"})),
        other => Err(format!("elicitation action unsupported: {other}")),
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
        PrivateBridge::GrokExitPlan | PrivateBridge::Elicitation => {
            Err("plan/elicitation bridge does not accept questions".into())
        }
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
        PrivateBridge::GrokExitPlan | PrivateBridge::Elicitation => {
            Err("plan/elicitation bridge does not accept question answers".into())
        }
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

    /// #98：elicitation/create 走通用桥——不绑定 provider；合法/非法形状与
    /// action 三值应答。
    #[test]
    fn elicitation_bridge_is_provider_free_and_fail_closed() {
        assert!(validate_request(
            "elicitation/create",
            &serde_json::json!({"message": "Provide details", "requestedSchema": {"type": "object"}})
        )
        .is_ok());
        assert!(
            validate_request("elicitation/create", &serde_json::json!({"message": "m"})).is_ok()
        );
        assert!(
            validate_request("elicitation/create", &serde_json::json!({"message": 42})).is_err()
        );
        assert!(validate_request(
            "elicitation/create",
            &serde_json::json!({"requestedSchema": "not-an-object"})
        )
        .is_err());
        assert!(validate_request("elicitation/create", &serde_json::json!([])).is_err());

        assert_eq!(
            build_elicitation_response("accept", Some(&serde_json::json!({"answer": "detail"})))
                .unwrap(),
            serde_json::json!({"action": "accept", "content": {"answer": "detail"}})
        );
        assert_eq!(
            build_elicitation_response("cancel", None).unwrap(),
            serde_json::json!({"action": "cancel"})
        );
        assert!(build_elicitation_response("invent", None).is_err());
    }

    /// #349 B2：未广告的 mode fail-closed（url 显式拒绝；缺省 mode 视为旧式
    /// 隐式 form 保持兼容）。
    #[test]
    fn elicitation_mode_gate_rejects_unadvertised_modes() {
        assert!(parse_elicitation(&serde_json::json!({
            "mode": "form", "message": "m", "requestedSchema": {"type": "object"}
        }))
        .is_ok());
        // 缺省 mode = 旧式隐式 form，兼容放行。
        assert!(parse_elicitation(&serde_json::json!({"message": "m"})).is_ok());
        // url / 自定义 mode 未广告，显式拒绝。
        assert!(parse_elicitation(&serde_json::json!({
            "mode": "url", "elicitationId": "e", "url": "https://x"
        }))
        .is_err());
        assert!(parse_elicitation(&serde_json::json!({"mode": "_vendor.custom"})).is_err());
    }

    /// #356：typed scope 投影——Request scope（无 sessionId、带 requestId）
    /// 放行为 request-scoped；Session scope 取回非空 sessionId；显式空
    /// sessionId 与官方形状缺失（message/requestedSchema/scope）fail-closed。
    #[test]
    fn elicitation_scope_projection_matches_official_shapes() {
        use ElicitationScopeProjection as P;
        // request-scoped：官方 auth/config 阶段形状。
        assert_eq!(
            project_elicitation_scope(&serde_json::json!({
                "mode": "form",
                "requestId": 7,
                "message": "auth configuration needed",
                "requestedSchema": {"type": "object", "properties": {}, "required": []}
            }))
            .unwrap(),
            P::Request
        );
        // session-scoped（经 typed 路径）取回投影 id。
        assert_eq!(
            project_elicitation_scope(&serde_json::json!({
                "mode": "form",
                "sessionId": "peri-s1",
                "message": "m",
                "requestedSchema": {"type": "object"}
            }))
            .unwrap(),
            P::Session {
                session_id: "peri-s1".into()
            }
        );
        // 显式空 sessionId：Session scope 形状成立但 id 为空——fail-closed。
        assert!(project_elicitation_scope(&serde_json::json!({
            "mode": "form", "sessionId": "", "message": "m",
            "requestedSchema": {"type": "object"}
        }))
        .is_err());
        // 无任何 scope：官方形状缺失。
        assert!(project_elicitation_scope(
            &serde_json::json!({"mode": "form", "message": "m", "requestedSchema": {"type": "object"}})
        )
        .is_err());
        // message 官方必填。
        assert!(project_elicitation_scope(
            &serde_json::json!({"mode": "form", "requestId": 1, "requestedSchema": {"type": "object"}})
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
