//! OBS-03：P1 现场失败复现与证据包（方案书 §5.3 六类 case 矩阵）。
//!
//! 证据来源编号（§5.3 现场证据要求）：
//!   1. Pylon → Agent stdin：fake ACP 把收到的每行请求写入 trace 文件（本模块回读）。
//!   2. Agent → Pylon stdout：`AcpWireHub::snapshot()`（OBS-01 只读记录器，u64 窄化**前**原文）。
//!   3. Tauri event payload：mock window `listen` 捕获 `pylon:interaction`。
//!   4. 前端 invoke payload/reject：真实 app 专属（mock window 无前端）——本模块无法采集，
//!      判"证据不全→只能判局部链路"时如实标注（OBS-03 报告登记为缺口）。
//!   5. Rust runtime log：`RuntimeLogHub::list()`。dispatcher 的 tracing 事件经
//!      `tracing::dispatcher::set_default(RuntimeLogLayer)` 在 dispatcher spawn 作用域注入
//!      （current-thread runtime 下 dispatcher 任务与测试同线程轮询，守卫存续期间命中；
//!      生产路径由 run() 的 init_tracing() 全局注入，语义一致）。
//!   6. Agent stderr：fake ACP 写 stderr → `spawn_stderr_reader` → hub（source="agent-stderr"）。
//!
//! Case 矩阵（§5.3）：
//!   A fake/number id/allow_once+deny/default → 前端 interaction + response id/value 一致。
//!   B fake/string id/allow_once+deny/default → string id 挂起并 round-trip，response id 回显
//!     原始 string 变体（ACP-01 §5.4 RequestId 类型化——修复 OBS-03 P1 静默丢弃）。
//!   E fake/string id/无效 params/default → normalize 失败 = protocol error，按
//!     ACP 标准发 JSON-RPC error（-32602），**不再伪造 reject_once**（OBS-03-E
//!     finding 由 ACP-04 §5.6 修复；id 回显原始 string 变体）。
//!   E2 补充（number id + 无效 params）→ 同 E：JSON-RPC error 应答，number id 回显
//!     原始形态——§5.6"解析失败不属于可 approve/reject 的 pending permission"证据。
//!   F fake/number id/pending/cancel → 挂起 → cancel_prompt → Cancelled 收敛；核查 wire
//!      是否出现 session/cancel（期望见 §5.3 矩阵）。
//!   C/D（Hermes 真机）→ 本会话已完成真机探针验证（独立 python 探针直连 `hermes acp`，
//!      HERMES_HOME=profile-a profile，见 OBS-03 报告附录），结果如实登记于下方：
//!      C（Hermes/number/default→deny）已证实：wire 收到 `session/request_permission`
//!        id=0（**number 形态**，acp python 库 `send_request` 用 `_next_request_id` int 递增），
//!        params=[options, sessionId, toolCall]，options kinds=[allow_once, reject_once]；
//!        回写 deny 后 Hermes 尊重拒绝——目标文件未创建、prompt 以 end_turn 正常收敛。
//!      D（Hermes/number/auto→allow_once）局部链路：allow_once 应答被接受（审批层
//!        round-trip 完成），但随后 Hermes write_file 工具执行挂起（stderr 止于
//!        "Creating new local environment for task default..."，无 tool result、无 prompt
//!        结果、文件未落盘）——登记为 finding OBS-03-F2（Hermes 侧 quiet_mode 工具执行
//!        未收敛，非 Pylon 侧问题；Pylon allow_once 应答路径由 case A 已证）。另登记
//!        OBS-03-F3：active profile(profile-x) prompt 无有效产出（疑似 provider 401，与
//!        agents.yaml 注释一致），profile-a profile 正常——佐证 `hermes_profile: profile-a`。
//!      证据源 #4（前端 invoke payload/reject）在真机探针同样缺失 → C/D 判"局部链路"，
//!       报告如实标注。
//!
//! 纪律：本模块只复现/取证，不改生产行为；任何与矩阵预期不符的观察登记为 finding，
//! 由 OBS-03 报告与 LRP 台账消化，不在此处修复。

use super::*;

use crate::acp::AcpClient;
use crate::acp::{AcpWireHub, WireIdKind, WireRecord};
use crate::agent_config::AgentDef;
use crate::permission::resolve_permission;
use crate::runtime_log::{RuntimeLogHub, RuntimeLogLayer, RuntimeLogQuery};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::Listener;
use tracing_subscriber::layer::Layer as _;

/// fake ACP 脚本：initialize 应答后发一条 request_permission（id 形态/params 由参数嵌入），
/// 此后把收到的每一行 stdin 请求写入 trace 文件；stderr 输出标记行（证据源 #6）。
/// `id_expr`：number 用 `5`；string 用 `'perm-b'`（python 字面量）。
fn permission_script(id_expr: &str, params: &str) -> String {
    format!(
        r#"import json,sys,time
trace=open(sys.argv[1],'w',encoding='utf-8')
def emit(obj):
    print(json.dumps(obj), flush=True)
sys.stderr.write('obs03-fake-acp-stderr-marker\n')
sys.stderr.flush()
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        emit({{'jsonrpc':'2.0','id':request.get('id'),'result':{{}}}})
        time.sleep(0.3)
        emit({{'jsonrpc':'2.0','id':{id_expr},'method':'session/request_permission','params':{params}}})
    else:
        trace.write(line)
        trace.flush()
"#
    )
}

/// 合法 params：options = allow_once（allowOnce）+ deny（rejectOnce），矩阵 A/B/C/D 形态。
fn valid_params(session: &str, tool_call_id: &str) -> String {
    serde_json::json!({
        "sessionId": session,
        "toolCall": {
            "toolCallId": tool_call_id,
            "title": "edit_file",
            "rawInput": "obs03-secret-marker"
        },
        "options": [
            {"optionId": "allow_once", "name": "Allow once", "kind": "allowOnce"},
            {"optionId": "deny", "name": "Deny", "kind": "rejectOnce"}
        ]
    })
    .to_string()
}

/// 无效 params：缺 options（normalize_request 必须解析失败）。
fn invalid_params(session: &str) -> String {
    serde_json::json!({
        "sessionId": session,
        "toolCall": {"toolCallId": "call-invalid"}
    })
    .to_string()
}

/// 构造 fake ACP agent（provider=peri 注册协议适配器；trace 路径进 argv[1]）。
fn fake_permission_agent(name: &str, script: &str, trace_path: &Path) -> AgentDef {
    let mut agent = crate::test_utils::fake_acp_agent_with(
        name,
        script,
        vec![trace_path.to_string_lossy().into_owned()],
        HashMap::new(),
    );
    agent.provider = Some("peri".to_string());
    agent
}

/// state 构造：注入已连接的 AcpClient + 共享 RuntimeLogHub（stderr 证据源 #6 同 hub）。
/// 镜像 test_state_with_acp 的协议适配器注册（单测进程不执行 run()，provider 分派必需）。
async fn build_state_with_logs(
    agent: AgentDef,
    initial_acp: AcpClient,
    logs: Arc<RuntimeLogHub>,
) -> AppState {
    crate::protocol_adapter::register_protocol_adapter(std::sync::Arc::new(
        crate::protocol_adapter::RequestPermissionAdapter { provider: "peri" },
    ));
    crate::protocol_adapter::register_protocol_adapter(std::sync::Arc::new(
        crate::protocol_adapter::RequestPermissionAdapter { provider: "hermes" },
    ));
    let runtime = AgentRuntime::new_disconnected();
    *runtime.acp.lock().await = initial_acp;
    let mut state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent.clone())
        .with_runtime(agent.name.clone(), runtime)
        .with_active_agent(agent.name)
        .with_gateway(Arc::new(crate::gateway::GatewayCore::new()))
        .with_prism(crate::prism::PrismClient::unavailable("test".to_string()))
        .build();
    state.runtime_logs = logs.clone();
    state
}

/// mock app + 主窗口（state 已 manage；事件经 Emitter 由 listen 捕获）。
fn mock_app_with(
    state: AppState,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(state);
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .build()
    .expect("mock window must build");
    (app, window)
}

/// 注册事件监听（证据源 #3）：捕获 window.emit 的 payload（Listener 事件 payload 为
/// 原始 JSON 字符串，需反序列化）。
fn capture_events<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    event: &str,
) -> std::sync::mpsc::Receiver<serde_json::Value> {
    let (tx, rx) = std::sync::mpsc::channel();
    window.listen(event, move |e| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(e.payload()) {
            let _ = tx.send(payload);
        }
    });
    rx
}

/// 证据源 #5 注入：把 tracing 事件转发进 hub（守卫存续期间，dispatcher 任务
/// 在 current-thread runtime 与测试同线程轮询即命中）。
fn install_log_layer(logs: &Arc<RuntimeLogHub>) -> tracing::dispatcher::DefaultGuard {
    let dispatch = tracing::Dispatch::new(
        RuntimeLogLayer::with_hub(logs.clone()).with_subscriber(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .finish(),
        ),
    );
    tracing::dispatcher::set_default(&dispatch)
}

/// 等待 dispatcher 挂起指定 id 的权限请求。
async fn wait_pending(runtime: &Arc<AgentRuntime>, id: u64, timeout: Duration) {
    tokio::time::timeout(timeout, async {
        loop {
            if runtime
                .pending_permissions
                .lock()
                .unwrap()
                .contains_key(&crate::acp::RequestId::Number(id))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("dispatcher 必须挂起 request_permission");
}

/// 等待 trace 中出现带 id 的应答并返回全部行（证据源 #1）。
async fn wait_for_trace_response(path: &PathBuf, timeout: Duration) -> Vec<serde_json::Value> {
    tokio::time::timeout(timeout, async {
        loop {
            let lines = trace_lines(path);
            if lines.iter().any(|line| line.get("id").is_some()) {
                return lines;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("trace 必须收到应答")
}

fn trace_lines(path: &PathBuf) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// 证据源 #2：wire 记录中本连接的 request_permission 报文（窄化前原文）。
fn request_permission_records(wire: &AcpWireHub) -> Vec<WireRecord> {
    wire.snapshot()
        .into_iter()
        .filter(|record| {
            record.method.as_deref() == Some(crate::acp::METHOD_SESSION_REQUEST_PERMISSION)
        })
        .collect()
}

/// 证据源 #5：按 message 包含 needle 检索 hub 日志。
fn entries_with_message(
    hub: &RuntimeLogHub,
    needle: &str,
) -> Vec<crate::runtime_log::RuntimeLogEntry> {
    hub.list(&RuntimeLogQuery {
        level: None,
        source: None,
        session: None,
        search: Some(needle.to_string()),
        limit: None,
    })
}

fn temp_trace(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("pylon-obs03-{label}-{}.jsonl", std::process::id()))
}

// ── Case A：fake ACP / number id / allow_once+deny / default ────────────────────────────
// 预期：前端出现 interaction，response id/value 保持一致（§5.3 矩阵）。

#[tokio::test]
async fn case_a_number_id_pends_and_resolves_with_consistent_id_value() {
    let logs = RuntimeLogHub::new(128);
    let trace_path = temp_trace("case-a");
    let script = permission_script("5", &valid_params("fake-session-a", "call-a"));
    let agent = fake_permission_agent("obs03-a", &script, &trace_path);
    let initial_acp = AcpClient::connect_with_logs(&agent, Some(logs.clone()))
        .await
        .expect("fake ACP must initialize");
    let wire_trace = initial_acp
        .wire_trace()
        .expect("connected client must have wire trace");
    let state = build_state_with_logs(agent, initial_acp, logs.clone()).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("runtime");
    let (app, window) = mock_app_with(state);
    let events = capture_events(&window, crate::event_names::INTERACTION);
    let _guard = install_log_layer(&logs);
    start_notification_dispatcher(&handles, &runtime, window);

    wait_pending(&runtime, 5, Duration::from_secs(5)).await;

    // 证据 #3：interaction 事件出现，requestId/options/身份 完整。
    let event = events
        .recv_timeout(Duration::from_secs(2))
        .expect("必须发出 interaction 事件");
    assert_eq!(event["eventType"], "permission.request");
    assert_eq!(event["requestId"], "5");
    assert_eq!(event["provider"], "peri");
    assert_eq!(event["agentId"], "obs03-a");
    assert_eq!(event["sessionId"], "fake-session-a");
    assert_eq!(event["toolCallId"], "call-a");
    assert_eq!(event["clientGeneration"], 0);
    assert_eq!(event["payload"]["options"][0]["optionId"], "allow_once");
    assert_eq!(event["payload"]["options"][1]["optionId"], "deny");
    // 证据 #3（ACP-03 §5.6）：deadline 由后端单一来源（PERMISSION_REQUEST_TIMEOUT_SECS）——
    // deadlineMs = requestedAt + 300s，前端只做倒计时展示，不自行持有超时常量。
    let requested_at_ms = event["payload"]["requestedAt"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .expect("requestedAt 必须为时间戳字符串");
    let deadline_ms = event["payload"]["deadlineMs"]
        .as_u64()
        .expect("deadlineMs 必须存在（后端单一来源）");
    assert_eq!(
        deadline_ms - requested_at_ms,
        300_000,
        "deadlineMs 必须等于 requestedAt + 300s"
    );
    // 证据 #2：wire 记录保留 number id（窄化前原文）。
    let records = request_permission_records(&wire_trace);
    assert_eq!(records.len(), 1, "request_permission 必须已记录");
    assert_eq!(records[0].id_kind, WireIdKind::Number);
    assert_eq!(records[0].id_value, Some(serde_json::json!(5)));
    // 证据 #6：stderr 事件已入 hub（content 仅落 tracing 输出；hub 记录 source=agent-stderr——
    // 与 OBS-07 目标一致，本报告如实标注）。
    let stderr_entries = logs.list(&RuntimeLogQuery {
        source: Some("agent-stderr".to_string()),
        ..RuntimeLogQuery::default()
    });
    assert!(
        !stderr_entries.is_empty(),
        "stderr 证据（source=agent-stderr）必须可采集"
    );

    // 应答 allow_once（前端 approve 等价路径）。
    resolve_permission(&runtime, crate::acp::RequestId::Number(5), "allow_once")
        .await
        .expect("resolve must succeed");

    // 证据 #1：stdin trace 收到 response，id/value 与请求一致。
    let lines = wait_for_trace_response(&trace_path, Duration::from_secs(5)).await;
    let response = lines
        .iter()
        .find(|line| line.get("id") == Some(&serde_json::json!(5)))
        .expect("response id 必须保持 5");
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["result"]["outcome"]["outcome"], "selected");
    assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");
    // 证据 #5：已应答日志（resolve 在测试线程，守卫命中）。
    assert!(
        !entries_with_message(&logs, "权限请求 5 已应答 allow_once").is_empty(),
        "runtime log 必须记录应答"
    );

    let _ = std::fs::remove_file(&trace_path);
    drop(app);
}

// ── Case B：fake ACP / string id / allow_once+deny / default ───────────────────────────
// 预期：与 Case A 同语义（§5.3）——ACP-01（§5.4）使 string id 成为一等公民：
// 挂起 RequestId::String 键、发出 interaction 事件、应答后 id 回显原始 string 变体。

#[tokio::test]
async fn case_b_string_id_round_trip_echoes_original_variant() {
    let logs = RuntimeLogHub::new(128);
    let trace_path = temp_trace("case-b");
    let script = permission_script("'perm-b'", &valid_params("fake-session-b", "call-b"));
    let agent = fake_permission_agent("obs03-b", &script, &trace_path);
    let initial_acp = AcpClient::connect_with_logs(&agent, Some(logs.clone()))
        .await
        .expect("fake ACP must initialize");
    let wire_trace = initial_acp
        .wire_trace()
        .expect("connected client must have wire trace");
    let state = build_state_with_logs(agent, initial_acp, logs.clone()).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("runtime");
    let (app, window) = mock_app_with(state);
    let events = capture_events(&window, crate::event_names::INTERACTION);
    let _guard = install_log_layer(&logs);
    start_notification_dispatcher(&handles, &runtime, window);

    // 证据 #2：string id 的 request_permission 被 wire 记录（窄化前原文保留）。
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !request_permission_records(&wire_trace).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("string id 请求必须被 wire 记录");
    let records = request_permission_records(&wire_trace);
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].id_kind,
        WireIdKind::String,
        "wire 记录必须保留 string id 形态"
    );
    assert_eq!(records[0].id_value, Some(serde_json::json!("perm-b")));
    assert_eq!(records[0].request_id.as_deref(), Some("perm-b"));

    // 证据 #1'：ACP-01 §5.4——string id 不再被 A3 丢弃，必须挂起为 RequestId::String 键。
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if runtime
                .pending_permissions
                .lock()
                .unwrap()
                .contains_key(&crate::acp::RequestId::String("perm-b".to_string()))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("string id 请求必须挂起 pending");

    // 证据 #3：interaction 事件出现，requestId 回显原始 string 变体。
    let event = events
        .recv_timeout(Duration::from_secs(2))
        .expect("必须发出 interaction 事件");
    assert_eq!(event["eventType"], "permission.request");
    assert_eq!(event["requestId"], "perm-b");
    assert_eq!(event["provider"], "peri");
    assert_eq!(event["agentId"], "obs03-b");
    assert_eq!(event["sessionId"], "fake-session-b");
    assert_eq!(event["toolCallId"], "call-b");
    assert_eq!(event["payload"]["options"][0]["optionId"], "allow_once");
    assert_eq!(event["payload"]["options"][1]["optionId"], "deny");

    // 应答 allow_once（前端 approve 等价路径）——以 RequestId::String 键 resolve。
    resolve_permission(
        &runtime,
        crate::acp::RequestId::String("perm-b".to_string()),
        "allow_once",
    )
    .await
    .expect("resolve must succeed");

    // 证据 #1：stdin trace 收到 response，id 回显原始 string 变体 "perm-b"。
    let lines = wait_for_trace_response(&trace_path, Duration::from_secs(5)).await;
    let response = lines
        .iter()
        .find(|line| line.get("id") == Some(&serde_json::json!("perm-b")))
        .expect("response id 必须保持 perm-b");
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["result"]["outcome"]["outcome"], "selected");
    assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");
    // 证据 #5：已应答日志（id 以原始 string 变体记录）。
    assert!(
        !entries_with_message(&logs, "权限请求 perm-b 已应答 allow_once").is_empty(),
        "runtime log 必须记录应答"
    );
    // ACP-01：旧 A3 丢弃 warn 必须消失（string id 已是一等公民）。
    assert!(
        entries_with_message(&logs, "无数字 id 的 request_permission").is_empty(),
        "string id 必须不再触发旧 A3 丢弃 warn"
    );

    let _ = std::fs::remove_file(&trace_path);
    drop(app);
}

// ── Case E：fake ACP / string id / 无效 params / default ───────────────────────────────
// 预期：与 E2 同语义（§5.3）——ACP-01（§5.4）使 string id 与 number id 行为收敛：
// normalize 失败 = protocol error，JSON-RPC error 应答（-32602），id 回显原始 string 变体。
// CR-102（ACP-04 复审）：改名体现 JSON-RPC error 语义（不再"falls back to reject_once"——
// ACP-04 §5.6 已消除伪造 optionId 路径）。

#[tokio::test]
async fn case_e_string_id_invalid_params_answers_jsonrpc_error() {
    let logs = RuntimeLogHub::new(128);
    let trace_path = temp_trace("case-e");
    let script = permission_script("'perm-e'", &invalid_params("fake-session-e"));
    let agent = fake_permission_agent("obs03-e", &script, &trace_path);
    let initial_acp = AcpClient::connect_with_logs(&agent, Some(logs.clone()))
        .await
        .expect("fake ACP must initialize");
    let wire_trace = initial_acp
        .wire_trace()
        .expect("connected client must have wire trace");
    let state = build_state_with_logs(agent, initial_acp, logs.clone()).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("runtime");
    let (app, window) = mock_app_with(state);
    let events = capture_events(&window, crate::event_names::INTERACTION);
    let _guard = install_log_layer(&logs);
    start_notification_dispatcher(&handles, &runtime, window);

    // 证据 #2：string id 的 request_permission 被 wire 记录（窄化前原文保留）。
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !request_permission_records(&wire_trace).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("string id 请求必须被 wire 记录");
    let records = request_permission_records(&wire_trace);
    assert_eq!(records[0].id_kind, WireIdKind::String);
    assert_eq!(records[0].id_value, Some(serde_json::json!("perm-e")));

    // 证据 #5：解析失败 = protocol error（ACP-04 §5.6）——不伪造 optionId。
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !entries_with_message(&logs, "ACP request_permission 解析失败").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("normalize 失败必须产生 runtime log");
    // 证据 #3：解析失败不挂起、不发事件。
    assert!(
        events.recv_timeout(Duration::from_millis(500)).is_err(),
        "解析失败不得触发 interaction 事件"
    );
    assert!(
        runtime.pending_permissions.lock().unwrap().is_empty(),
        "解析失败不得产生 pending"
    );
    // 证据 #1（ACP-04）：JSON-RPC error 信封应答（-32602 Invalid params），id 回显
    // 原始 string 变体 "perm-e"；**无 result/outcome、无伪造 optionId**（OBS-03-E
    // finding 已修复）。
    let lines = wait_for_trace_response(&trace_path, Duration::from_secs(5)).await;
    let response = lines
        .iter()
        .find(|line| line.get("id") == Some(&serde_json::json!("perm-e")))
        .expect("response id 必须保持 perm-e");
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(
        response["error"]["code"], -32602,
        "解析失败必须按 JSON-RPC error 应答（不伪造 optionId）"
    );
    assert!(
        response.get("result").is_none(),
        "解析失败不得携带 result/outcome"
    );
    assert!(
        response["error"]["message"].as_str().is_some(),
        "error message 必须存在"
    );

    let _ = std::fs::remove_file(&trace_path);
    drop(app);
}

/// E2 补充：number id + 无效 params → normalize 失败 = protocol error，按 JSON-RPC
/// error（-32602）应答，不伪造 optionId（ACP-04 §5.6 修复 OBS-03-E2 finding）。
/// CR-102（ACP-04 复审）：改名体现 JSON-RPC error 语义（不再"falls back to reject_once"）。
#[tokio::test]
async fn case_e2_number_id_invalid_params_answers_jsonrpc_error() {
    let logs = RuntimeLogHub::new(128);
    let trace_path = temp_trace("case-e2");
    let script = permission_script("9", &invalid_params("fake-session-e2"));
    let agent = fake_permission_agent("obs03-e2", &script, &trace_path);
    let initial_acp = AcpClient::connect_with_logs(&agent, Some(logs.clone()))
        .await
        .expect("fake ACP must initialize");
    let state = build_state_with_logs(agent, initial_acp, logs.clone()).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("runtime");
    let (app, window) = mock_app_with(state);
    let events = capture_events(&window, crate::event_names::INTERACTION);
    let _guard = install_log_layer(&logs);
    start_notification_dispatcher(&handles, &runtime, window);

    // 证据 #5：解析失败 = protocol error（number id 与 string id 语义一致）。
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !entries_with_message(&logs, "ACP request_permission 解析失败").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("normalize 失败必须产生 runtime log");
    // 证据 #3：解析失败不挂起、不发事件。
    assert!(
        events.recv_timeout(Duration::from_millis(500)).is_err(),
        "解析失败不得触发 interaction 事件"
    );
    assert!(
        runtime.pending_permissions.lock().unwrap().is_empty(),
        "解析失败不得产生 pending"
    );
    // 证据 #1（ACP-04）：JSON-RPC error 应答（number id 回显原始形态），无伪造 optionId。
    let lines = wait_for_trace_response(&trace_path, Duration::from_secs(5)).await;
    let response = lines
        .iter()
        .find(|line| line.get("id") == Some(&serde_json::json!(9)))
        .expect("response id 必须保持 9");
    // ACP-04：JSON-RPC error 应答（-32602），number id 回显原始形态；无伪造 optionId。
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(
        response["error"]["code"], -32602,
        "解析失败必须按 JSON-RPC error 应答（不伪造 optionId）"
    );
    assert!(
        response.get("result").is_none(),
        "解析失败不得携带 result/outcome"
    );

    let _ = std::fs::remove_file(&trace_path);
    drop(app);
}

// ── Case F：fake ACP / number id / pending / cancel ────────────────────────────────────
// 预期：wire 出现 session/cancel，permission 以 Cancelled 收敛（§5.3 矩阵）。
// 前端 cancel 路径 = cancel_prompt 命令（session/control.rs）。

#[tokio::test]
async fn case_f_number_id_pending_cancel_converges_to_cancelled() {
    let logs = RuntimeLogHub::new(128);
    let trace_path = temp_trace("case-f");
    let script = permission_script("7", &valid_params("fake-session-f", "call-f"));
    let agent = fake_permission_agent("obs03-f", &script, &trace_path);
    let initial_acp = AcpClient::connect_with_logs(&agent, Some(logs.clone()))
        .await
        .expect("fake ACP must initialize");
    let wire_trace = initial_acp
        .wire_trace()
        .expect("connected client must have wire trace");
    let state = build_state_with_logs(agent, initial_acp, logs.clone()).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("runtime");
    let (app, window) = mock_app_with(state);
    let events = capture_events(&window, crate::event_names::INTERACTION);
    let _guard = install_log_layer(&logs);
    start_notification_dispatcher(&handles, &runtime, window);

    // 挂起（session 映射源 source-f ↔ peri_id fake-session-f，cancel_prompt 依赖）。
    wait_pending(&runtime, 7, Duration::from_secs(5)).await;
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        sessions.insert(
            "source-f".to_string(),
            SessionInfo::new(
                "fake-session-f".into(),
                "persona".into(),
                ".".into(),
                true,
                0,
            ),
        );
    }
    // 证据 #3：interaction 事件（挂起时前端可展示）。
    let event = events
        .recv_timeout(Duration::from_secs(2))
        .expect("必须发出 interaction 事件");
    assert_eq!(event["requestId"], "7");

    // 前端 cancel 路径：cancel_prompt(agentId="obs03-f", source-f)。OWNER-02：显式 agentId。
    crate::session::cancel_prompt(
        app.state::<AppState>(),
        "obs03-f".to_string(),
        "source-f".to_string(),
    )
    .await
    .expect("cancel_prompt 必须成功");
    assert!(
        !runtime
            .pending_permissions
            .lock()
            .unwrap()
            .contains_key(&crate::acp::RequestId::Number(7)),
        "cancel 后挂起必须收敛"
    );

    // 证据 #1：trace 收到 Cancelled 应答（outcome=cancelled）。
    let lines = wait_for_trace_response(&trace_path, Duration::from_secs(5)).await;
    let response = lines
        .iter()
        .find(|line| line.get("id") == Some(&serde_json::json!(7)))
        .expect("response id 必须保持 7");
    let outcome = &response["result"]["outcome"];
    let cancelled = outcome == "cancelled"
        || outcome
            .get("outcome")
            .is_some_and(|value| value == "cancelled");
    assert!(
        cancelled,
        "permission 必须以 Cancelled 收敛，实际 outcome: {outcome}"
    );

    // 证据 #1/#2（ACP-05 §5.7）：cancel_prompt 必须真正发送 session/cancel——
    // wire trace（outbound 原文，证据源 #2）与 fake ACP trace（stdin 原文，证据
    // 源 #1）双证据。OBS-03-F1（cancel_prompt 不发 session/cancel）已由 ACP-05 修复。
    let trace = std::fs::read_to_string(&trace_path).unwrap_or_default();
    let trace_has_session_cancel = trace
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .any(|line| line.get("method") == Some(&serde_json::json!("session/cancel")));
    let wire_has_session_cancel = wire_trace.snapshot().iter().any(|record| {
        record.direction == crate::acp::WireDirection::PylonToAgent
            && record.method.as_deref() == Some(crate::acp::METHOD_SESSION_CANCEL)
    });
    assert!(
        trace_has_session_cancel && wire_has_session_cancel,
        "ACP-05：cancel_prompt 必须发送 session/cancel——双证据必须同时成立（trace={trace_has_session_cancel}, wire={wire_has_session_cancel}）"
    );
    // session/cancel 参数必须携带 sessionId=peri_id（cancel 目标精确到会话）。
    let cancel_with_session = trace
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|line| line.get("method") == Some(&serde_json::json!("session/cancel")))
        .map(|line| line["params"]["sessionId"].as_str() == Some("fake-session-f"))
        .unwrap_or(false);
    assert!(
        cancel_with_session,
        "session/cancel 必须携带 sessionId=fake-session-f"
    );

    let _ = std::fs::remove_file(&trace_path);
    drop(app);
}

// ── 证据源 #4 缺口说明 ──────────────────────────────────────────────────────────────────
// 前端 invoke payload/reject（respond_interaction / cancel_prompt 的 payload 与 reject）
// 无法在 mock window 采集（无前端运行时）。已在前端静态证据（permissionController.ts:64
// `Number(envelope.requestId)` → 非数字 requestId 直接 normalize 为 null）与后端 wire 证据
// 交叉印证；本模块在 OBS-03 报告中如实登记 source #4 为"局部链路缺口"。
