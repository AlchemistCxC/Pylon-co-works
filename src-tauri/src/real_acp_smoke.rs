//! 真实 ACP agent 冒烟测试（方案 §13.4 验收门禁，默认 ignore——依赖真实 agent）。
//!
//! 面向 ACP 协议而非单个 agent：被测试的 agent 从**生效配置**读取
//! （`effective_config_path` → agents.yaml 的 `default: true` agent），
//! 换 agent 只需改 agents.yaml，本测试零改动。wire 断言（initialize/session/new/
//! prompt/cancel/进程树）全部是协议层通用检查。
//!
//! initialize/session/new 不调用模型 API（正常 agent authMethods 为空），无 API 消耗。
//! prompt 往返（级 2）消耗模型调用，需 agent 的模型凭据可用。
//!
//! 运行：cargo test --lib real_acp -- --ignored --nocapture

use crate::acp::AcpClient;
use crate::agent_config::AgentDef;

/// 从生效配置读取指定 id 的 agent（不硬编码路径；agent 缺失时测试失败）。
fn configured_agent(id: &str) -> AgentDef {
    let agents = crate::agent_config::load().expect("生效 agents.yaml 必须可解析");
    agents.get(id).expect("指定 agent 必须存在").clone()
}

/// 从生效配置读取 default agent（不硬编码任何 agent；agents.yaml 缺 default 时测试失败）。
fn default_acp_agent() -> AgentDef {
    let agents = crate::agent_config::load().expect("生效 agents.yaml 必须可解析");
    let id = crate::agent_config::default_agent_id(&agents)
        .expect("default agent 解析必须成功")
        .expect("agents.yaml 必须声明 default: true 的 agent");
    let agent = agents.get(&id).expect("default agent 必须存在").clone();
    if agent.transport != "subprocess" {
        panic!("default agent {id} 不是 subprocess transport——本测试只覆盖 ACP subprocess 链路");
    }
    agent
}

#[tokio::test]
#[ignore]
async fn real_agent_initialize_new_session_and_process_cleanup() {
    let agent = default_acp_agent();
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("真实 agent 必须 initialize 成功");
    let child_pid = client.child_id().expect("connect 后必须持有真实子进程");

    // session/new 握手（协议层，不调模型）
    let cwd = agent.cwd.clone().unwrap_or_else(|| ".".to_string());
    let params = crate::acp::session_new_params(
        &cwd,
        Vec::new(),
        crate::agent_config::McpServersMode::Always,
    )
    .expect("session/new 参数构造");
    let session_id = client
        .prepare_rpc(crate::acp::METHOD_SESSION_NEW, params)
        .expect("prepare session/new")
        .complete()
        .await
        .expect("session/new 必须成功");
    let session_id = crate::acp::session_id_from(&session_id).expect("sessionId 必须合法");
    tracing::info!("真实 agent session/new -> {session_id}");

    // kill → 直接子进程必须退出（R9 进程树清理）
    let mut client = client;
    client.kill().expect("kill 必须成功");
    std::thread::sleep(std::time::Duration::from_millis(300));
    let alive = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {child_pid}"), "/NH"])
        .output()
        .map(|output| {
            let text = String::from_utf8_lossy(&output.stdout);
            !text.trim().is_empty()
                && !text.contains("没有运行的任务")
                && !text.contains("INFO: No tasks")
        })
        .unwrap_or(true);
    assert!(!alive, "kill 后直接子进程 (pid={child_pid}) 必须被回收");
    tracing::info!("真实 agent 进程树清理 OK (pid={child_pid})");
}

#[tokio::test]
#[ignore]
async fn real_agent_prompt_round_trip() {
    // 级 2：真实 prompt 往返（消耗模型 API）。失败多因凭据/网络，不视为进程树
    // 回归——进程树回归由上一测试覆盖。
    let agent = default_acp_agent();
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("真实 agent 必须 initialize 成功");
    let cwd = agent.cwd.clone().unwrap_or_else(|| ".".to_string());
    let params = crate::acp::session_new_params(
        &cwd,
        Vec::new(),
        crate::agent_config::McpServersMode::Always,
    )
    .expect("session/new 参数构造");
    let session_id = client
        .prepare_rpc(crate::acp::METHOD_SESSION_NEW, params)
        .expect("prepare")
        .complete()
        .await
        .expect("session/new 成功");
    let session_id = crate::acp::session_id_from(&session_id).expect("sessionId");

    let rpc = client
        .prepare_prompt(
            &session_id,
            vec![serde_json::json!({"type": "text", "text": "回复两个字：收到"})],
        )
        .expect("prepare prompt");
    let mut response_rx = rpc.send_keep_rx().await.expect("prompt 必须写入 stdin");
    let outcome = crate::acp::wait_prompt_with_cancel(
        &mut response_rx,
        std::time::Duration::from_secs(120),
        std::time::Duration::from_secs(30),
        || async {
            client
                .cancel_session(&session_id)
                .await
                .map_err(|e| e.to_string())
        },
    )
    .await;
    match outcome {
        crate::acp::PromptWaitOutcome::Response(raw) => {
            let stop = crate::acp::prompt_stop_reason(
                raw.result.as_ref().expect("prompt 响应必须有 result"),
            )
            .expect("stopReason 必须合法");
            tracing::info!("真实 agent prompt -> stopReason={stop}");
        }
        other => panic!("真实 agent prompt 未正常结算: {other:?}"),
    }
}

/// 验收回归（Hermes 无回应调查）：connect 后 idle 期间 stdout 不得被误判关闭。
/// 实测 Hermes 首 token 延迟可达 ~92s；本测试确认连接本身稳定（不产生假崩溃）。
/// 运行：cargo test --lib hermes_connect_idle -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn hermes_connect_idle_no_false_crash() {
    let agent = configured_agent("hermes");
    let mut client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("Hermes ACP 必须 initialize 成功");
    let mut crashed_rx = client.crashed_receiver();
    // 等待 5s：若 stdout 被误判 EOF,crashed watch 会变 true
    tokio::select! {
        changed = crashed_rx.changed() => {
            match changed {
                Ok(()) => panic!("Hermes crashed during idle: watch=true, crashed={}", client.is_crashed()),
                Err(e) => tracing::warn!("crashed channel closed: {e}"),
            }
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
            tracing::info!("Hermes idle 5s: no crash, stdout alive");
        }
    }
    assert!(!client.is_crashed(), "Hermes 不得在 idle 期间被判 crashed");
    client.kill().expect("cleanup");
}

/// 方案 G 演进端到端：Hermes agent（配置了 `hermes_profile`）真实 prompt。
/// 验证 `hermes_profile` → `HERMES_HOME=<profile 目录>` 注入后 Hermes 使用
/// 指定 profile 的 provider/密钥（而非 active_profile 机制）。依赖真实 Hermes
/// 安装与有效凭据；本机 active_profile=profile-x（provider 无效）时，本测试成功即
/// 证明注入生效（否则 401/无回应）。
/// 运行：cargo test --lib hermes_real -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn hermes_configured_profile_real_prompt_round_trip() {
    let agent = configured_agent("hermes");
    if agent.hermes_profile.is_none() {
        panic!("hermes agent 未配置 hermes_profile——本测试验证注入，必须先配置");
    }
    let client = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("Hermes ACP 必须 initialize 成功（注入 HERMES_HOME 后）");
    let cwd = agent.cwd.clone().unwrap_or_else(|| ".".to_string());
    let params = crate::acp::session_new_params(
        &cwd,
        Vec::new(),
        crate::agent_config::McpServersMode::Always,
    )
    .expect("session/new 参数构造");
    let session_id = client
        .prepare_rpc(crate::acp::METHOD_SESSION_NEW, params)
        .expect("prepare")
        .complete()
        .await
        .expect("session/new 必须成功");
    let session_id = crate::acp::session_id_from(&session_id).expect("sessionId");

    let rpc = client
        .prepare_prompt(
            &session_id,
            vec![serde_json::json!({"type": "text", "text": "回复两个字：收到"})],
        )
        .expect("prepare prompt");
    let mut response_rx = rpc.send_keep_rx().await.expect("prompt 必须写入 stdin");
    let outcome = crate::acp::wait_prompt_with_cancel(
        &mut response_rx,
        std::time::Duration::from_secs(120),
        std::time::Duration::from_secs(30),
        || async {
            client
                .cancel_session(&session_id)
                .await
                .map_err(|e| e.to_string())
        },
    )
    .await;
    match outcome {
        crate::acp::PromptWaitOutcome::Response(raw) => {
            let stop = crate::acp::prompt_stop_reason(
                raw.result.as_ref().expect("prompt 响应必须有 result"),
            )
            .expect("stopReason 必须合法");
            tracing::info!("Hermes prompt -> stopReason={stop}");
        }
        other => panic!("Hermes prompt 未正常结算: {other:?}"),
    }
}
