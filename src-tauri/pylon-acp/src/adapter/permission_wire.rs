//! request_permission 的 wire 纯函数（#416 W2 wave2 步骤 5，§4.4.4 第一步）：
//! 解析（parse）与应答构造（build）正身自宿主 `src/permission.rs` 逐字平移。
//! 零 tauri、零宿主状态——脱敏经 `pylon-foundations::sanitize`（宿主
//! `crate::sanitize` 本就是同 crate 再导出，逐字节同实现），时间戳经
//! `pylon-foundations::time::Timestamp`（同一类型）。宿主 `permission.rs`
//! 经 `pub(crate) use` 再导出，全部既有消费路径不变。

use pylon_foundations::time::Timestamp;

/// 权限请求事件中 prompt 的安全上限（B9.4：事件不含完整 secret 载荷）。
const PERMISSION_PROMPT_MAX_CHARS: usize = 500;

/// ACP-02（§5.5）：wire option 项的后端保留形态。
///
/// `option_id` 是唯一协议值（response 必须回写原值，禁止正规化/小写化）；
/// `kind`/`name` 仅供 UI 分类与展示，不参与应答；`raw` 保留原文供前端宽容读取。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

impl PermissionOption {
    /// 仅携带 optionId 的选项（测试与精简构造）。
    #[allow(
        dead_code,
        reason = "测试便捷构造器（宿主 permission/protocol_adapter 测试经再导出使用）"
    )]
    pub fn plain(option_id: impl Into<String>) -> Self {
        Self {
            option_id: option_id.into(),
            kind: None,
            name: None,
            raw: None,
        }
    }
}

/// 挂起的权限请求（B9，Peri agent 实证方向：agent 主动 request_permission，客户端应答）。
#[derive(Clone)]
pub struct PendingPermission {
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    /// raw_input 脱敏摘要（事件安全字段，不含完整载荷）。
    pub prompt: String,
    /// 可用选项 option_id（allow_once/reject_once/...），应答时校验。
    pub options: Vec<PermissionOption>,
    /// C4：应答身份复核——解析时记录的 client_generation。客户端替换
    /// （generation 前进）后，旧进程的应答决策不得误写新进程同 id 请求。
    pub client_generation: u64,
    /// R4：Timestamp（事件 payload 序列化为字符串，契约不变）。
    pub requested_at: Timestamp,
}

/// C4：带 client_generation 的解析入口——记录请求到达时的身份 generation，
/// 应答时复核（宿主 respond_permission）。
pub fn parse_permission_request_with_generation(
    params: Option<&serde_json::Value>,
    client_generation: u64,
) -> Option<PendingPermission> {
    let params = params?;
    let session_id = params.get("sessionId")?.as_str()?.to_string();
    let tool_call = params.get("toolCall")?;
    let tool_call_id = tool_call.get("toolCallId")?.as_str()?.to_string();
    let title = tool_call
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let raw_input = tool_call
        .get("rawInput")
        .map(serde_json::Value::to_string)
        .unwrap_or_default();
    let prompt: String = pylon_foundations::sanitize::sanitize_message(&raw_input)
        .chars()
        .take(PERMISSION_PROMPT_MAX_CHARS)
        .collect();
    // ACP-02（§5.5）：typed options——optionId 原值保留（禁止正规化），
    // kind/name 宽容保留（未知 kind 不丢弃，交前端显示），raw 原样透传。
    let options: Vec<PermissionOption> = params
        .get("options")?
        .as_array()?
        .iter()
        .filter_map(|option| {
            let option_id = option.get("optionId")?.as_str()?.to_string();
            Some(PermissionOption {
                option_id,
                kind: option
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                name: option
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                raw: option.get("raw").cloned(),
            })
        })
        .collect();
    if options.is_empty() {
        return None;
    }
    Some(PendingPermission {
        session_id,
        tool_call_id,
        title,
        prompt,
        options,
        client_generation,
        requested_at: Timestamp::now(),
    })
}

/// 构造 request_permission 应答（官方 schema 类型保证 wire 格式）。
pub fn permission_response(option_id: &str) -> serde_json::Value {
    use agent_client_protocol_schema::v1::{
        RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome,
    };
    serde_json::to_value(RequestPermissionResponse::new(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id.to_string())),
    ))
    .unwrap_or_else(|_| serde_json::json!({"outcome": {"selected": {"optionId": option_id}}}))
}

/// request_permission 应答：Cancelled（session/cancel 时必须应答所有挂起请求）。
pub fn permission_response_cancelled() -> serde_json::Value {
    use agent_client_protocol_schema::v1::{RequestPermissionOutcome, RequestPermissionResponse};
    serde_json::to_value(RequestPermissionResponse::new(
        RequestPermissionOutcome::Cancelled,
    ))
    .unwrap_or_else(|_| serde_json::json!({"outcome": "cancelled"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    // #416 W2 wave2 步骤 5：原宿主 protocol_adapter.rs 测试（:624-648 / :776-802）
    // 随正身平移——解析断言逐字保留，仅调用点从 `RequestPermissionAdapter::
    // normalize_request`（宿主两行委托）收拢为直呼 parse 正身；宿主侧委托层
    // 由 respond 拒绝面与注册表测试继续覆盖。

    /// R2-WI06（Phase F 源码实证）：Hermes 审批 wire 与 Peri 逐字段一致
    /// （session/request_permission + RequestPermissionResponse + optionId 语义集），
    /// 同一 request_permission 解析实现按 provider 复用即可。
    #[test]
    fn hermes_adapter_reuses_request_permission_wire() {
        let params = serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "perm-check-1", "title": "edit"},
            "options": [{"optionId": "allow_once"}, {"optionId": "deny"}]
        });
        let permission = parse_permission_request_with_generation(Some(&params), 5)
            .expect("hermes request_permission 必须按同款 wire 解析");
        assert_eq!(permission.session_id, "s1");
        assert_eq!(permission.tool_call_id, "perm-check-1");
        assert_eq!(
            permission.options,
            vec![
                PermissionOption::plain("allow_once"),
                PermissionOption::plain("deny"),
            ]
        );
    }

    #[test]
    fn peri_normalize_reuses_permission_parser() {
        let params = serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "call-1", "title": "t"},
            "options": [{"optionId": "allow_once"}, {"optionId": "reject_once"}]
        });
        let permission = parse_permission_request_with_generation(Some(&params), 3)
            .expect("合法 request_permission 必须解析");
        assert_eq!(permission.session_id, "s1");
        assert_eq!(permission.tool_call_id, "call-1");
        assert_eq!(permission.client_generation, 3);
        assert_eq!(
            permission.options,
            vec![
                PermissionOption::plain("allow_once"),
                PermissionOption::plain("reject_once"),
            ]
        );
        assert!(
            parse_permission_request_with_generation(
                Some(&serde_json::json!({"sessionId": "s"})),
                0
            )
            .is_none(),
            "缺 options 必须解析失败（调用方按 protocol error 处理）"
        );
    }
}
