//! 交互桥知识收敛缝（#416 W2 wave2 步骤 6 起步，#424 随 private_ext 迁宿主
//! protocol_adapter 域）：私有交互「超时默认动作」裁决表。本模块与
//! private_ext（解析/构造）同域，唯一生产消费者是宿主 permission.rs 的超时
//! sweep——跨 crate 留在引擎侧即 vendor 方言泄漏，故随迁。桥的应答构造
//! （build_response）与准入投影（admit）涉及宿主应答输入类型与 store 生命
//! 周期，按 #416 §4.3 后续步骤迁移。

use super::private_ext::PrivateBridge;
use pylon_acp::plan_policy;
use pylon_acp::question_policy;

/// #356：私有交互超时的默认回包（产品裁决落在这一处）。
/// 语义基准：**超时 = 用户未应答**，回包必须取各桥的**非承诺值**——
/// - elicitation → `cancel`（用户未作答；`decline` 会断言用户明确拒绝，不成立）；
/// - grok/pi 问题桥 → 既有 declined 映射（`skip_interview` / `cancelled:true`）；
/// - exit_plan → `keep_planning`（超时绝不批准，也不代替用户放弃计划）。
///
/// 与 `pending_permissions` 的超时默认拒绝（pick_option prefer_reject）同一
/// 「不悬挂、不批准」取向。错误为稳定原因串（宿主负责映射为 PylonError）。
pub fn timeout_default_response(
    bridge: PrivateBridge,
    question_specs: Option<&[question_policy::QuestionSpec]>,
) -> Result<serde_json::Value, String> {
    match bridge {
        PrivateBridge::Elicitation => {
            super::private_ext::build_elicitation_response("cancel", None)
        }
        PrivateBridge::GrokExtQuestions | PrivateBridge::PiSelectAsk => {
            let questions = question_specs
                .ok_or_else(|| "private question request lost validated specs".to_string())?;
            super::private_ext::build_question_response(
                bridge,
                questions,
                &question_policy::QuestionAnswer {
                    answers: Vec::new(),
                    declined: true,
                },
            )
        }
        PrivateBridge::GrokExitPlan => Ok(plan_policy::approval_response("keep_planning", "")),
    }
}
