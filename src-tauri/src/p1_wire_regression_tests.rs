//! P1 wire 回归矩阵（M1 closer，方案书 §5.4~§5.7 不变量全量回归）。
//!
//! 维度：provider ∈ {peri, hermes} × id kind ∈ {number, string}。每 case 断言
//! ACP-01~05 协议不变量（各卡验收条件的持续回归）：
//!   - ACP-01（§5.4）RequestId 类型化：string id 挂起 + response id 回显原始
//!     string 变体（OBS-03-P1 静默丢弃回归；旧 A3 丢弃 warn 必须消失）。
//!   - ACP-02（§5.5）options 事件级保留 kind/name/raw（CR-002 折入）+ optionId
//!     原值 + wire 顺序（D15：不硬编码 Peri/Hermes 按钮集）。
//!   - ACP-03（§5.6）deadlineMs = requestedAt + 300s（后端单一来源
//!     PERMISSION_REQUEST_TIMEOUT_SECS，前端只做倒计时展示，不自行持有超时常量）。
//!   - ACP-04（§5.6）解析失败按 JSON-RPC error（-32602）应答——不产生 pending/
//!     事件/伪造 optionId（OBS-03-E finding 回归）。
//!   - ACP-05（§5.7）cancel_prompt 真发 session/cancel 到 owner runtime，pending
//!     以 Cancelled 收敛（OBS-03-F1 回归）。
//!
//! 本模块自包含：obs03_evidence_tests 的 helper 为模块私有（且 OBS-03 是取证模块，
//! 不再扩展），fake ACP 脚本 / trace / mock window / wire trace / RuntimeLogLayer
//! 均本地实现。证据来源编号沿用 OBS-03（§5.3）：
//!   #1 Pylon→Agent stdin（fake ACP trace 回读）；#2 Agent→Pylon stdout
//!   （AcpWireHub::snapshot() 窄化前原文）；#3 mock window interaction 事件；
//!   #5 RuntimeLogHub；#6 agent stderr。

use super::*;

use std::path::Path;

use crate::acp::AcpClient;
use crate::acp::{AcpWireHub, WireIdKind, WireRecord};
use crate::agent_config::AgentDef;
use crate::permission::resolve_permission;
use crate::runtime_log::{RuntimeLogHub, RuntimeLogLayer, RuntimeLogQuery};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::Listener;
use tracing_subscriber::layer::Layer as _;

/// ACP-03（§5.6）：deadline 单一来源为后端 `PERMISSION_REQUEST_TIMEOUT_SECS`（300s，
/// permission.rs 私有常量）——测试按契约硬编码对照值，语义见 `permission_deadline_ms`。
const DEADLINE_OFFSET_MS: u64 = 300_000;

/// fake ACP 脚本：initialize 应答后发一条 request_permission（id 形态/params 由参数
/// 嵌入），此后把收到的每一行 stdin 请求写入 trace 文件；stderr 输出标记行（证据源 #6）。
/// `id_expr`：number 用 `1100`；string 用 `'perm-pa'`（python 字面量）。
fn permission_script(id_expr: &str, params: &str) -> String {
    format!(
        r#"import json,sys,time
trace=open(sys.argv[1],'w',encoding='utf-8')
def emit(obj):
    print(json.dumps(obj), flush=True)
sys.stderr.write('p1-fake-acp-stderr-marker\n')
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

/// 合法 params：options = allow_once（allowOnce）+ deny（rejectOnce），各带
/// kind/name/raw——ACP-02（§5.5）/CR-002 保留断言所需。
fn valid_params(session: &str, tool_call_id: &str) -> String {
    serde_json::json!({
        "sessionId": session,
        "toolCall": {
            "toolCallId": tool_call_id,
            "title": "edit_file",
            "rawInput": "p1-matrix-secret-marker"
        },
        "options": [
            {"optionId": "allow_once", "name": "Allow once", "kind": "allowOnce", "raw": {"legacy": "allow"}},
            {"optionId": "deny", "name": "Deny", "kind": "rejectOnce", "raw": {"legacy": "deny"}}
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

/// 构造 fake ACP agent（provider 由参数决定——peri/hermes 注册同名适配器；
/// trace 路径进 argv[1]）。
fn fake_provider_agent(name: &str, script: &str, trace_path: &Path, provider: &str) -> AgentDef {
    let mut agent = crate::test_utils::fake_acp_agent_with(
        name,
        script,
        vec![trace_path.to_string_lossy().into_owned()],
        HashMap::new(),
    );
    agent.provider = Some(provider.to_string());
    agent
}

/// state 构造：注入已连接的 AcpClient + 共享 RuntimeLogHub（stderr 证据源 #6 同 hub）。
/// 镜像 obs03——单测进程不执行 run()，peri/hermes 协议适配器都要注册。
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

/// 等待 dispatcher 挂起指定 RequestId（number/string 一等公民——ACP-01 §5.4）。
async fn wait_pending_id(
    runtime: &Arc<AgentRuntime>,
    id: crate::acp::RequestId,
    timeout: Duration,
) {
    tokio::time::timeout(timeout, async {
        loop {
            if runtime
                .pending_permissions
                .lock()
                .unwrap()
                .contains_key(&id)
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
    std::env::temp_dir().join(format!("pylon-p1-{label}-{}.jsonl", std::process::id()))
}

/// id 形态参数：python 字面量（fake ACP 脚本）、挂起键 RequestId、期望回显、
/// wire id 形态（ACP-01 §5.4 原变体保留）。
struct IdCase {
    id_expr: String,
    request_id: crate::acp::RequestId,
    echo: serde_json::Value,
    kind: WireIdKind,
    label: &'static str,
}

fn number_id_case(label: &'static str, n: u64) -> IdCase {
    IdCase {
        id_expr: n.to_string(),
        request_id: crate::acp::RequestId::Number(n),
        echo: serde_json::json!(n),
        kind: WireIdKind::Number,
        label,
    }
}

fn string_id_case(label: &'static str, s: &str) -> IdCase {
    IdCase {
        id_expr: format!("'{s}'"),
        request_id: crate::acp::RequestId::String(s.to_string()),
        echo: serde_json::json!(s),
        kind: WireIdKind::String,
        label,
    }
}

/// 单个矩阵 case 的挂起现场（app 保持存活供 cancel_prompt 读 state；事件/日志/
/// wire 全程可采集）。label 唯一标识 trace 文件。
struct PendingFixture {
    app: tauri::App<tauri::test::MockRuntime>,
    runtime: Arc<AgentRuntime>,
    wire: Arc<AcpWireHub>,
    logs: Arc<RuntimeLogHub>,
    events: std::sync::mpsc::Receiver<serde_json::Value>,
    trace_path: PathBuf,
    _guard: tracing::dispatcher::DefaultGuard,
}

/// 建现场：fake ACP（provider 参数化）连接 → state → mock app → 事件监听 →
/// log layer → dispatcher 启动。
async fn build_pending_fixture(provider: &str, id_case: &IdCase, params: &str) -> PendingFixture {
    let logs = RuntimeLogHub::new(128);
    let trace_path = temp_trace(id_case.label);
    let script = permission_script(&id_case.id_expr, params);
    let agent = fake_provider_agent(
        &format!("p1-{}", id_case.label),
        &script,
        &trace_path,
        provider,
    );
    let initial_acp = AcpClient::connect_with_logs(&agent, Some(logs.clone()))
        .await
        .expect("fake ACP must initialize");
    let wire = initial_acp
        .wire_trace()
        .expect("connected client must have wire trace");
    let state = build_state_with_logs(agent, initial_acp, logs.clone()).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("runtime");
    let (app, window) = mock_app_with(state);
    let events = capture_events(&window, crate::event_names::INTERACTION);
    let _guard = install_log_layer(&logs);
    start_notification_dispatcher(&handles, &runtime, window);
    PendingFixture {
        app,
        runtime,
        wire,
        logs,
        events,
        trace_path,
        _guard,
    }
}

/// 矩阵核心（resolve 分支，ACP-01/02/03 + CR-002）：挂起 → 事件断言 → resolve →
/// trace 应答断言（id 回显原变体 + outcome/optionId）。option ∈ {allow_once, deny}。
async fn run_resolve_matrix(provider: &str, id_case: &IdCase, option: &str) {
    let session = format!("fake-session-{}", id_case.label);
    let tool_call = format!("call-{}", id_case.label);
    let params = valid_params(&session, &tool_call);
    let fx = build_pending_fixture(provider, id_case, &params).await;

    // 挂起（string id 为一等公民——ACP-01 §5.4）。
    wait_pending_id(
        &fx.runtime,
        id_case.request_id.clone(),
        Duration::from_secs(5),
    )
    .await;

    // 证据 #3：interaction 事件（身份/options/requestId 完整）。
    let event = fx
        .events
        .recv_timeout(Duration::from_secs(2))
        .expect("必须发出 interaction 事件");
    assert_eq!(event["eventType"], "permission.request");
    assert_eq!(event["requestId"], id_case.request_id.to_string());
    assert_eq!(event["provider"], provider);
    assert_eq!(event["agentId"], format!("p1-{}", id_case.label));
    assert_eq!(event["sessionId"], session);
    assert_eq!(event["toolCallId"], tool_call);
    assert_eq!(event["clientGeneration"], 0);
    // ACP-02/CR-002（§5.5）：options 保留 kind/name/raw 原文 + optionId 原值 + wire 顺序。
    let options = &event["payload"]["options"];
    assert_eq!(options[0]["optionId"], "allow_once");
    assert_eq!(options[0]["name"], "Allow once");
    assert_eq!(options[0]["kind"], "allowOnce");
    assert_eq!(options[0]["raw"], serde_json::json!({"legacy": "allow"}));
    assert_eq!(options[1]["optionId"], "deny");
    assert_eq!(options[1]["name"], "Deny");
    assert_eq!(options[1]["kind"], "rejectOnce");
    assert_eq!(options[1]["raw"], serde_json::json!({"legacy": "deny"}));
    // ACP-03（§5.6）：deadlineMs = requestedAt + 300s（后端单一来源）。
    let requested_at_ms = event["payload"]["requestedAt"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .expect("requestedAt 必须为时间戳字符串");
    let deadline_ms = event["payload"]["deadlineMs"]
        .as_u64()
        .expect("deadlineMs 必须存在（后端单一来源）");
    assert_eq!(
        deadline_ms - requested_at_ms,
        DEADLINE_OFFSET_MS,
        "deadlineMs 必须等于 requestedAt + 300s"
    );
    // 证据 #2：wire 记录 id 形态原样（窄化前）。
    let records = request_permission_records(&fx.wire);
    assert_eq!(records.len(), 1, "request_permission 必须已记录");
    assert_eq!(records[0].id_kind, id_case.kind);
    assert_eq!(records[0].id_value, Some(id_case.echo.clone()));
    // ACP-01：string id 不再触发旧 A3 丢弃 warn（已是一等公民）。
    if id_case.kind == WireIdKind::String {
        assert!(
            entries_with_message(&fx.logs, "无数字 id 的 request_permission").is_empty(),
            "string id 必须不再触发旧 A3 丢弃 warn"
        );
    }

    // resolve（前端 approve/deny 等价路径）。
    resolve_permission(&fx.runtime, id_case.request_id.clone(), option)
        .await
        .expect("resolve must succeed");

    // 证据 #1：stdin trace 收到 response，id 回显原变体 + outcome/optionId。
    let lines = wait_for_trace_response(&fx.trace_path, Duration::from_secs(5)).await;
    let response = lines
        .iter()
        .find(|line| line.get("id") == Some(&id_case.echo))
        .expect("response id 必须回显原变体");
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["result"]["outcome"]["outcome"], "selected");
    assert_eq!(response["result"]["outcome"]["optionId"], option);
    // 证据 #5：已应答日志（resolve 在测试线程，守卫命中）。
    assert!(
        !entries_with_message(
            &fx.logs,
            &format!("权限请求 {} 已应答 {option}", id_case.request_id)
        )
        .is_empty(),
        "runtime log 必须记录应答"
    );

    let _ = std::fs::remove_file(&fx.trace_path);
    drop(fx);
}

/// 矩阵核心（invalid params 分支，ACP-04 §5.6）：解析失败 → JSON-RPC error
/// （-32602），id 回显原变体，无 pending/事件/伪造 optionId。
async fn run_invalid_params_matrix(provider: &str, id_case: &IdCase) {
    let session = format!("fake-session-invalid-{}", id_case.label);
    let params = invalid_params(&session);
    let fx = build_pending_fixture(provider, id_case, &params).await;

    // 等 dispatcher 处理解析失败（日志出现即已发出 error 应答）。
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !entries_with_message(&fx.logs, "解析失败").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("dispatcher 必须处理解析失败");

    // ACP-04：无 interaction 事件、无 pending（不是可 approve/reject 的请求）。
    assert!(
        fx.events.recv_timeout(Duration::from_millis(400)).is_err(),
        "解析失败不得触发 interaction 事件"
    );
    assert!(
        fx.runtime.pending_permissions.lock().unwrap().is_empty(),
        "解析失败不得产生 pending"
    );

    // 证据 #1（ACP-04）：JSON-RPC error 应答（id 回显原变体），无伪造 optionId。
    let lines = wait_for_trace_response(&fx.trace_path, Duration::from_secs(5)).await;
    let response = lines
        .iter()
        .find(|line| line.get("id") == Some(&id_case.echo))
        .expect("response id 必须回显原变体");
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(
        response["error"]["code"], -32602,
        "解析失败必须按 JSON-RPC error 应答（不伪造 optionId）"
    );
    assert!(
        response.get("result").is_none(),
        "解析失败不得携带 result/outcome"
    );
    // 证据 #2：wire 已记录该 request_permission（窄化前 id 形态）。
    let records = request_permission_records(&fx.wire);
    assert_eq!(records.len(), 1, "request_permission 必须已记录");
    assert_eq!(records[0].id_kind, id_case.kind);
    assert_eq!(records[0].id_value, Some(id_case.echo.clone()));

    let _ = std::fs::remove_file(&fx.trace_path);
    drop(fx);
}

/// 矩阵核心（cancel 分支，ACP-05 §5.7）：挂起 + session 映射 → cancel_prompt →
/// session/cancel 双证据 + pending 以 Cancelled 收敛。
async fn run_cancel_matrix(provider: &str, id_case: &IdCase) {
    let session = format!("fake-session-{}", id_case.label);
    let tool_call = format!("call-{}", id_case.label);
    let params = valid_params(&session, &tool_call);
    let fx = build_pending_fixture(provider, id_case, &params).await;

    wait_pending_id(
        &fx.runtime,
        id_case.request_id.clone(),
        Duration::from_secs(5),
    )
    .await;
    // session 映射 source ↔ peri_id（cancel_prompt 依赖 owner runtime 查找）。
    let source = format!("source-{}", id_case.label);
    {
        let mut sessions = fx.runtime.sessions.lock().unwrap();
        sessions.insert(
            source.clone(),
            SessionInfo::new(session.clone(), "persona".into(), ".".into(), true, 0),
        );
    }
    // 证据 #3：interaction 事件（挂起时前端可展示）。
    let event = fx
        .events
        .recv_timeout(Duration::from_secs(2))
        .expect("必须发出 interaction 事件");
    assert_eq!(event["requestId"], id_case.request_id.to_string());

    // 前端 cancel 路径：cancel_prompt(agentId="p1-{label}", source)。OWNER-02：显式 agentId。
    crate::session::cancel_prompt(
        fx.app.state::<AppState>(),
        format!("p1-{}", id_case.label),
        source.clone(),
    )
    .await
    .expect("cancel_prompt 必须成功");
    assert!(
        !fx.runtime
            .pending_permissions
            .lock()
            .unwrap()
            .contains_key(&id_case.request_id),
        "cancel 后挂起必须收敛"
    );

    // 证据 #1：trace 收到 Cancelled 应答（outcome=cancelled）。
    let lines = wait_for_trace_response(&fx.trace_path, Duration::from_secs(5)).await;
    let response = lines
        .iter()
        .find(|line| line.get("id") == Some(&id_case.echo))
        .expect("response id 必须回显原变体");
    let outcome = &response["result"]["outcome"];
    let cancelled = outcome == "cancelled"
        || outcome
            .get("outcome")
            .is_some_and(|value| value == "cancelled");
    assert!(
        cancelled,
        "permission 必须以 Cancelled 收敛，实际 outcome: {outcome}"
    );

    // 证据 #1/#2（ACP-05 §5.7）：cancel_prompt 真发 session/cancel——wire trace
    // （outbound 原文，证据源 #2）与 fake ACP trace（stdin 原文，证据源 #1）双证据。
    // OBS-03-F1（cancel_prompt 不发 session/cancel）已由 ACP-05 修复。
    let trace = std::fs::read_to_string(&fx.trace_path).unwrap_or_default();
    let trace_has_session_cancel = trace
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .any(|line| line.get("method") == Some(&serde_json::json!("session/cancel")));
    let wire_has_session_cancel = fx.wire.snapshot().iter().any(|record| {
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
        .map(|line| line["params"]["sessionId"].as_str() == Some(session.as_str()))
        .unwrap_or(false);
    assert!(
        cancel_with_session,
        "session/cancel 必须携带 sessionId={session}"
    );

    let _ = std::fs::remove_file(&fx.trace_path);
    drop(fx);
}

// ── resolve 矩阵：provider × id kind × {allow_once, deny} ───────────────────────────────

#[tokio::test]
async fn matrix_peri_number_resolve_allow_once() {
    let id = number_id_case("peri-n-allow", 1100);
    run_resolve_matrix("peri", &id, "allow_once").await;
}

#[tokio::test]
async fn matrix_peri_string_resolve_allow_once() {
    let id = string_id_case("peri-s-allow", "perm-pa");
    run_resolve_matrix("peri", &id, "allow_once").await;
}

#[tokio::test]
async fn matrix_hermes_number_resolve_allow_once() {
    let id = number_id_case("hermes-n-allow", 1200);
    run_resolve_matrix("hermes", &id, "allow_once").await;
}

#[tokio::test]
async fn matrix_hermes_string_resolve_allow_once() {
    let id = string_id_case("hermes-s-allow", "perm-ha");
    run_resolve_matrix("hermes", &id, "allow_once").await;
}

#[tokio::test]
async fn matrix_peri_number_resolve_deny() {
    let id = number_id_case("peri-n-deny", 1300);
    run_resolve_matrix("peri", &id, "deny").await;
}

#[tokio::test]
async fn matrix_peri_string_resolve_deny() {
    let id = string_id_case("peri-s-deny", "perm-pd");
    run_resolve_matrix("peri", &id, "deny").await;
}

#[tokio::test]
async fn matrix_hermes_number_resolve_deny() {
    let id = number_id_case("hermes-n-deny", 1400);
    run_resolve_matrix("hermes", &id, "deny").await;
}

#[tokio::test]
async fn matrix_hermes_string_resolve_deny() {
    let id = string_id_case("hermes-s-deny", "perm-hd");
    run_resolve_matrix("hermes", &id, "deny").await;
}

// ── invalid params 矩阵：provider × id kind ────────────────────────────────────────────

#[tokio::test]
async fn matrix_peri_number_invalid_params() {
    let id = number_id_case("peri-n-invalid", 1500);
    run_invalid_params_matrix("peri", &id).await;
}

#[tokio::test]
async fn matrix_peri_string_invalid_params() {
    let id = string_id_case("peri-s-invalid", "perm-pi");
    run_invalid_params_matrix("peri", &id).await;
}

#[tokio::test]
async fn matrix_hermes_number_invalid_params() {
    let id = number_id_case("hermes-n-invalid", 1600);
    run_invalid_params_matrix("hermes", &id).await;
}

#[tokio::test]
async fn matrix_hermes_string_invalid_params() {
    let id = string_id_case("hermes-s-invalid", "perm-hi");
    run_invalid_params_matrix("hermes", &id).await;
}

// ── cancel 矩阵：provider × id kind（owner runtime + Cancelled 收敛）────────────────────

#[tokio::test]
async fn matrix_peri_number_cancel() {
    let id = number_id_case("peri-n-cancel", 1700);
    run_cancel_matrix("peri", &id).await;
}

#[tokio::test]
async fn matrix_hermes_string_cancel() {
    let id = string_id_case("hermes-s-cancel", "perm-hc");
    run_cancel_matrix("hermes", &id).await;
}
