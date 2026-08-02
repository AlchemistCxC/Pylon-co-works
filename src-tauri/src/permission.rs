//! B9 权限审批：挂起请求解析/应答/超时（R1 拆分自 lib.rs；行为零变化）。

use std::sync::atomic::Ordering;

use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::runtime_log;
use crate::time::Timestamp;
use crate::AppState;

/// 权限请求事件中 prompt 的安全上限（B9.4：事件不含完整 secret 载荷）。
const PERMISSION_PROMPT_MAX_CHARS: usize = 500;
/// 挂起的权限请求超时（B9.2：超时默认拒绝）。
const PERMISSION_REQUEST_TIMEOUT_SECS: u64 = 300;

/// 挂起的权限请求（B9，Peri agent 实证方向：agent 主动 request_permission，客户端应答）。
#[derive(Clone)]
pub(crate) struct PendingPermission {
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    /// raw_input 脱敏摘要（事件安全字段，不含完整载荷）。
    pub prompt: String,
    /// 可用选项 option_id（allow_once/reject_once/...），应答时校验。
    pub options: Vec<String>,
    /// C4：应答身份复核——解析时记录的 client_generation。客户端替换
    /// （generation 前进）后，旧进程的应答决策不得误写新进程同 id 请求。
    pub client_generation: u64,
    /// R4：Timestamp（事件 payload 序列化为字符串，契约不变）。
    pub requested_at: Timestamp,
}

/// 解析 agent 的 request_permission 请求参数（B9）：
/// `{ sessionId, toolCall: { toolCallId, title?, rawInput? }, options: [{ optionId, ... }] }`。
/// 解析失败（缺字段/无选项）返回 None——调用方按拒绝处理。
/// 兼容入口（仅 lib.rs 测试调用，无 runtime 上下文）：client_generation 置 0——
/// 生产路径（dispatcher）必须走 [`parse_permission_request_with_generation`]。
#[cfg(test)]
pub(crate) fn parse_permission_request(
    params: Option<&serde_json::Value>,
) -> Option<PendingPermission> {
    parse_permission_request_with_generation(params, 0)
}

/// C4：带 client_generation 的解析入口——记录请求到达时的身份 generation，
/// 应答时复核（见 [`respond_permission`]）。
pub(crate) fn parse_permission_request_with_generation(
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
    let prompt: String = runtime_log::sanitize_message(raw_input)
        .chars()
        .take(PERMISSION_PROMPT_MAX_CHARS)
        .collect();
    let options: Vec<String> = params
        .get("options")?
        .as_array()?
        .iter()
        .filter_map(|option| option.get("optionId").and_then(|v| v.as_str()))
        .map(str::to_string)
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
pub(crate) fn permission_response(option_id: &str) -> serde_json::Value {
    use agent_client_protocol_schema::v1::{
        RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome,
    };
    serde_json::to_value(RequestPermissionResponse::new(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id.to_string())),
    ))
    .unwrap_or_else(|_| serde_json::json!({"outcome": {"selected": {"optionId": option_id}}}))
}

/// request_permission 应答：Cancelled（session/cancel 时必须应答所有挂起请求）。
pub(crate) fn permission_response_cancelled() -> serde_json::Value {
    use agent_client_protocol_schema::v1::{RequestPermissionOutcome, RequestPermissionResponse};
    serde_json::to_value(RequestPermissionResponse::new(
        RequestPermissionOutcome::Cancelled,
    ))
    .unwrap_or_else(|_| serde_json::json!({"outcome": "cancelled"}))
}

/// C5：按请求提供选项选择应答 option_id（协议合规）——自动批准/超时默认拒绝不再
/// 硬编码 allow_once/reject_once，而是优先命中语义选项，否则取首个可用项。
/// 语义优先级（忽略大小写）：
/// - prefer_reject（超时默认拒绝）：`reject_once` → 前缀 `reject` → 首个
/// - prefer_reject=false（自动批准）：`allow_once` → 首个
///
/// 无选项返回 None（调用方兜底 reject_once）。
pub(crate) fn pick_option(options: &[String], prefer_reject: bool) -> Option<&str> {
    if prefer_reject {
        options
            .iter()
            .find(|option| option.eq_ignore_ascii_case("reject_once"))
            .or_else(|| options.iter().find(|option| option.starts_with("reject")))
    } else {
        options
            .iter()
            .find(|option| option.eq_ignore_ascii_case("allow_once"))
    }
    .or_else(|| options.first())
    .map(String::as_str)
}

/// 统一权限应答（P1-2 TOCTOU 修复）：acp 锁内复核 pending 再发送。
/// 客户端替换（replace_agent_client）在 acp 锁内清空 pending——若"锁外读 pending
/// → 锁 acp 发送"，替换发生在两者之间时，旧进程的 request_id 会写到新进程。
/// C4：锁内同时复核 pending 记录的 client_generation 与当前一致——客户端替换
/// 瞬间（同 id 请求已由新进程发出）旧审批决策不误写新进程。
/// O9：锁内仅复核（存在 + 身份）+ 取 write_tx 克隆 + claim，锁外发送（10s 超时，
/// 语义对齐 acp::send_line）——不再持 acp 锁 await，避免阻塞其他 ACP 操作。
/// 返回 true = 已应答并移除；false = 请求已不存在/身份不匹配（跳过）或发送失败
/// （恢复 pending 供重试/超时/客户端替换清理）。
pub(crate) async fn respond_permission(
    runtime: &AgentRuntime,
    request_id: u64,
    response: serde_json::Value,
) -> bool {
    // 锁内仅复核 + 取 write_tx 克隆 + claim（O9：发送全部在锁外）。
    let (write_tx, crashed, claimed) = {
        let acp = runtime.acp.lock().await;
        let mut pending = match runtime.pending_permissions.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        let can_respond = pending
            .get(&request_id)
            .map(|permission| {
                permission.client_generation == runtime.client_generation.load(Ordering::Acquire)
            })
            .unwrap_or(false);
        if !can_respond {
            return false;
        }
        (
            acp.write_tx.clone(),
            acp.crashed.clone(),
            pending.remove(&request_id),
        )
    };
    // 锁外发送：信封序列化 + 10s 超时。发送失败恢复 pending（保留可重试）。
    if crashed.load(Ordering::Acquire) {
        // 对齐 acp::send_response：已崩溃连接不再发送
        restore_pending(runtime, request_id, claimed);
        return false;
    }
    let line = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": response,
    });
    let line = match serde_json::to_string(&line) {
        Ok(line) => line,
        Err(_) => {
            restore_pending(runtime, request_id, claimed);
            return false;
        }
    };
    let sent =
        match tokio::time::timeout(std::time::Duration::from_secs(10), write_tx.send(line)).await {
            Ok(Ok(())) => true,
            Ok(Err(_)) => false,
            Err(_) => {
                log::warn!("ACP write timeout after 10s: connection presumed dead");
                crashed.store(true, Ordering::Release);
                false
            }
        };
    if !sent {
        restore_pending(runtime, request_id, claimed);
        return false;
    }
    true
}

/// 发送失败后恢复已 claim 的挂起条目（O9：保留 pending 供重试/超时/客户端替换
/// 清理）。同 id 已有更新条目时保留更新条目（不覆盖新请求）。
fn restore_pending(runtime: &AgentRuntime, request_id: u64, claimed: Option<PendingPermission>) {
    if let Some(permission) = claimed {
        let _ = runtime.pending_permissions.lock().map(|mut pending| {
            pending.entry(request_id).or_insert(permission);
        });
    }
}

/// 应答并移除指定 session 的全部挂起权限请求（Cancelled）——cancel/close 路径调用。
pub(crate) async fn respond_pending_permissions_cancelled(
    runtime: &AgentRuntime,
    session_id: &str,
) {
    let pending: Vec<u64> = runtime
        .pending_permissions
        .lock()
        .map(|pending| {
            pending
                .iter()
                .filter(|(_, p)| p.session_id == session_id)
                .map(|(id, _)| *id)
                .collect()
        })
        .unwrap_or_default();
    for request_id in pending {
        // P1-2：统一走 respond_permission（锁内复核）；发送失败时保留 pending
        // （进程已死则由崩溃处理/客户端替换清理，不向新进程误写）。
        let _ = respond_permission(runtime, request_id, permission_response_cancelled()).await;
    }
}

/// 应答挂起的权限请求（B9.4 契约）：option_id 必须是请求提供的选项之一。
/// 拒绝走同一命令（option_id = "reject_once" 等）。返回 Err = 未找到或选项非法。
/// O36：合并单一临界区——acp 锁内查条目 + 校验选项 + C4 generation 校验 + claim，
/// 锁外发送（O9 同款）；消除"锁读 → 校验 → respond_permission 再锁"两段式重复
/// 锁往返。
pub(crate) async fn resolve_permission(
    runtime: &AgentRuntime,
    request_id: u64,
    option_id: &str,
) -> Result<(), PylonError> {
    let (write_tx, crashed, claimed, tool_call_id, line) = {
        let acp = runtime.acp.lock().await;
        let mut pending = runtime
            .pending_permissions
            .lock()
            .map_err(|e| e.to_string())?;
        let Some(permission) = pending.get(&request_id) else {
            return Err(PylonError::Protocol(format!(
                "permission request not found: {request_id}"
            )));
        };
        if !permission.options.iter().any(|option| option == option_id) {
            return Err(PylonError::Protocol(format!(
                "invalid option {option_id} for request {request_id}"
            )));
        }
        // C4：锁内复核身份——客户端替换（generation 前进）后旧审批决策不误写
        // 新进程同 id 请求。
        if permission.client_generation != runtime.client_generation.load(Ordering::Acquire) {
            return Err(PylonError::Protocol(format!(
                "permission request not found: {request_id}"
            )));
        }
        let tool_call_id = permission.tool_call_id.clone();
        let line = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": permission_response(option_id),
        });
        let line = match serde_json::to_string(&line) {
            Ok(line) => line,
            Err(_) => {
                return Err(PylonError::Protocol(format!(
                    "permission request not found: {request_id}"
                )));
            }
        };
        (
            acp.write_tx.clone(),
            acp.crashed.clone(),
            pending.remove(&request_id),
            tool_call_id,
            line,
        )
    };
    // 锁外发送（O9/O35）：崩溃/超时/通道关闭均失败——恢复 pending 保留可重试。
    if crashed.load(Ordering::Acquire) {
        restore_pending(runtime, request_id, claimed);
        return Err(PylonError::Protocol(format!(
            "permission request not found: {request_id}"
        )));
    }
    let sent =
        match tokio::time::timeout(std::time::Duration::from_secs(10), write_tx.send(line)).await {
            Ok(Ok(())) => true,
            Ok(Err(_)) => false,
            Err(_) => {
                log::warn!("ACP write timeout after 10s: connection presumed dead");
                crashed.store(true, Ordering::Release);
                false
            }
        };
    if !sent {
        restore_pending(runtime, request_id, claimed);
        return Err(PylonError::Protocol(format!(
            "permission request not found: {request_id}"
        )));
    }
    log::info!("权限请求 {request_id} 已应答 {option_id}（{tool_call_id}）");
    Ok(())
}

/// 应答挂起的权限请求（命令入口，跨 runtime 定位）。
#[tauri::command]
pub(crate) async fn approve_tool_call(
    state: tauri::State<'_, AppState>,
    request_id: u64,
    option_id: String,
) -> Result<(), PylonError> {
    for runtime in state.inner().runtimes.all() {
        if resolve_permission(&runtime, request_id, &option_id)
            .await
            .is_ok()
        {
            return Ok(());
        }
    }
    Err(PylonError::Protocol(format!(
        "permission request not found: {request_id}"
    )))
}

/// 设置权限审批模式（B9.3）：bypass/auto 自动批准；edit/default 挂起询问。
#[tauri::command]
pub(crate) async fn set_approval_mode(
    state: tauri::State<'_, AppState>,
    mode: String,
) -> Result<(), PylonError> {
    if !matches!(mode.as_str(), "bypass" | "auto" | "edit" | "default") {
        return Err(PylonError::Protocol(format!(
            "unknown approval mode: {mode}"
        )));
    }
    *state.approval_mode.lock().map_err(|e| e.to_string())? = mode;
    Ok(())
}

/// 挂起的权限请求超时检查（B9.2：超时默认拒绝，不悬挂 pending）。
/// C5：默认拒绝选项按请求提供的选项选择（reject 优先），不再硬编码 reject_once。
/// O37：已崩溃 runtime 的 pending 永久悬挂（写通道已死，任何应答都不可能送达）
/// ——直接清空并 log；多条超时应答 join_all 并行（不再逐条 await 串行）。
pub(crate) async fn check_pending_permission_timeouts(state: &AppState) {
    let now = Timestamp::now();
    for runtime in state.runtimes.all() {
        // O37：已崩溃 runtime 的挂起请求永久无法应答（O9 锁外发送依赖写通道，
        // 崩溃后 send 必失败、restore 后下轮 watcher 重试仍失败）——直接清空。
        let crashed = runtime
            .acp
            .try_lock()
            .map(|acp| acp.is_crashed())
            .unwrap_or(false);
        if crashed {
            let dropped = runtime
                .pending_permissions
                .lock()
                .map(|pending| pending.len())
                .unwrap_or(0);
            if dropped > 0 {
                log::warn!("runtime 已崩溃，清空 {dropped} 条挂起权限请求");
            }
            let _ = runtime
                .pending_permissions
                .lock()
                .map(|mut pending| pending.clear());
            continue;
        }
        let expired: Vec<(u64, String, Vec<String>)> = runtime
            .pending_permissions
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .filter(|(_, permission)| {
                        now.elapsed_since(permission.requested_at)
                            > PERMISSION_REQUEST_TIMEOUT_SECS * 1000
                    })
                    .map(|(id, permission)| {
                        (
                            *id,
                            permission.tool_call_id.clone(),
                            permission.options.clone(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        if expired.is_empty() {
            continue;
        }
        // O37：多条超时应答互不依赖——join_all 并行，避免写通道阻塞时逐条串行
        // 放大整体耗时。P1-2：统一走 respond_permission（锁内复核 + 锁外发送，
        // 防客户端替换竞态）；发送失败恢复 pending，下轮 watcher 重试或客户端
        // 替换清理。超时日志无条件保留（记录本次判定）。
        let responses = expired
            .into_iter()
            .map(|(request_id, tool_call_id, options)| {
                let runtime = runtime.clone();
                let option_id = pick_option(&options, true)
                    .unwrap_or("reject_once")
                    .to_string();
                async move {
                    let _ =
                        respond_permission(&runtime, request_id, permission_response(&option_id))
                            .await;
                    log::warn!("权限请求 {request_id} 超时默认拒绝 {option_id}（{tool_call_id}）");
                }
            });
        futures_util::future::join_all(responses).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::AgentRuntime;

    fn request_params() -> serde_json::Value {
        serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "call-1", "title": "tool"},
            "options": [{"optionId": "allow_once"}, {"optionId": "reject_once"}]
        })
    }

    fn parsed(generation: u64) -> PendingPermission {
        parse_permission_request_with_generation(Some(&request_params()), generation)
            .expect("合法请求必须解析")
    }

    fn opts(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pick_option_reject_prefers_reject_once_then_prefix_then_first() {
        // reject_once 优先（忽略大小写）
        assert_eq!(
            pick_option(&opts(&["allow_once", "REJECT_ONCE"]), true),
            Some("REJECT_ONCE")
        );
        // 无 reject_once 时前缀 reject 优先
        assert_eq!(
            pick_option(&opts(&["allow_once", "reject_forever"]), true),
            Some("reject_forever")
        );
        // 无 reject 语义项时取首个
        assert_eq!(
            pick_option(&opts(&["allow_once", "ask_again"]), true),
            Some("allow_once")
        );
        // 空集无兜底项
        assert_eq!(pick_option(&[], true), None);
    }

    #[test]
    fn pick_option_allow_prefers_allow_once_then_first() {
        assert_eq!(
            pick_option(&opts(&["allow_always", "ALLOW_ONCE"]), false),
            Some("ALLOW_ONCE")
        );
        assert_eq!(
            pick_option(&opts(&["allow_always", "reject_once"]), false),
            Some("allow_always")
        );
        assert_eq!(pick_option(&[], false), None);
    }

    /// fake ACP：把收到的请求行追加写入 trace 文件并逐个应答（writer 不阻塞）。
    fn trace_script(trace_path: &std::path::Path) -> String {
        format!(
            r#"import json,sys
with open({trace:?}, 'a') as f:
    for line in sys.stdin:
        request = json.loads(line)
        f.write(line)
        f.flush()
        print(json.dumps({{'jsonrpc':'2.0','id':request.get('id'),'result':{{}}}}), flush=True)
"#,
            trace = trace_path.to_string_lossy()
        )
    }

    #[tokio::test]
    async fn respond_permission_rejects_stale_generation() {
        let runtime = AgentRuntime::new_disconnected();
        // 客户端替换场景：pending 记录的是旧 generation（1），当前 generation 为 0
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(7, parsed(1));
        assert!(
            !respond_permission(&runtime, 7, permission_response("allow_once")).await,
            "generation 不匹配必须拒绝应答"
        );
        assert!(
            runtime.pending_permissions.lock().unwrap().contains_key(&7),
            "拒绝应答后 pending 保留（由客户端替换清理）"
        );
    }

    #[tokio::test]
    async fn respond_permission_stale_generation_never_reaches_client() {
        let trace_path = std::env::temp_dir().join(format!(
            "prism_perm_stale_{}_{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&trace_path);
        let agent = crate::test_utils::fake_acp_agent("fake-acp-perm", &trace_script(&trace_path));
        let acp = crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP 必须初始化");
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = acp;

        // 旧 generation（1）的挂起：不匹配 → 不应答且不发送
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(7, parsed(1));
        assert!(
            !respond_permission(&runtime, 7, permission_response("allow_once")).await,
            "stale generation 必须拒绝"
        );
        assert!(runtime.pending_permissions.lock().unwrap().contains_key(&7));

        // 当前 generation（0）的挂起：匹配 → 应答发送成功并清理
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(8, parsed(0));
        assert!(
            respond_permission(&runtime, 8, permission_response("allow_once")).await,
            "匹配 generation 必须应答"
        );
        assert!(!runtime.pending_permissions.lock().unwrap().contains_key(&8));

        // 等 fake ACP 把请求写入 trace 后回读断言（serde_json 紧凑序列化："id":8）
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if std::fs::read_to_string(&trace_path)
                    .map(|trace| trace.contains("\"id\":8"))
                    .unwrap_or(false)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("匹配 generation 的应答必须到达客户端");
        let trace = std::fs::read_to_string(&trace_path).unwrap_or_default();
        assert!(
            !trace.contains("\"id\":7"),
            "stale generation 应答不得写入新进程: {trace}"
        );

        let _ = runtime.acp.lock().await.kill();
        let _ = std::fs::remove_file(&trace_path);
    }
}
