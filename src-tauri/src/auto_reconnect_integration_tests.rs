use super::*;

use crate::agent_config::AgentDef;

/// fake ACP 脚本：FAKE_MODE=crash 时响应首个请求（initialize）后立即退出
/// → stdout EOF → 崩溃通知；FAKE_MODE=alive 时保持存活并响应请求。
const FAKE_SCRIPT: &str = r#"import json,sys,os
mode = os.environ.get('FAKE_MODE', 'alive')
for line in sys.stdin:
    request = json.loads(line)
    response = {'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    method = request.get('method')
    if method == 'session/new':
        response['result'] = {'sessionId':'fake-session-1'}
    elif method == 'session/prompt':
        response['result'] = {'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
    if mode == 'crash':
        sys.exit(0)
"#;

fn fake_agent(mode: &str) -> AgentDef {
    let mut env = std::collections::HashMap::new();
    env.insert("FAKE_MODE".to_string(), mode.to_string());
    crate::test_utils::fake_acp_agent_with("fake-acp", FAKE_SCRIPT, Vec::new(), env)
}

/// G5-2：state 构造收敛到 test_utils::test_state_with_acp；本模块特有的
/// "崩溃前 session 映射"预置（builder 不背此语义，方案 05 §2.1 第 3 点）保留在测试内。
async fn build_state(initial_acp: AcpClient, agent: AgentDef) -> AppState {
    let state = crate::test_utils::test_state_with_acp(
        agent.clone(),
        initial_acp,
        Arc::new(gateway::GatewayCore::new()),
        prism::PrismClient::unavailable("test".to_string()),
    )
    .await;
    let runtime = state.runtimes.get(&agent.name).expect("runtime must exist");
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        // 崩溃前已有会话映射（generation 0）——重连后应保留并迁移到新代际
        sessions.insert(
            "source-a".to_string(),
            SessionInfo::new(
                "fake-session-1".into(),
                "persona".into(),
                ".".into(),
                true,
                0,
            ),
        );
    }
    state
}

#[tokio::test]
async fn fake_acp_crash_triggers_auto_reconnect() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .build()
    .expect("mock window must build");

    // 初始连接 crash 模式：initialize 成功但进程立即退出 → EOF → 崩溃通知
    let crash_agent = fake_agent("crash");
    let initial_acp = AcpClient::connect_with_logs(&crash_agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = build_state(initial_acp, crash_agent).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("active runtime must exist");
    start_notification_dispatcher(&handles, &runtime, window);

    // 等待崩溃被 dispatcher 处理：状态置 Crashed + 自动重连已调度
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let status = runtime
                .agent_runtime
                .lock()
                .map(|r| r.status)
                .unwrap_or(AgentLifecycleStatus::Disconnected);
            if status == AgentLifecycleStatus::Crashed {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("dispatcher must observe crash within 5s");
    assert!(
        runtime.auto_reconnect_active.load(Ordering::Acquire),
        "auto-reconnect must be scheduled on crash"
    );

    // 注入重连成功：自动重连（2s 退避）开始前把 agents 表切到 alive 模式
    {
        let mut agents = state.agents.lock().unwrap();
        agents.insert("fake-acp".to_string(), fake_agent("alive"));
    }

    // 等待自动重连完成：Connected + generation 前进
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let status = runtime
                .agent_runtime
                .lock()
                .map(|r| r.status)
                .unwrap_or(AgentLifecycleStatus::Disconnected);
            if status == AgentLifecycleStatus::Connected {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("auto-reconnect must restore Connected within 15s");

    // 断言：generation +1、sessions 保留且迁移到新代际、防重入标志释放
    assert_eq!(
        runtime.client_generation.load(Ordering::Acquire),
        1,
        "auto-reconnect must bump generation"
    );
    {
        let sessions = runtime.sessions.lock().unwrap();
        assert_eq!(sessions.len(), 1, "sessions must survive auto-reconnect");
        assert_eq!(
            sessions.get("source-a").map(|s| s.generation),
            Some(1),
            "kept sessions must migrate generation"
        );
    }
    assert!(
        !runtime.auto_reconnect_active.load(Ordering::Acquire),
        "auto-reconnect flag must release after loop"
    );
}

/// A5：持续崩溃型 fake ACP（每次重启成功激活后 200ms 内退出）→ 自动重连循环必须
/// 在"连接成功后又崩"时继续退避重连（而非 break 后永久 Crashed），最终标志释放。
/// 200ms 延迟是刻意的：replace_agent_client 的 is_crashed() 检查在激活时发生，
/// 立即退出会让每次重连都撞上 "crashed before activation"（走 Err 分支，generation
/// 从不前进，"成功后又崩"不可观察）；延迟到激活之后才崩，才能覆盖 A5 场景。
const CRASH_LOOP_SCRIPT: &str = r#"import json,sys,time
for line in sys.stdin:
    request = json.loads(line)
    response = {'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    method = request.get('method')
    if method == 'session/new':
        response['result'] = {'sessionId':'fake-session-1'}
    elif method == 'session/prompt':
        response['result'] = {'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
    time.sleep(0.2)
    sys.exit(0)
"#;

/// A5 回归：重连成功后又立即崩溃时，成功分支复查 still_stale 后继续退避重连，
/// agent 不会因防重入标志吞掉第二次崩溃通知而永久下线。
#[tokio::test]
async fn fake_acp_crash_loop_keeps_reconnecting_then_flag_releases() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .build()
    .expect("mock window must build");

    // 初始连接 crash-loop 模式：initialize 成功后 200ms 退出 → EOF → 崩溃通知
    let crash_agent = crate::test_utils::fake_acp_agent_with(
        "fake-acp",
        CRASH_LOOP_SCRIPT,
        Vec::new(),
        std::collections::HashMap::new(),
    );
    let initial_acp = AcpClient::connect_with_logs(&crash_agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = build_state(initial_acp, crash_agent).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("active runtime must exist");
    start_notification_dispatcher(&handles, &runtime, window.clone());

    // 首次崩溃 → 自动重连已调度（标志 true）
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let status = runtime
                .agent_runtime
                .lock()
                .map(|r| r.status)
                .unwrap_or(AgentLifecycleStatus::Disconnected);
            if status == AgentLifecycleStatus::Crashed
                && runtime.auto_reconnect_active.load(Ordering::Acquire)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("dispatcher must observe crash and schedule auto-reconnect within 5s");

    // 持续崩溃：每次重连成功（generation +1）后 200ms 又崩 → 循环必须继续退避重连。
    // 达到 generation>=2 即证明"成功后又崩"至少发生一轮且重连被多次调度
    // （修复前：第一次重连成功后循环 break，崩溃通知被防重入标志吞掉，generation 永远停 1）。
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if runtime.client_generation.load(Ordering::Acquire) >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("auto-reconnect must retry after post-reconnect crash (generation >= 2)");

    // 恢复场景收尾：切 alive + 手动 reconnect → 在途退避循环复查非 Crashed 提前
    // 放弃并释放防重入标志（可再次调度），agent 稳定 Connected。
    {
        let mut agents = state.agents.lock().unwrap();
        agents.insert("fake-acp".to_string(), fake_agent("alive"));
    }
    let agent = state.get_active_agent().expect("active agent");
    do_connect_and_replace(
        &handles,
        &runtime,
        &window,
        &agent,
        None,
        AgentLifecycleStatus::Reconnecting,
        "reconnect",
        false,
        true,
    )
    .await
    .expect("manual reconnect must succeed");
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let status = runtime
                .agent_runtime
                .lock()
                .map(|r| r.status)
                .unwrap_or(AgentLifecycleStatus::Disconnected);
            let flag = runtime.auto_reconnect_active.load(Ordering::Acquire);
            if status == AgentLifecycleStatus::Connected && !flag {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("flag must release and agent must stay Connected within 15s");
    assert!(
        !runtime.auto_reconnect_active.load(Ordering::Acquire),
        "auto-reconnect flag must be released and reschedulable"
    );
}

/// A7 回归：洪泛 300 条（> BROADCAST_CAP=256）后 EOF——NOTIF_AGENT_CRASHED 广播
/// 必然被 Lagged 丢弃（dispatcher 逐条处理期间队列溢出），崩溃信号必须经独立
/// watch 通道送达，自动重连才仍会触发。
#[tokio::test]
async fn flood_crash_still_triggers_auto_reconnect_via_watch() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .build()
    .expect("mock window must build");

    // 洪泛崩溃 agent：initialize 成功后连发 300 条 session/update 再退出。
    // 300 > BROADCAST_CAP(256)——广播路径的崩溃通知必然丢失，只有 watch 通道可靠。
    let flood_script = r#"import json,sys
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
        for i in range(300):
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'flood','update':{'sessionUpdate':'agent_message_chunk','content':{'text':'x'}}}}), flush=True)
        break
sys.exit(0)
"#;
    let flood_agent = crate::test_utils::fake_acp_agent_with(
        "fake-acp",
        flood_script,
        Vec::new(),
        std::collections::HashMap::new(),
    );
    let initial_acp = AcpClient::connect_with_logs(&flood_agent, None)
        .await
        .expect("flood fake ACP must initialize");
    let state = build_state(initial_acp, flood_agent).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("active runtime must exist");
    start_notification_dispatcher(&handles, &runtime, window);

    // 等待崩溃被 dispatcher 处理：状态置 Crashed（经 watch 路径，广播已丢）
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let status = runtime
                .agent_runtime
                .lock()
                .map(|r| r.status)
                .unwrap_or(AgentLifecycleStatus::Disconnected);
            if status == AgentLifecycleStatus::Crashed {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("dispatcher must observe flood crash via watch within 5s");
    assert!(
        runtime.auto_reconnect_active.load(Ordering::Acquire),
        "auto-reconnect must be scheduled on crash even after broadcast overflow"
    );
}

/// 核验回归：崩溃触发自动重连调度后，用户手动 reconnect 成功——
/// 自动重连闭包复查 status!=Crashed 提前放弃时**必须释放防重入标志**，
/// 否则下一次崩溃将永远不再自动重连。
#[tokio::test]
async fn manual_reconnect_releases_auto_reconnect_flag() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .build()
    .expect("mock window must build");

    let crash_agent = fake_agent("crash");
    let initial_acp = AcpClient::connect_with_logs(&crash_agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = build_state(initial_acp, crash_agent).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("active runtime must exist");
    start_notification_dispatcher(&handles, &runtime, window.clone());

    // 崩溃 → 自动重连已调度（标志 true）
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if runtime.auto_reconnect_active.load(Ordering::Acquire) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("auto-reconnect must be scheduled on crash");

    // 用户手动 reconnect：agents 表切 alive + 走手动连接路径（状态置 Connected）
    {
        let mut agents = state.agents.lock().unwrap();
        agents.insert("fake-acp".to_string(), fake_agent("alive"));
    }
    let agent = state.get_active_agent().expect("active agent");
    do_connect_and_replace(
        &handles,
        &runtime,
        &window,
        &agent,
        None,
        AgentLifecycleStatus::Reconnecting,
        "reconnect",
        false,
        true,
    )
    .await
    .expect("manual reconnect must succeed");

    // 自动重连闭包（2s 退避后复查）发现 status!=Crashed → 提前放弃并释放标志
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if !runtime.auto_reconnect_active.load(Ordering::Acquire) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("auto-reconnect flag must release after manual reconnect");
    assert_eq!(
        runtime.client_generation.load(Ordering::Acquire),
        1,
        "manual reconnect must bump generation"
    );
}

/// fake ACP：initialize 后主动发 request_permission（id 5），随后把 stdin 收到的
/// 每一行写入 trace（验证客户端应答 wire）。
const PERMISSION_SCRIPT: &str = r#"import json,sys,time
trace=open(sys.argv[1],'w',encoding='utf-8')
def emit(obj):
    print(json.dumps(obj), flush=True)
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        emit({'jsonrpc':'2.0','id':request.get('id'),'result':{}})
        time.sleep(0.5)
        emit({'jsonrpc':'2.0','id':5,'method':'session/request_permission','params':{
            'sessionId':'fake-session-p1',
            'toolCall':{'toolCallId':'call-9','title':'edit_file','rawInput':'{"token=SECRET}","path":"x"}'},
            'options':[{'optionId':'allow_once','name':'Allow once','kind':'allowOnce'},
                       {'optionId':'reject_once','name':'Reject','kind':'rejectOnce'}]
        }})
    else:
        trace.write(line)
        trace.flush()
"#;

#[tokio::test]
async fn fake_acp_request_permission_pends_then_resolves_on_wire() {
    let trace_path =
        std::env::temp_dir().join(format!("pylon-permission-{}.jsonl", std::process::id()));
    let mut env = std::collections::HashMap::new();
    env.insert("FAKE_MODE".to_string(), "alive".to_string());
    let agent = crate::test_utils::fake_acp_agent_with(
        "fake-permission",
        PERMISSION_SCRIPT,
        vec![trace_path.to_string_lossy().into_owned()],
        env,
    );
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = build_state(initial_acp, agent).await;
    let handles = AppStateHandles::from_state(&state);
    let runtime = handles.active_runtime().expect("active runtime");
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .build()
    .expect("mock window must build");
    start_notification_dispatcher(&handles, &runtime, window);

    // 等 dispatcher 挂起权限请求
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let contains = runtime.pending_permissions.lock().unwrap().contains_key(&5);
            if contains {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("dispatcher must pend request_permission");
    let (tool_call_id, options, prompt) = {
        let pending = runtime.pending_permissions.lock().unwrap();
        let permission = pending.get(&5).expect("pending entry");
        (
            permission.tool_call_id.clone(),
            permission.options.clone(),
            permission.prompt.clone(),
        )
    };
    assert_eq!(tool_call_id, "call-9");
    assert_eq!(options, vec!["allow_once", "reject_once"]);
    assert!(!prompt.contains("SECRET"), "事件 prompt 必须脱敏");

    // 应答（approve_tool_call 等价路径）
    resolve_permission(&runtime, 5, "allow_once")
        .await
        .expect("resolve must succeed");
    assert!(
        !runtime.pending_permissions.lock().unwrap().contains_key(&5),
        "应答后必须清理挂起"
    );

    // 等 fake ACP 收到响应并写入 trace
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if std::fs::metadata(&trace_path)
                .map(|m| m.len() > 0)
                .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("fake ACP must receive response");
    let trace = std::fs::read_to_string(&trace_path).expect("read trace");
    std::fs::remove_file(&trace_path).ok();
    let response: serde_json::Value = serde_json::from_str(trace.trim()).expect("trace line");
    assert_eq!(response["id"], 5);
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["result"]["outcome"]["outcome"], "selected");
    assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");
}
