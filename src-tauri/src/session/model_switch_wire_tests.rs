//! #97（通用 ACP 模型选择器与切换闭环）wire 级集成测试。
//! fixture 不以真实 provider 命名：一个标准 config-option Agent（非标准广告 id
//! `model-selection`）、一个 session/load 复活 Agent（根级 availableModels）。
//! 断言直读 fake agent 的请求 trace（method/configId/modelId），不做本地 reducer
//! 乐观态断言替代。
use super::*;
use crate::acp::AcpClient;
use crate::agent_config::{AcpProtocolConfig, SetModelApi};
use crate::test_utils::TestStateBuilder;
use std::collections::HashMap;
use tauri::Manager;

/// 标准 config-option Agent：模型面为 category=="model" 的选项，广告 id 是
/// 非标准 `model-selection`（刻意不是语义键 `model`）。set_config_option 支持
/// 三种回显模式（由 extra_args 模式位控制）：
/// - `echo-empty`：恒空 result（空回声，hermes 形态）
/// - `echo-adopted:<current>`：回权威 adopted 列表，current 为指定值（钳制）
/// - 默认：回权威列表 current==requested（确认）
const CONFIG_OPTION_SCRIPT: &str = r#"import json,sys
mode=sys.argv[1]
trace=open(sys.argv[2],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n'); trace.flush()
    method=request.get('method'); params=request.get('params') or {}
    result={}
    if method == 'session/new':
        result={'sessionId':'ms-session','configOptions':[{
            'id':'model-selection','category':'model',
            'options':[{'valueId':'m-1','name':'One'},{'valueId':'m-2','name':'Two'}],
            'currentValue':'m-1'}]}
    elif method == 'session/set_config_option':
        if mode == 'echo-empty':
            result={}
        elif mode.startswith('echo-adopted:'):
            current=mode.split(':',1)[1]
            result={'configOptions':[{
                'id':'model-selection','category':'model',
                'options':[{'valueId':'m-1'},{'valueId':'m-2'}],
                'currentValue':current}]}
        else:
            result={'configOptions':[{
                'id':'model-selection','category':'model',
                'options':[{'valueId':'m-1'},{'valueId':'m-2'}],
                'currentValue':params.get('value')}]}
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':result}),flush=True)
"#;

fn unique_trace(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "pylon-{name}-{}-{}.jsonl",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

async fn config_option_app(
    trace: &std::path::Path,
    echo_mode: &str,
) -> (tauri::App<tauri::test::MockRuntime>, Arc<AgentRuntime>) {
    let agent = crate::test_utils::fake_acp_agent_with(
        "ms-agent",
        CONFIG_OPTION_SCRIPT,
        vec![
            echo_mode.to_string(),
            trace.to_string_lossy().into_owned(),
        ],
        HashMap::new(),
    );
    // 显式 set_model_api 声明（现状兼容路径）——旧实现在该路径会把广告 id
    // `model-selection` 降级成语义键 `model` 发上 wire（#97 缺口）。
    let mut agent = agent;
    agent.acp = Some(AcpProtocolConfig {
        set_model_api: Some(SetModelApi::ConfigOption),
        ..Default::default()
    });
    let runtime = AgentRuntime::new_disconnected();
    *runtime.acp.lock().await = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = TestStateBuilder::bare()
        .with_active_agent("ms-agent")
        .with_agent(agent)
        .with_runtime("ms-agent", runtime.clone())
        .build();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app must build");
    app.manage(state);
    (app, runtime)
}

async fn create_session(app: &tauri::App<tauri::test::MockRuntime>) {
    new_session(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "profile-ms".to_string(),
        "persona".to_string(),
        Some(".".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("session must be created");
}

fn read_trace_methods(trace: &std::path::Path) -> Vec<(String, serde_json::Value)> {
    let content = std::fs::read_to_string(trace).expect("read trace");
    content
        .lines()
        .map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            (
                value
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string(),
                value.get("params").cloned().unwrap_or(serde_json::Value::Null),
            )
        })
        .collect()
}

/// 验收 1（wire 断言）：显式 ConfigOption 声明 + 非标准广告 id——运行时切换必须
/// 把 `configId=model-selection` 原样发上 wire，禁止降级成语义键 `model`。
/// 空回声下 requested 值保留为可辨识的 pending。
#[tokio::test]
async fn runtime_switch_sends_advertised_config_id_and_keeps_pending_on_empty_echo() {
    let trace = unique_trace("ms-adv-id");
    let (app, runtime) = config_option_app(&trace, "echo-empty").await;
    create_session(&app).await;

    let result = set_config_option(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "model".to_string(),
        serde_json::json!("m-2"),
    )
    .await
    .expect("switch must succeed on empty echo");

    assert!(result.as_object().map_or(true, |o| o.is_empty()));
    let session = runtime.sessions.lock().unwrap().get("local:ms").cloned().unwrap();
    assert_eq!(session.model, "m-2", "空回声保留乐观值");
    assert_eq!(
        session.model_pending.as_deref(),
        Some("m-2"),
        "空回声必须保留可辨识的未确认态"
    );
    assert_eq!(
        session.model_surface,
        ModelSurface::ConfigOption {
            config_id: "model-selection".to_string()
        }
    );
    assert_eq!(session.model_choices, vec!["m-1".to_string(), "m-2".to_string()]);

    let methods = read_trace_methods(&trace);
    let switches: Vec<&serde_json::Value> = methods
        .iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .map(|(_, params)| params)
        .collect();
    assert_eq!(switches.len(), 1, "{methods:?}");
    assert_eq!(
        switches[0].get("configId").and_then(|v| v.as_str()),
        Some("model-selection"),
        "广告的真实 config id 必须原样上 wire：{:?}",
        switches[0]
    );
    assert_eq!(switches[0].get("value"), Some(&serde_json::json!("m-2")));
    std::fs::remove_file(&trace).ok();
}

/// 验收 3（发送前拒绝）：有广告集合时，未广告 model id 在发送 RPC 前被拒绝
/// （trace 无 set_config_option），会话状态不变。
#[tokio::test]
async fn unadvertised_model_id_is_rejected_before_any_rpc() {
    let trace = unique_trace("ms-reject");
    let (app, runtime) = config_option_app(&trace, "echo-empty").await;
    create_session(&app).await;

    let error = set_config_option(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "model".to_string(),
        serde_json::json!("m-not-advertised"),
    )
    .await
    .expect_err("未广告 id 必须被拒");

    assert!(error.to_string().contains("model_not_advertised"));
    let session = runtime.sessions.lock().unwrap().get("local:ms").cloned().unwrap();
    assert_eq!(session.model, "m-1", "拒绝后本地 current 不变");
    assert_eq!(session.model_pending, None);
    let methods = read_trace_methods(&trace);
    assert!(
        !methods.iter().any(|(method, _)| method == "session/set_config_option"),
        "被拒请求绝不能上 wire：{methods:?}"
    );
    std::fs::remove_file(&trace).ok();
}

/// 验收（钳制收敛）：Agent 回显 adopted 列表把 requested 钳制为实际值时，
/// 会话状态（current/pending/catalog）一致收敛到 Agent 实际值。
#[tokio::test]
async fn clamped_switch_converges_to_agent_settled_value() {
    let trace = unique_trace("ms-clamp");
    let (app, runtime) = config_option_app(&trace, "echo-adopted:m-1").await;
    create_session(&app).await;

    set_config_option(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "model".to_string(),
        serde_json::json!("m-2"),
    )
    .await
    .expect("钳制不是传输失败");

    let session = runtime.sessions.lock().unwrap().get("local:ms").cloned().unwrap();
    assert_eq!(session.model, "m-1", "最终状态必须回到 Agent 实际值");
    assert_eq!(session.model_pending, None, "权威回显清除未确认态");
    assert_eq!(session.model_choices, vec!["m-1".to_string(), "m-2".to_string()]);
    std::fs::remove_file(&trace).ok();
}

/// 验收（reconnect replay + 根级列表）：session/load 复活期不发任何 selector RPC
/// （Agent 推送优先、模型先于依赖 option 的一次性 restore），根级
/// availableModels 进入 SessionInfo 模型面。
#[tokio::test]
async fn load_revive_applies_root_level_catalog_without_selector_rpcs() {
    const SCRIPT: &str = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n'); trace.flush()
    method=request.get('method')
    result={}
    if method == 'initialize':
        result={'agentCapabilities':{'sessionCapabilities':{'loadSession':{}}}}
    elif method == 'session/load':
        result={'sessionId':'remote-original','availableModels':[
            {'modelId':'root:alpha','name':'Alpha'},{'modelId':'root:beta','name':'Beta'}],
            'currentModelId':'root:beta','configOptions':[{
            'id':'reasoning_effort','category':'thought_level',
            'options':[{'valueId':'low'},{'valueId':'high'}],'currentValue':'low'}]}
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':result}),flush=True)
"#;
    let trace = unique_trace("ms-revive");
    let agent = crate::test_utils::fake_acp_agent_with(
        "ms-revive-agent",
        SCRIPT,
        vec![trace.to_string_lossy().into_owned()],
        HashMap::new(),
    );
    let runtime = AgentRuntime::new_disconnected();
    *runtime.acp.lock().await = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = TestStateBuilder::bare()
        .with_active_agent("ms-revive-agent")
        .with_agent(agent)
        .with_runtime("ms-revive-agent", runtime.clone())
        .build();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app must build");
    app.manage(state);
    let state = app.state::<AppState>();

    let mut recreated = None;
    ensure_session_mapping(
        &state,
        &runtime,
        "local:revive",
        Some("profile-revive"),
        "",
        ".",
        &[],
        Some("remote-original"),
        &mut recreated,
    )
    .await
    .expect("revive must succeed");

    assert_eq!(recreated, None, "复活成功不得重建会话");
    let session = runtime
        .sessions
        .lock()
        .unwrap()
        .get("local:revive")
        .cloned()
        .unwrap();
    // 根级 availableModels（无嵌套 models 键）等价进入模型面（验收 2 wire 侧）。
    assert_eq!(session.model_surface, ModelSurface::ModelsState);
    assert_eq!(
        session.model_choices,
        vec!["root:alpha".to_string(), "root:beta".to_string()]
    );
    assert_eq!(session.model, "root:beta");
    assert_eq!(session.mode.as_deref(), None);

    // replay 期 selector 零 RPC：模型状态来自 Agent 的 load 响应本身。
    let methods: Vec<String> = read_trace_methods(&trace)
        .into_iter()
        .map(|(method, _)| method)
        .collect();
    assert!(
        !methods
            .iter()
            .any(|m| m == "session/set_config_option" || m == "session/set_model"),
        "复活期不得自动补发 selector RPC：{methods:?}"
    );
    std::fs::remove_file(&trace).ok();
}
