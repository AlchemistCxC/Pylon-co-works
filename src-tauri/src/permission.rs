//! B9 权限审批：挂起请求解析/应答/超时（R1 拆分自 lib.rs；行为零变化）。

use std::sync::atomic::Ordering;
use std::sync::Arc;

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

/// 锁外应答发送共享 helper（G3 §2.2.2）：构造 {jsonrpc,id,result} 信封 → 序列化 →
/// 超时发送（方案 2B：超时值与 acp::DEFAULT_WRITE_TIMEOUT_SECS 单一来源）→
/// 超时置 crashed（语义对齐 acp::send_line）。
/// 收敛 dispatcher::send_direct_permission_response 与 resolve_pending 的锁外发送段
/// （三份同形拷贝 → 一份）；调用方（resolve_pending）在返回 false 时恢复 pending。
pub(crate) async fn send_agent_response(
    write_tx: tokio::sync::mpsc::Sender<String>,
    crashed: Arc<std::sync::atomic::AtomicBool>,
    request_id: u64,
    result: serde_json::Value,
) -> bool {
    if crashed.load(Ordering::Acquire) {
        return false; // 已崩溃不发送（原两处同语义）
    }
    let line = serde_json::json!({ "jsonrpc": "2.0", "id": request_id, "result": result });
    let Ok(line) = serde_json::to_string(&line) else {
        return false;
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(crate::acp::DEFAULT_WRITE_TIMEOUT_SECS),
        write_tx.send(line),
    )
    .await
    {
        Ok(Ok(())) => true,
        Ok(Err(_)) => false,
        Err(_) => {
            tracing::warn!(
                "ACP write timeout after {}s: connection presumed dead",
                crate::acp::DEFAULT_WRITE_TIMEOUT_SECS
            );
            crashed.store(true, Ordering::Release);
            false
        }
    }
}

/// R34：四路应答统一核心（由 respond_permission 演进——四路：应答 / cancel /
/// resolve / 超时 全部收敛于此，单一临界区 + 锁外发送）。
///
/// 单临界区（P1-2 TOCTOU 修复）：acp 锁内查条目 + C4 generation 校验 +
/// tool_call_id 校验 + 选项校验 + claim；锁外发送（O9：10s 超时，语义对齐
/// acp::send_line），不再持 acp 锁 await。客户端替换（replace_agent_client）
/// 在 acp 锁内清空 pending——复核与 claim 同锁，替换瞬间旧审批决策不会写到
/// 新进程同 id 请求。
///
/// 参数：
/// - `expected_tool_call_id`：Some 时要求条目 tool_call_id 一致（cancel 路径按
///   收集时的原 id 校验，防同 id 被新工具调用复用后误 cancel）。
/// - `option_id`：空串 = Cancelled 应答（cancel/close 路径，无选项概念）；
///   非空必须 ∈ 条目的 options（C5 选项契约）。
///
/// 返回 true = 已应答并移除；false = 任一校验失败（跳过）或发送失败
/// （恢复 pending 供重试/超时/客户端替换清理）。
async fn resolve_pending(
    runtime: &AgentRuntime,
    request_id: u64,
    expected_tool_call_id: Option<&str>,
    option_id: &str,
) -> bool {
    // 锁内复核 + 取 write_tx 克隆 + claim（发送全部在锁外）。
    let (write_tx, crashed, claimed) = {
        let acp = runtime.acp.lock().await;
        let mut pending = match runtime.pending_permissions.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        let Some(permission) = pending.get(&request_id) else {
            return false;
        };
        // C4：身份复核——客户端替换（generation 前进）后不误写新进程同 id 请求。
        if permission.client_generation != runtime.client_generation.load(Ordering::Acquire) {
            return false;
        }
        // tool_call_id 复核（cancel 路径用）。
        if let Some(expected) = expected_tool_call_id {
            if permission.tool_call_id != expected {
                return false;
            }
        }
        // C5 选项契约：空 option_id = Cancelled；非空必须 ∈ options。
        if !option_id.is_empty() && !permission.options.iter().any(|option| option == option_id) {
            return false;
        }
        (
            acp.write_tx.clone(),
            acp.crashed.clone(),
            pending.remove(&request_id),
        )
    };
    // 锁外发送（G3 §2.2.2 收敛）：构造应答 → send_agent_response（信封 + 序列化 +
    // 10s 超时 + crashed 预检/置位）。失败恢复 pending（保留可重试）；原 :190-194
    // 的 crashed 预检分支自然落入 helper 返回 false → restore，行为一致。
    let outcome = if option_id.is_empty() {
        permission_response_cancelled()
    } else {
        permission_response(option_id)
    };
    if !send_agent_response(write_tx, crashed, request_id, outcome).await {
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
    let pending: Vec<(u64, String)> = runtime
        .pending_permissions
        .lock()
        .map(|pending| {
            pending
                .iter()
                .filter(|(_, p)| p.session_id == session_id)
                .map(|(id, p)| (*id, p.tool_call_id.clone()))
                .collect()
        })
        .unwrap_or_default();
    for (request_id, tool_call_id) in pending {
        // R34：统一走 resolve_pending（锁内复核身份 + tool_call_id，锁外发送）；
        // 空 option_id = Cancelled 应答。校验/发送失败时保留 pending（进程已死
        // 则由崩溃处理/客户端替换清理，不向新进程误写）。
        let _ = resolve_pending(runtime, request_id, Some(&tool_call_id), "").await;
    }
}

/// 应答挂起的权限请求（B9.4 契约）：option_id 必须是请求提供的选项之一。
/// 拒绝走同一命令（option_id = "reject_once" 等）。返回 Err = 未找到/选项非法/
/// 身份不匹配（C4）/发送失败。
/// R34：统一收敛到 resolve_pending——单一临界区（锁内查条目 + 校验选项 +
/// C4 generation 校验 + claim）+ 锁外发送（O9/O36 合并落点）。
pub(crate) async fn resolve_permission(
    runtime: &AgentRuntime,
    request_id: u64,
    option_id: &str,
) -> Result<(), PylonError> {
    if !resolve_pending(runtime, request_id, None, option_id).await {
        return Err(PylonError::Protocol(format!(
            "permission request not found: {request_id}"
        )));
    }
    tracing::info!("权限请求 {request_id} 已应答 {option_id}");
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
                tracing::warn!("runtime 已崩溃，清空 {dropped} 条挂起权限请求");
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
        // 放大整体耗时。R34：统一走 resolve_pending（锁内复核 + 锁外发送，
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
                    let _ = resolve_pending(&runtime, request_id, None, &option_id).await;
                    tracing::warn!(
                        "权限请求 {request_id} 超时默认拒绝 {option_id}（{tool_call_id}）"
                    );
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
            !resolve_pending(&runtime, 7, None, "allow_once").await,
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
            !resolve_pending(&runtime, 7, None, "allow_once").await,
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
            resolve_pending(&runtime, 8, None, "allow_once").await,
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

        // R34：Cancelled 应答（空 option_id）——匹配身份 + tool_call_id 则发送
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(9, parsed(0));
        assert!(
            resolve_pending(&runtime, 9, Some("call-1"), "").await,
            "匹配的 cancel 必须应答"
        );
        // tool_call_id 不匹配（同 id 已被复用为其他工具调用）→ 拒绝应答且不发送
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(10, parsed(0));
        assert!(
            !resolve_pending(&runtime, 10, Some("other-call"), "").await,
            "tool_call_id 不匹配必须拒绝"
        );
        assert!(runtime
            .pending_permissions
            .lock()
            .unwrap()
            .contains_key(&10));
        // 等 cancel 应答写入 trace 后回读断言
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if std::fs::read_to_string(&trace_path)
                    .map(|trace| trace.contains("\"id\":9"))
                    .unwrap_or(false)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cancel 应答必须到达客户端");
        let trace = std::fs::read_to_string(&trace_path).unwrap_or_default();
        assert!(
            trace.contains("\"outcome\":\"cancelled\""),
            "cancel 应答必须是 Cancelled 形状: {trace}"
        );
        assert!(
            !trace.contains("\"id\":7"),
            "stale generation 应答不得写入新进程: {trace}"
        );
        assert!(
            !trace.contains("\"id\":10"),
            "tool_call_id 不匹配的应答不得发送: {trace}"
        );

        let _ = runtime.acp.lock().await.kill();
        let _ = std::fs::remove_file(&trace_path);
    }
}
