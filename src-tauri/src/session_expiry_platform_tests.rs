use super::*;

const ECHO_ACP_SCRIPT: &str = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if request.get('method') == 'session/new':
        response['result']={'sessionId':'expiry-session'}
    print(json.dumps(response), flush=True)
"#;

fn echo_agent() -> AgentDef {
    crate::test_utils::fake_acp_agent("fake-acp-echo", ECHO_ACP_SCRIPT)
}

#[tokio::test]
async fn expiry_watcher_skips_local_sessions_and_resets_platform_sessions() {
    let agent = echo_agent();
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let gateway = Arc::new(gateway::GatewayCore::from_config(
        gateway::route::parse_config(
            r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
        )
        .expect("合法配置"),
    ));
    let state = crate::test_utils::test_state_with_acp(
        agent,
        initial_acp,
        gateway,
        prism::PrismClient::unavailable("test".to_string()),
    )
    .await;

    let runtime = state.active_runtime().expect("active runtime");
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        // 插入过期/平台两类会话
        sessions.clear();
        let mut local = SessionInfo::new("local-peri".into(), String::new(), ".".into(), true, 0);
        local.updated_at = Some(Timestamp::new(1)); // 1970 年，必然过期
        sessions.insert("local".to_string(), local);
        let mut platform =
            SessionInfo::new("platform-peri".into(), String::new(), ".".into(), true, 0);
        platform.updated_at = Some(Timestamp::new(1));
        sessions.insert("qq:group:123".to_string(), platform);
    }

    check_session_expiry(&state).await;

    let sessions = runtime.sessions.lock().unwrap();
    assert!(
        sessions.contains_key("local"),
        "GUI local 会话必须豁免过期重置"
    );
    assert!(
        !sessions.contains_key("qq:group:123"),
        "平台会话过期必须 close + 移除"
    );
}

/// A4 TOCTOU 回归：快照（过期）与删除复核之间 updated_at 被新消息刷新
/// → watcher 不得误杀该会话（旧实现复核只查 peri_id/generation，会误删）。
#[tokio::test]
async fn expiry_watcher_keeps_session_refreshed_after_snapshot() {
    let agent = echo_agent();
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let gateway = Arc::new(gateway::GatewayCore::from_config(
        gateway::route::parse_config(
            r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
        )
        .expect("合法配置"),
    ));
    let state = Arc::new(
        crate::test_utils::test_state_with_acp(
            agent,
            initial_acp,
            gateway,
            prism::PrismClient::unavailable("test".to_string()),
        )
        .await,
    );
    let runtime = state.active_runtime().expect("active runtime");
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        sessions.clear();
        let mut platform =
            SessionInfo::new("platform-peri".into(), String::new(), ".".into(), true, 0);
        platform.updated_at = Some(Timestamp::new(1)); // 1970 年，快照视角必然过期
        sessions.insert("qq:group:123".to_string(), platform);
        // 大量非平台填充会话：拉长快照持锁窗口，主线程才能稳定观察到快照阶段。
        for i in 0..50_000 {
            let mut filler = SessionInfo::new(
                format!("local-fill-{i}"),
                String::new(),
                ".".into(),
                true,
                0,
            );
            filler.updated_at = Some(Timestamp::new(1));
            sessions.insert(format!("local-fill-{i}"), filler);
        }
    }

    // 主线程先持有 prompt_locks：watcher 在快照后的生成中检查处必然被阻塞，
    // 期间刷新 updated_at 即可精确落在快照之后、删除复核之前（check_session_expiry）。
    let prompt_guard = runtime.prompt_locks.lock().unwrap();
    let state_for_thread = Arc::clone(&state);
    let watcher_thread = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("watcher runtime")
            .block_on(check_session_expiry(&state_for_thread));
    });

    // 握手 1：等待 watcher 进入快照（短暂占用 sessions 锁，50k 填充使窗口足够长）
    let mut snapshot_started = false;
    for _ in 0..100_000_000 {
        if runtime.sessions.try_lock().is_err() {
            snapshot_started = true;
            break;
        }
    }
    assert!(snapshot_started, "watcher 必须已进入快照");
    // 握手 2：等待快照完成（sessions 锁释放；随后 watcher 阻塞在 prompt_locks 上）
    while runtime.sessions.try_lock().is_err() {
        std::thread::yield_now();
    }
    // 快照已取：此刻"新消息到达"刷新 updated_at（与 send_prompt_core 同语义）
    {
        let mut sessions = runtime.sessions.lock().unwrap();
        let session = sessions.get_mut("qq:group:123").expect("目标会话存在");
        session.updated_at = Some(Timestamp::now());
    }
    drop(prompt_guard);
    watcher_thread.join().expect("watcher thread");

    let sessions = runtime.sessions.lock().unwrap();
    assert!(
        sessions.contains_key("qq:group:123"),
        "快照后已刷新的会话不得被 watcher 误杀"
    );
}
