//! P51（重启上下文复活）：ensure_session_mapping 的 ACP session/load 复活优先
//! 回归。用户决策——重启后发送消息必须先尝试复活远端原会话（原生 ACP 能力），
//! 失败才允许新建，且新建必须显式告知（recreated_peri_id out-param）。
//! 历史会话在 provider 端不再随每次重启膨胀。
use super::*;
use crate::test_utils::fake_acp_agent;

/// session/load 命中（返回已存在 sessionId）→ 复用，不新建。
#[tokio::test]
async fn ensure_session_mapping_revives_via_session_load_before_creating() {
    const FAKE_SCRIPT: &str = r#"import json,sys
for line in sys.stdin:
    request = json.loads(line)
    response = {'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    method = request.get('method')
    if method == 'session/new':
        response['result'] = {'sessionId':'newly-created'}
    elif method == 'session/load':
        response['result'] = {'sessionId': request['params']['sessionId']}
    print(json.dumps(response), flush=True)
"#;
    let agent = fake_acp_agent("revive-agent", FAKE_SCRIPT);
    let runtime = AgentRuntime::new_disconnected();
    *runtime.acp.lock().await = crate::acp::AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("revive-agent")
        .with_agent(agent)
        .with_runtime("revive-agent", runtime.clone())
        .build();

    let mut recreated = None;
    let mapping = ensure_session_mapping(
        &state,
        &runtime,
        "local:revive",
        Some("profile-r"),
        "persona",
        ".",
        &[],
        Some("peri-original"),
        &mut recreated,
    )
    .await
    .expect("revive must succeed");

    assert_eq!(mapping.peri_id, "peri-original", "revived mapping keeps the persisted remote session id");
    assert_eq!(mapping.is_first, false);
    assert!(recreated.is_none(), "no recreation notice when the remote session is revived");
    assert_eq!(
        runtime.sessions.lock().unwrap().get("local:revive").map(|s| s.peri_id.clone()),
        Some("peri-original".to_string()),
        "in-memory slot is re-attached to the revived session"
    );
}

/// session/load 失败（provider 端会话已死）→ 降级新建 + recreated 通知。
#[tokio::test]
async fn ensure_session_mapping_falls_back_to_new_with_notice_when_load_fails() {
    const FAKE_SCRIPT: &str = r#"import json,sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method == 'session/load':
        # remote session is gone: JSON-RPC error
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'error':{'code':-32000,'message':'session not found'}}), flush=True)
        continue
    response = {'jsonrpc':'2.0','id':request.get('id'),'result':{'sessionId':'fresh-session'}}
    print(json.dumps(response), flush=True)
"#;
    let agent = fake_acp_agent("fallback-agent", FAKE_SCRIPT);
    let runtime = AgentRuntime::new_disconnected();
    *runtime.acp.lock().await = crate::acp::AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("fallback-agent")
        .with_agent(agent)
        .with_runtime("fallback-agent", runtime.clone())
        .build();

    let mut recreated = None;
    let mapping = ensure_session_mapping(
        &state,
        &runtime,
        "local:fallback",
        Some("profile-f"),
        "persona",
        ".",
        &[],
        Some("peri-dead"),
        &mut recreated,
    )
    .await
    .expect("fallback creation must succeed");

    assert_eq!(mapping.peri_id, "fresh-session");
    assert_eq!(recreated.as_deref(), Some("fresh-session"), "caller is told the session was recreated with a new remote id");
}

/// 无持久化 peri_id（None）→ 直接新建，行为与旧版一致。
#[tokio::test]
async fn ensure_session_mapping_without_peri_id_creates_directly() {
    const FAKE_SCRIPT: &str = r#"import json,sys
for line in sys.stdin:
    request = json.loads(line)
    response = {'jsonrpc':'2.0','id':request.get('id'),'result':{'sessionId':'direct-new'}}
    print(json.dumps(response), flush=True)
"#;
    let agent = fake_acp_agent("direct-agent", FAKE_SCRIPT);
    let runtime = AgentRuntime::new_disconnected();
    *runtime.acp.lock().await = crate::acp::AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("direct-agent")
        .with_agent(agent)
        .with_runtime("direct-agent", runtime.clone())
        .build();

    let mut recreated = None;
    let mapping = ensure_session_mapping(
        &state,
        &runtime,
        "local:direct",
        None,
        "",
        ".",
        &[],
        None,
        &mut recreated,
    )
    .await
    .expect("direct creation must succeed");

    assert_eq!(mapping.peri_id, "direct-new");
    assert!(recreated.is_some(), "recreation notice is also emitted for the no-peri-id creation path");
}
