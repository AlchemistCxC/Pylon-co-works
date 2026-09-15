//! #97（通用 ACP 模型选择器与切换闭环）wire 级集成测试。
//! fixture 不以真实 provider 命名：一个标准 config-option Agent（非标准广告 id
//! `model-selection` + reasoning 依赖选项）、一个空宣告 Agent、一个 session/load
//! 复活 Agent（根级 availableModels）。断言直读 fake agent 的请求 trace
//! （method/configId/modelId），不做本地 reducer 乐观态断言替代。
use super::*;
use crate::acp::AcpClient;
use crate::agent_config::{AcpProtocolConfig, SetModelApi};
use crate::test_utils::TestStateBuilder;

use std::sync::atomic::Ordering;
use tauri::Manager;

// 标准 config-option Agent：模型面为 category=="model" 的选项，广告 id 是
// 非标准 `model-selection`（刻意不是语义键 `model`），另有 reasoning 依赖选项。
// 行为在 `pylon-fake-agent --scenario set-config-option --mode <m>`：
// 模式与旗标语义见 bin 侧 `handle_request`（echo-empty / echo-adopted:<current> /
// reject / barrier / 默认 confirm）；trace 与文件屏障经 `--trace-file` /
// `--barrier-ready/--barrier-release` 传入。

/// 测试期持有 trace 文件路径，Drop 时无条件清理（断言失败也不泄漏 temp 文件）。
struct TraceFile(std::path::PathBuf);

impl TraceFile {
    fn new(name: &str) -> Self {
        Self(std::env::temp_dir().join(format!(
            "pylon-{name}-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )))
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TraceFile {
    fn drop(&mut self) {
        std::fs::remove_file(&self.0).ok();
    }
}

/// N6（第二轮评审）：barrier 信号文件（ready/release）的 Drop 清理——断言失败
/// 路径也不泄漏 temp 文件。
struct SignalFiles(Vec<std::path::PathBuf>);

impl Drop for SignalFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            std::fs::remove_file(path).ok();
        }
    }
}

async fn config_option_app(
    trace: &std::path::Path,
    echo_mode: &str,
    barrier: Option<(String, String)>,
) -> (tauri::App<tauri::test::MockRuntime>, Arc<AgentRuntime>) {
    let mut args: Vec<String> = [
        "--scenario",
        "set-config-option",
        "--mode",
        echo_mode,
        "--trace-file",
        &trace.to_string_lossy(),
        "--trace-mode",
        "all",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    if let Some((ready, release)) = barrier {
        args.push("--barrier-ready".to_string());
        args.push(ready);
        args.push("--barrier-release".to_string());
        args.push(release);
    }
    let mut agent = crate::test_utils::fake_acp_agent("ms-agent", &[]);
    agent.args = args;
    // 显式 set_model_api 声明（现状兼容路径）——旧实现在该路径会把广告 id
    // `model-selection` 降级成语义键 `model` 发上 wire（#97 缺口）。
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

async fn create_session(app: &tauri::App<tauri::test::MockRuntime>, agent_id: &str, source: &str) {
    new_session(
        app.state::<AppState>(),
        agent_id.to_string(),
        source.to_string(),
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
                value
                    .get("params")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
        })
        .collect()
}

/// 验收 1（wire 断言）：显式 ConfigOption 声明 + 非标准广告 id——运行时切换必须
/// 把 `configId=model-selection` 原样发上 wire，禁止降级成语义键 `model`。
/// 空回声下 requested 值保留为可辨识的 pending。
#[tokio::test]
async fn runtime_switch_sends_advertised_config_id_and_keeps_pending_on_empty_echo() {
    let trace = TraceFile::new("ms-adv-id");
    let (app, runtime) = config_option_app(trace.path(), "echo-empty", None).await;
    create_session(&app, "ms-agent", "local:ms").await;

    let result = set_config_option(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "model".to_string(),
        serde_json::json!("m-2"),
    )
    .await
    .expect("switch must succeed on empty echo");

    // 空回声：命令返回的就是 agent 的空对象（精确相等，防止实现夹带合成状态）。
    assert_eq!(result, serde_json::json!({}));
    let session = runtime
        .sessions
        .lock()
        .unwrap()
        .get("local:ms")
        .cloned()
        .unwrap();
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
    assert_eq!(
        session.model_choices,
        vec!["m-1".to_string(), "m-2".to_string()]
    );

    let methods = read_trace_methods(trace.path());
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
}

/// 验收 3（发送前拒绝）：有广告集合时，未广告 model id 在发送 RPC 前被拒绝
/// （trace 无 set_config_option），会话状态不变。
#[tokio::test]
async fn unadvertised_model_id_is_rejected_before_any_rpc() {
    let trace = TraceFile::new("ms-reject");
    let (app, runtime) = config_option_app(trace.path(), "echo-empty", None).await;
    create_session(&app, "ms-agent", "local:ms").await;

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
    let session = runtime
        .sessions
        .lock()
        .unwrap()
        .get("local:ms")
        .cloned()
        .unwrap();
    assert_eq!(session.model, "m-1", "拒绝后本地 current 不变");
    assert_eq!(session.model_pending, None);
    let methods = read_trace_methods(trace.path());
    assert!(
        !methods
            .iter()
            .any(|(method, _)| method == "session/set_config_option"),
        "被拒请求绝不能上 wire：{methods:?}"
    );
}

/// 验收（钳制收敛）：Agent 回显 adopted 列表把 requested 钳制为实际值时，
/// 会话状态（current/pending/catalog）一致收敛到 Agent 实际值，且不补发第二次
/// set-config RPC（钳制不是新请求的触发器）。
#[tokio::test]
async fn clamped_switch_converges_to_agent_settled_value() {
    let trace = TraceFile::new("ms-clamp");
    let (app, runtime) = config_option_app(trace.path(), "echo-adopted:m-1", None).await;
    create_session(&app, "ms-agent", "local:ms").await;

    set_config_option(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "model".to_string(),
        serde_json::json!("m-2"),
    )
    .await
    .expect("钳制不是传输失败");

    let session = runtime
        .sessions
        .lock()
        .unwrap()
        .get("local:ms")
        .cloned()
        .unwrap();
    assert_eq!(session.model, "m-1", "最终状态必须回到 Agent 实际值");
    assert_eq!(session.model_pending, None, "权威回显清除未确认态");
    assert_eq!(
        session.model_choices,
        vec!["m-1".to_string(), "m-2".to_string()]
    );
    // 评审补强：钳制收敛后不得补发第二次 set-config（防 set-config loop）。
    let switches = read_trace_methods(trace.path())
        .into_iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .count();
    assert_eq!(switches, 1, "钳制后禁止补偿 RPC");
}

/// 验收（Agent 拒绝）：set_config_option 被 Agent 以 JSON-RPC error 拒绝时，命令
/// 上抛错误、本地状态不变、不重试（trace 恰一次请求）。
#[tokio::test]
async fn agent_rejected_switch_propagates_error_without_state_change() {
    let trace = TraceFile::new("ms-agent-reject");
    let (app, runtime) = config_option_app(trace.path(), "reject", None).await;
    create_session(&app, "ms-agent", "local:ms").await;

    let error = set_config_option(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "model".to_string(),
        serde_json::json!("m-2"),
    )
    .await
    .expect_err("Agent 拒绝必须上抛");

    assert!(error.to_string().contains("rejected"), "{error}");
    let session = runtime
        .sessions
        .lock()
        .unwrap()
        .get("local:ms")
        .cloned()
        .unwrap();
    assert_eq!(session.model, "m-1", "拒绝后 current 保持 Agent 原值");
    assert_eq!(session.model_pending, None, "失败不得留下未确认态");
    let switches = read_trace_methods(trace.path())
        .into_iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .count();
    assert_eq!(switches, 1, "拒绝后不得重试");
}

/// 验收 8（依赖 option 发送校验接线）：reasoning 组在会话宣告 choices 时发送前
/// 校验——失效值被拒且不上 wire；仍被广告的值原样上 wire。
#[tokio::test]
async fn reasoning_switch_is_validated_against_advertised_choices() {
    let trace = TraceFile::new("ms-reasoning");
    let (app, runtime) = config_option_app(trace.path(), "echo-empty", None).await;
    create_session(&app, "ms-agent", "local:ms").await;

    // 失效值（宣告的 reasoning choices 只有 low/high）：发送前被拒。
    let error = set_config_option(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "reasoning_effort".to_string(),
        serde_json::json!("ultra"),
    )
    .await
    .expect_err("未广告 reasoning 值必须被拒");
    assert!(error.to_string().contains("reasoning_not_advertised"));

    // 仍被广告的值：放行并按语义键上 wire（reasoning 键即 config id，现状行为）。
    set_config_option(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "reasoning_effort".to_string(),
        serde_json::json!("high"),
    )
    .await
    .expect("广告内的 reasoning 值必须放行");

    let switches: Vec<serde_json::Value> = read_trace_methods(trace.path())
        .into_iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .map(|(_, params)| params)
        .collect();
    assert_eq!(switches.len(), 1, "被拒请求不得上 wire，放行请求恰一次");
    assert_eq!(
        switches[0].get("configId").and_then(|v| v.as_str()),
        Some("reasoning_effort")
    );
    assert_eq!(switches[0].get("value"), Some(&serde_json::json!("high")));
    let session = runtime
        .sessions
        .lock()
        .unwrap()
        .get("local:ms")
        .cloned()
        .unwrap();
    assert_eq!(session.model, "m-1", "reasoning 切换不影响 model 通道");
}

/// 验收（generation 过期丢弃回写）：RPC 在途时 client generation 前进——响应
/// 到达后写回必须被整体丢弃（current/pending 不变），命令以 stale generation
/// 错误失败，且请求本身确实上过 wire。
#[tokio::test]
async fn stale_generation_discards_switch_write_back() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let ready = std::env::temp_dir().join(format!(
        "pylon-ms-gen-{}-{unique}.ready",
        std::process::id()
    ));
    let release = ready.with_extension("release");
    std::fs::remove_file(&ready).ok();
    std::fs::remove_file(&release).ok();
    let _signals = SignalFiles(vec![ready.clone(), release.clone()]);
    let trace = TraceFile::new("ms-stale-gen");
    let (app, runtime) = config_option_app(
        trace.path(),
        "barrier",
        Some((
            ready.to_string_lossy().into_owned(),
            release.to_string_lossy().into_owned(),
        )),
    )
    .await;
    create_session(&app, "ms-agent", "local:ms").await;

    // 后台任务：等 agent 触 ready（set_config_option 已上 wire 且挂起），然后
    // 前进 client generation（模拟 RPC 在途期间客户端被替换），再放行响应。
    let racer = {
        let runtime = runtime.clone();
        let ready = ready.clone();
        let release = release.clone();
        tokio::spawn(async move {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !ready.exists() {
                if std::time::Instant::now() > deadline {
                    panic!("barrier ready timeout");
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            runtime.client_generation.fetch_add(1, Ordering::AcqRel);
            std::fs::write(&release, b"go").expect("write release");
        })
    };

    let result = set_config_option(
        app.state::<AppState>(),
        "ms-agent".to_string(),
        "local:ms".to_string(),
        "model".to_string(),
        serde_json::json!("m-2"),
    )
    .await;
    racer.await.expect("racer must not panic");

    let error = result.expect_err("RPC 在途换代后写回必须被拒");
    assert!(
        error.to_string().contains("stale ACP client generation"),
        "{error}"
    );
    let session = runtime
        .sessions
        .lock()
        .unwrap()
        .get("local:ms")
        .cloned()
        .unwrap();
    assert_eq!(session.model, "m-1", "过期响应不得写回 current");
    assert_eq!(session.model_pending, None, "过期响应不得留下未确认态");
    let switches = read_trace_methods(trace.path())
        .into_iter()
        .filter(|(method, _)| method == "session/set_config_option")
        .count();
    assert_eq!(switches, 1, "请求确实上过 wire（被测的是写回丢弃）");
}

/// 验收（跨 runtime/Agent 重绑不泄漏）：同一 source 在不同 Agent runtime 上重建
/// 会话时，新 selector snapshot 不得沿用旧 Agent 的 config id/model id/choices。
#[tokio::test]
async fn rebind_on_other_runtime_starts_with_clean_selector_snapshot() {
    let trace_a = TraceFile::new("ms-rebind-a");
    let _trace_b = TraceFile::new("ms-rebind-b");
    let mut agent_a = crate::test_utils::fake_acp_agent(
        "rebind-a",
        &[
            "--scenario",
            "set-config-option",
            "--mode",
            "echo-empty",
            "--trace-file",
            &trace_a.path().to_string_lossy(),
            "--trace-mode",
            "all",
        ],
    );
    agent_a.acp = Some(AcpProtocolConfig {
        set_model_api: Some(SetModelApi::ConfigOption),
        ..Default::default()
    });
    let agent_b = crate::test_utils::fake_acp_agent(
        "rebind-b",
        &["--scenario", "empty", "--session-id", "empty-session"],
    );
    let runtime_a = AgentRuntime::new_disconnected();
    *runtime_a.acp.lock().await = AcpClient::connect_with_logs(&agent_a, None)
        .await
        .expect("fake ACP must initialize");
    let runtime_b = AgentRuntime::new_disconnected();
    *runtime_b.acp.lock().await = AcpClient::connect_with_logs(&agent_b, None)
        .await
        .expect("fake ACP must initialize");
    let state = TestStateBuilder::bare()
        .with_active_agent("rebind-a")
        .with_agent(agent_a)
        .with_agent(agent_b)
        .with_runtime("rebind-a", runtime_a.clone())
        .with_runtime("rebind-b", runtime_b.clone())
        .build();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app must build");
    app.manage(state);

    // runtime A：带模型目录的会话。
    create_session(&app, "rebind-a", "local:rebind").await;
    // runtime B：同一 source 重建（不同 agent、无模型宣告）。
    create_session(&app, "rebind-b", "local:rebind").await;

    let snapshot_b = runtime_b
        .sessions
        .lock()
        .unwrap()
        .get("local:rebind")
        .cloned()
        .unwrap();
    assert_eq!(
        snapshot_b.model_surface,
        ModelSurface::None,
        "新 owner 空面"
    );
    assert!(
        snapshot_b.model_choices.is_empty(),
        "旧 Agent choices 不得泄漏"
    );
    assert_eq!(snapshot_b.model, "", "旧 Agent model id 不得泄漏");
    assert!(
        !serde_json::to_string(&snapshot_b.config_options)
            .unwrap()
            .contains("model-selection"),
        "旧 Agent config id 不得泄漏：{:?}",
        snapshot_b.config_options
    );
    // runtime A 的会话不受影响（per-runtime sessions 隔离）。
    let snapshot_a = runtime_a
        .sessions
        .lock()
        .unwrap()
        .get("local:rebind")
        .cloned()
        .unwrap();
    assert_eq!(
        snapshot_a.model_surface,
        ModelSurface::ConfigOption {
            config_id: "model-selection".to_string()
        }
    );
}

/// 验收（reconnect replay + 根级列表）：session/load 复活期不发任何 selector RPC
/// （Agent 推送优先、模型先于依赖 option 的一次性 restore），根级
/// availableModels 进入 SessionInfo 模型面。
#[tokio::test]
async fn load_revive_applies_root_level_catalog_without_selector_rpcs() {
    let trace = TraceFile::new("ms-revive");
    let advertise = serde_json::json!({
        "sessionId": "remote-original",
        "availableModels": [
            {"modelId": "root:alpha", "name": "Alpha"},
            {"modelId": "root:beta", "name": "Beta"}
        ],
        "currentModelId": "root:beta",
        "configOptions": [{
            "id": "reasoning_effort", "category": "thought_level",
            "options": [{"valueId": "low"}, {"valueId": "high"}], "currentValue": "low"
        }]
    })
    .to_string();
    let agent = crate::test_utils::fake_acp_agent(
        "ms-revive-agent",
        &[
            "--scenario",
            "revive-load",
            "--advertise-models",
            &advertise,
            "--trace-file",
            &trace.path().to_string_lossy(),
            "--trace-mode",
            "all",
        ],
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
    let methods: Vec<String> = read_trace_methods(trace.path())
        .into_iter()
        .map(|(method, _)| method)
        .collect();
    assert!(
        !methods
            .iter()
            .any(|m| m == "session/set_config_option" || m == "session/set_model"),
        "复活期不得自动补发 selector RPC：{methods:?}"
    );
}
