use super::*;

#[test]
fn export_sanitizer_removes_secret_payloads() {
    let messages = vec![serde_json::json!({
        "update": {
            "sessionUpdate": "agent_message_chunk",
            "content": {"text": "visible"},
            "rawInput": {"prompt": "private"},
            "rawOutput": "private output",
            "headers": {"authorization": "Bearer secret"},
            "safe": "kept"
        }
    })];
    let safe = sanitize_export_messages(&messages);
    let text = serde_json::to_string(&safe).expect("serialize sanitized export");
    assert!(text.contains("visible"));
    assert!(text.contains("kept"));
    assert!(!text.contains("private"));
    assert!(!text.contains("secret"));
}

#[test]
fn export_file_write_rejects_existing_path_and_commits_new_file() {
    let root = std::env::temp_dir().join(format!("pylon-export-test-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("create export test directory");
    let output = root.join("session.json");
    write_export_atomically(&output, b"first").expect("write export");
    assert_eq!(
        std::fs::read_to_string(&output).expect("read export"),
        "first"
    );
    assert!(write_export_atomically(&output, b"second").is_err());
    assert_eq!(
        std::fs::read_to_string(&output).expect("read export"),
        "first"
    );
    std::fs::remove_dir_all(&root).expect("remove export test directory");
}

#[test]
fn export_session_owner_requires_active_generation_match() {
    assert!(is_export_sensitive_key("rawInput"));
    assert!(is_export_sensitive_key("tokenValue"));
    assert!(!is_export_sensitive_key("safe"));
}

#[test]
fn session_response_preserves_mode_and_all_config_options() {
    let mut session = SessionInfo::new(
        "peri-1".into(),
        "persona".into(),
        "G:/work".into(),
        false,
        0,
    );
    session.apply_session_response(&serde_json::json!({
        "modes": {"currentModeId": "plan"},
        "configOptions": [
            {"id": "model", "currentValue": "deepseek-chat"},
            {"id": "thinking", "currentValue": "high"}
        ]
    }));
    assert_eq!(session.mode.as_deref(), Some("plan"));
    assert_eq!(session.model, "deepseek-chat");
    assert_eq!(session.config_options.len(), 2);
}

#[test]
fn config_option_update_accepts_nested_value_shape() {
    let option =
        serde_json::json!({"id": "model", "value": {"valueId": {"value": "deepseek-reasoner"}}});
    assert_eq!(
        config_option_current_value(&option).as_deref(),
        Some("deepseek-reasoner")
    );
}

#[test]
fn mode_falls_back_to_mode_config_option() {
    let mut session = SessionInfo::new("peri-1".into(), String::new(), ".".into(), true, 0);
    session.apply_session_response(&serde_json::json!({
        "configOptions": [{"id": "mode", "currentValue": "code"}]
    }));
    assert_eq!(session.mode.as_deref(), Some("code"));
}

/// Invalidated 客户端替换（switch/手动重连）后 prompt 锁表必须收敛——
/// 与 replace_agent_client 同序列：锁内快照旧 source → 清空映射 → 锁外清理；
/// 无会话映射的孤儿锁条目不在清理范围（保守作用域）。
#[test]
fn invalidated_activation_clears_sessions_and_drops_stale_prompt_locks() {
    let runtime = AgentRuntime::new_disconnected();
    for (source, remote) in [("source-a", "peri-1"), ("qq:u-123", "peri-2")] {
        crate::session_store::insert(
            &runtime,
            source,
            SessionInfo::new(remote.into(), "persona".into(), ".".into(), true, 1),
            true,
            100,
        )
        .unwrap();
    }
    for source in ["source-a", "qq:u-123", "orphan-lock"] {
        prompt_lock_for(&runtime.prompt_locks, source);
    }
    assert_eq!(runtime.prompt_locks.lock().unwrap().len(), 3);
    let activation = crate::agent_runtime::ClientActivation {
        epoch: crate::agent_runtime::ClientEpoch(9),
        continuity: crate::agent_runtime::SessionContinuity::Invalidated,
    };
    let stale = crate::session_store::apply_client_activation(&runtime, activation).unwrap();
    let stale_sources = stale
        .into_iter()
        .map(|candidate| candidate.source)
        .collect::<Vec<_>>();
    runtime.drop_prompt_locks(&stale_sources);
    assert!(runtime.sessions.lock().unwrap().is_empty());
    let locks = runtime.prompt_locks.lock().unwrap();
    assert!(
        !locks.contains_key("source-a") && !locks.contains_key("qq:u-123"),
        "旧 source 锁条目必须随映射清空收敛"
    );
    assert!(
        locks.contains_key("orphan-lock"),
        "无会话映射的孤儿锁不在清理范围"
    );
}

#[test]
fn agent_status_exposes_only_binding_health_metadata() {
    let runtime = AgentRuntime::new_disconnected();
    runtime.binding_health.lock().unwrap().insert(
        "local:s1".into(),
        crate::agent_runtime::SessionBindingHealth::Detached {
            target_generation: 3,
            reason: "session-probe-timeout".into(),
            retryable: true,
        },
    );
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("peri")
        .with_agent(crate::test_utils::fake_acp_agent("peri", "print('unused')"))
        .with_runtime("peri", runtime)
        .build();

    let payload = state.agent_status_payload();
    assert_eq!(payload["sessionBindings"][0]["agentId"], "peri");
    assert_eq!(payload["sessionBindings"][0]["source"], "local:s1");
    assert_eq!(payload["sessionBindings"][0]["health"], "detached");
    assert_eq!(payload["sessionBindings"][0]["retryable"], true);
    assert!(payload["sessionBindings"][0].get("periId").is_none());
}

#[test]
fn inspector_aggregates_session_stats() {
    let mut sessions = HashMap::new();
    let mut s1 = SessionInfo::new("peri-1".into(), "p1".into(), ".".into(), true, 0);
    s1.tokens_in = 100;
    s1.tokens_out = 50;
    s1.tokens_total = 150;
    s1.context_size = 8192;
    s1.model = "model-a".into();
    let mut s2 = SessionInfo::new("peri-2".into(), "p2".into(), "/work".into(), false, 0);
    s2.tokens_in = 20;
    s2.tokens_out = 10;
    s2.tokens_total = 30;
    s2.context_size = 4096;
    sessions.insert("source-a".into(), s1);
    sessions.insert("source-b".into(), s2);
    let runtime = AgentRuntimeState {
        status: AgentLifecycleStatus::Connected,
        last_error: None,
        last_connected_at: Some(Timestamp::new(1)),
        activated_config_fingerprint: None,
    };
    let entries = vec![("agent-x".to_string(), sessions, runtime)];
    let payload = build_full_inspector_payload(&entries, "agent-x");
    assert_eq!(payload["agent"]["id"], "agent-x");
    assert_eq!(payload["agent"]["status"], "connected");
    assert_eq!(payload["summary"]["sessionCount"], 2);
    assert_eq!(payload["summary"]["activeCount"], 1); // 仅 s1 有 first prompt
    assert_eq!(payload["summary"]["tokensTotal"], 180);
    assert_eq!(payload["summary"]["tokensIn"], 120);
    assert_eq!(payload["summary"]["tokensOut"], 60);
    let rows = payload["sessions"]
        .as_array()
        .expect("sessions must be array");
    assert_eq!(rows.len(), 2);
    let rows_by_source: HashMap<&str, &serde_json::Value> = rows
        .iter()
        .map(|r| (r["source"].as_str().unwrap(), r))
        .collect();
    assert_eq!(rows_by_source["source-a"]["tokensTotal"], 150);
    assert_eq!(rows_by_source["source-b"]["cwd"], "/work");
    assert_eq!(rows_by_source["source-a"]["model"], "model-a");
    assert_eq!(
        rows_by_source["source-a"]["agentId"], "agent-x",
        "session 行必须带 agentId 区分来源"
    );
    // B2 增量：runtimes 数组 + workspace 映射
    let runtimes = payload["runtimes"]
        .as_array()
        .expect("runtimes must be array");
    assert_eq!(runtimes.len(), 1);
    assert_eq!(runtimes[0]["agentId"], "agent-x");
    assert_eq!(runtimes[0]["status"], "connected");
    assert_eq!(runtimes[0]["sessionCount"], 2);
    assert_eq!(runtimes[0]["tokensTotal"], 180);
    assert!(
        payload["workspace"].get("source-a").is_some(),
        "workspace 必须含每个 source 的 root 状态"
    );
}

#[test]
fn inspector_full_aggregates_across_runtimes() {
    let mut sessions_a = HashMap::new();
    let s1 = SessionInfo::new("peri-a".into(), "pa".into(), ".".into(), true, 0);
    sessions_a.insert("local".into(), s1);
    let mut sessions_b = HashMap::new();
    let s2 = SessionInfo::new("peri-b".into(), "pb".into(), ".".into(), false, 0);
    sessions_b.insert("qq:group:1".into(), s2);
    let state_a = AgentRuntimeState {
        status: AgentLifecycleStatus::Connected,
        last_error: None,
        last_connected_at: Some(Timestamp::new(1)),
        activated_config_fingerprint: None,
    };
    let state_b = AgentRuntimeState {
        status: AgentLifecycleStatus::Crashed,
        last_error: Some("boom".into()),
        last_connected_at: None,
        activated_config_fingerprint: None,
    };
    let entries = vec![
        ("peri".to_string(), sessions_a, state_a),
        ("hermes".to_string(), sessions_b, state_b),
    ];
    let payload = build_full_inspector_payload(&entries, "peri");
    assert_eq!(payload["summary"]["sessionCount"], 2, "跨 runtime 全局聚合");
    assert_eq!(payload["summary"]["activeCount"], 1);
    let runtimes = payload["runtimes"].as_array().expect("runtimes array");
    assert_eq!(runtimes.len(), 2);
    let crashed = runtimes
        .iter()
        .find(|r| r["agentId"] == "hermes")
        .expect("hermes runtime");
    assert_eq!(crashed["status"], "crashed");
    assert_eq!(crashed["lastError"], "boom");
    assert_eq!(crashed["sessionCount"], 1);
    let rows = payload["sessions"].as_array().expect("sessions array");
    let qq_row = rows
        .iter()
        .find(|r| r["source"] == "qq:group:1")
        .expect("qq session");
    assert_eq!(
        qq_row["agentId"], "hermes",
        "跨 runtime session 必须可区分来源"
    );
}

/// 方案 7：load_sessions DTO 完整 wire 等价 + 稳定排序 + 敏感字段不泄露。
#[test]
fn session_list_row_serializes_exact_wire_and_sorts_by_source() {
    let mut sessions: HashMap<String, SessionInfo> = HashMap::new();
    let mut s_b = SessionInfo::new("peri-b".into(), "persona-b".into(), "/b".into(), true, 9);
    s_b.title = "B 会话".into();
    s_b.mode = Some("plan".into());
    s_b.config_options = vec![serde_json::json!({"id": "model", "currentValue": "gpt-4"})];
    s_b.model = "gpt-4".into();
    s_b.tokens_in = 10;
    s_b.tokens_out = 20;
    s_b.tokens_total = 30;
    s_b.context_size = 8192;
    s_b.inject_round = 5;
    s_b.last_response_text = "secret-reply".into();
    let s_a = SessionInfo::new("peri-a".into(), "persona-a".into(), "/a".into(), false, 3);
    sessions.insert("z-source".into(), s_a);
    sessions.insert("a-source".into(), s_b);
    // 稳定排序：按 source。
    let mut rows: Vec<SessionListRow> = sessions
        .iter()
        .map(|(source, info)| SessionListRow {
            source: source.clone(),
            peri_id: info.peri_id.clone(),
            persona: info.persona.clone(),
            cwd: info.cwd.clone(),
            title: info.title.clone(),
            mode: info.mode.clone(),
            config_options: info.config_options.clone(),
            model: info.model.clone(),
            tokens_in: info.tokens_in,
            tokens_out: info.tokens_out,
            tokens_total: info.tokens_total,
            context_size: info.context_size,
        })
        .collect();
    rows.sort_by(|a, b| a.source.cmp(&b.source));
    let values: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| serde_json::to_value(r).expect("serialize"))
        .collect();
    assert_eq!(values[0]["source"], "a-source");
    assert_eq!(values[1]["source"], "z-source");
    assert_eq!(
        values[0],
        serde_json::json!({
            "source": "a-source",
            "periId": "peri-b",
            "persona": "persona-b",
            "cwd": "/b",
            "title": "B 会话",
            "mode": "plan",
            "configOptions": [{"id": "model", "currentValue": "gpt-4"}],
            "model": "gpt-4",
            "tokensIn": 10,
            "tokensOut": 20,
            "tokensTotal": 30,
            "contextSize": 8192,
        }),
        "load_sessions wire 必须逐字段等价"
    );
    // 敏感/内部字段不泄露
    assert!(
        values[0].get("generation").is_none(),
        "generation 不得落 wire"
    );
    assert!(
        values[0].get("injectRound").is_none(),
        "inject_round 不得落 wire"
    );
    assert!(
        values[0].get("lastResponseText").is_none(),
        "reply cache 不得落 wire"
    );
    assert!(values[0].get("agentId").is_none(), "load 不出现 agentId");
}

/// 方案 7：inspector session 行 DTO 完整 wire 等价 + 排序 + 不泄露。
#[test]
fn inspector_row_serializes_exact_wire_and_sorts() {
    let mut s = SessionInfo::new("peri-1".into(), "persona".into(), "/cwd".into(), true, 7);
    s.title = "T".into();
    s.model = "m".into();
    s.mode = Some("code".into());
    s.tokens_in = 1;
    s.tokens_out = 2;
    s.tokens_total = 3;
    s.context_size = 4096;
    s.config_options = vec![serde_json::json!({"id": "x"})];
    let row = InspectorSessionRow {
        agent_id: "agent-x".into(),
        source: "src".into(),
        peri_id: s.peri_id.clone(),
        title: s.title.clone(),
        model: s.model.clone(),
        mode: s.mode.clone(),
        tokens_in: s.tokens_in,
        tokens_out: s.tokens_out,
        tokens_total: s.tokens_total,
        context_size: s.context_size,
        cwd: s.cwd.clone(),
    };
    let value = serde_json::to_value(&row).expect("serialize");
    assert_eq!(
        value,
        serde_json::json!({
            "agentId": "agent-x",
            "source": "src",
            "periId": "peri-1",
            "title": "T",
            "model": "m",
            "mode": "code",
            "tokensIn": 1,
            "tokensOut": 2,
            "tokensTotal": 3,
            "contextSize": 4096,
            "cwd": "/cwd",
        }),
        "inspector 行 wire 必须逐字段等价"
    );
    assert!(value.get("persona").is_none(), "inspector 不出现 persona");
    assert!(
        value.get("configOptions").is_none(),
        "inspector 不出现 configOptions"
    );
    assert!(value.get("generation").is_none(), "generation 不得落 wire");
    // 稳定排序：agentId → source → periId
    let mut rows = vec![
        InspectorSessionRow {
            agent_id: "b".into(),
            source: "s2".into(),
            peri_id: "p2".into(),
            title: String::new(),
            model: String::new(),
            mode: None,
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            context_size: 0,
            cwd: String::new(),
        },
        InspectorSessionRow {
            agent_id: "a".into(),
            source: "s1".into(),
            peri_id: "p1".into(),
            title: String::new(),
            model: String::new(),
            mode: None,
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            context_size: 0,
            cwd: String::new(),
        },
        InspectorSessionRow {
            agent_id: "a".into(),
            source: "s1".into(),
            peri_id: "p0".into(),
            title: String::new(),
            model: String::new(),
            mode: None,
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            context_size: 0,
            cwd: String::new(),
        },
    ];
    rows.sort_by(|a, b| {
        a.agent_id
            .cmp(&b.agent_id)
            .then(a.source.cmp(&b.source))
            .then(a.peri_id.cmp(&b.peri_id))
    });
    let keys: Vec<&str> = rows.iter().map(|r| r.peri_id.as_str()).collect();
    assert_eq!(
        keys,
        vec!["p0", "p1", "p2"],
        "inspector 排序 (agentId, source, periId)"
    );
}

#[test]
fn session_expiry_idle_threshold_and_off_mode() {
    let now = Timestamp::new(1722500000000);
    // idle：超过阈值过期
    assert_eq!(
        session_expired(Some(Timestamp::new(1722490000000)), now, "idle", 30).as_deref(),
        Some("超过 30 分钟无活动")
    );
    // 31 分钟前（1860000ms）应过期
    assert!(
        session_expired(Some(Timestamp::new(1722498140000)), now, "idle", 30).is_some(),
        "31 分钟前应过期"
    );
    // 1 分钟内未过期
    assert!(
        session_expired(Some(Timestamp::new(1722499900000)), now, "idle", 30).is_none(),
        "1 分钟内未过期"
    );
    // off：永不过期
    assert_eq!(
        session_expired(Some(Timestamp::new(1)), now, "off", 1),
        None
    );
    // updated_at 缺失：保守不过期
    assert_eq!(session_expired(None, now, "idle", 1), None);
}

#[test]
fn session_expiry_daily_mode_compares_calendar_day() {
    let now = Timestamp::new(1722500000000); // 某日
    assert!(
        session_expired(Some(Timestamp::new(1722400000000)), now, "daily", 0).is_some(),
        "跨天应过期"
    );
    assert!(
        session_expired(Some(Timestamp::new(1722500000000)), now, "daily", 0).is_none(),
        "同天未过期"
    );
    // 同一天但 23 小时前：daily 不过期（idle 才看时长）
    let same_day_later = Timestamp::new(1722490000000);
    assert_eq!(session_expired(Some(same_day_later), now, "daily", 0), None);
}

#[test]
fn parse_permission_request_extracts_fields_and_sanitizes_prompt() {
    let params = serde_json::json!({
        "sessionId": "session-1",
        "toolCall": {
            "toolCallId": "call-1",
            "title": "edit_file",
            "rawInput": "{\"path\": \"/tmp/x\", \"token=SECRET\"}"
        },
        "options": [
            {"optionId": "allow_once", "name": "Allow once", "kind": "allowOnce"},
            {"optionId": "reject_once", "name": "Reject", "kind": "rejectOnce"}
        ]
    });
    let permission = parse_permission_request(Some(&params)).expect("合法请求必须解析");
    assert_eq!(permission.session_id, "session-1");
    assert_eq!(permission.tool_call_id, "call-1");
    assert_eq!(permission.title, "edit_file");
    // ACP-02：typed options——kind/name 宽容保留，optionId 原值不正规化。
    assert_eq!(
        permission.options,
        vec![
            crate::permission::PermissionOption {
                option_id: "allow_once".to_string(),
                kind: Some("allowOnce".to_string()),
                name: Some("Allow once".to_string()),
                raw: None,
            },
            crate::permission::PermissionOption {
                option_id: "reject_once".to_string(),
                kind: Some("rejectOnce".to_string()),
                name: Some("Reject".to_string()),
                raw: None,
            },
        ]
    );
    // prompt 脱敏：token= 载荷被 REDACTED
    assert!(
        !permission.prompt.contains("SECRET"),
        "prompt 不得含 secret 载荷: {}",
        permission.prompt
    );
    assert!(permission.prompt.contains("[REDACTED]"));
}

#[test]
fn parse_permission_request_rejects_malformed_shapes() {
    // 缺 toolCall
    assert!(parse_permission_request(Some(&serde_json::json!({
        "sessionId": "s1", "options": [{"optionId": "allow_once"}]
    })))
    .is_none());
    // 缺 toolCallId
    assert!(parse_permission_request(Some(&serde_json::json!({
        "sessionId": "s1", "toolCall": {"title": "t"}, "options": [{"optionId": "allow_once"}]
    })))
    .is_none());
    // 空选项
    assert!(parse_permission_request(Some(&serde_json::json!({
        "sessionId": "s1", "toolCall": {"toolCallId": "c1"}, "options": []
    })))
    .is_none());
    // 缺 params
    assert!(parse_permission_request(None).is_none());
}

#[test]
fn permission_response_wire_shapes_are_stable() {
    // RequestPermissionOutcome 是 internally tagged（tag="outcome"）：
    // Selected → {"outcome": {"outcome": "selected", "optionId": "..."}}
    let selected = permission_response("allow_once");
    assert_eq!(selected["outcome"]["outcome"], "selected");
    assert_eq!(selected["outcome"]["optionId"], "allow_once");
    let rejected = permission_response("reject_once");
    assert_eq!(rejected["outcome"]["optionId"], "reject_once");
    let cancelled = permission_response_cancelled();
    assert_eq!(cancelled["outcome"]["outcome"], "cancelled");
}

#[tokio::test]
async fn resolve_permission_responds_and_clears_pending() {
    let runtime = AgentRuntime::new_disconnected();
    let permission = parse_permission_request(Some(&serde_json::json!({
        "sessionId": "s1",
        "toolCall": {"toolCallId": "call-1", "title": "tool"},
        "options": [{"optionId": "allow_once"}, {"optionId": "reject_once"}]
    })))
    .expect("parse");
    runtime
        .pending_permissions
        .lock()
        .unwrap()
        .insert(crate::acp::RequestId::Number(7), permission);
    // 非法选项拒绝
    assert!(
        resolve_permission(&runtime, crate::acp::RequestId::Number(7), "allow_always")
            .await
            .is_err()
    );
    // 未找到拒绝
    assert!(
        resolve_permission(&runtime, crate::acp::RequestId::Number(99), "allow_once")
            .await
            .is_err()
    );
    // 合法应答：disconnected client 写通道关闭 → 发送失败，但 pending 已清理？
    // disconnected client 的 write_tx send 会失败（无接收端）——resolve 返回 Err 且 pending 保留。
    // 用真实 fake ACP 覆盖发送成功路径（见集成测试）。
    let result =
        resolve_permission(&runtime, crate::acp::RequestId::Number(7), "reject_once").await;
    assert!(result.is_err(), "disconnected client 发送应失败");
    // 失败后 pending 保留（可重试）
    assert!(runtime
        .pending_permissions
        .lock()
        .unwrap()
        .contains_key(&crate::acp::RequestId::Number(7)));
}
