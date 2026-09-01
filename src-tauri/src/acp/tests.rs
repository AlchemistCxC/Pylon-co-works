use super::*;
#[cfg(test)]
use crate::agent_config::McpServersMode;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot, watch};



    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// 测试辅助：经 prepare_rpc + complete 创建会话（生产调用点已锁外化）。
    async fn new_session_rpc(client: &AcpClient) -> Result<serde_json::Value, AcpError> {
        client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )?
            .complete()
            .await
    }

    /// 测试辅助：经 prepare_rpc + complete 关闭会话。
    async fn close_session_rpc(client: &AcpClient, session_id: &str) -> Result<(), AcpError> {
        client
            .prepare_rpc(
                METHOD_SESSION_CLOSE,
                serde_json::json!({"sessionId": session_id}),
            )?
            .complete()
            .await?;
        Ok(())
    }

    fn response() -> RawMessage {
        RawMessage {
            id: Some(RequestId::Number(1)),
            method: None,
            kind: AcpKind::Response,
            result: Some(serde_json::json!({"stopReason": "cancelled"})),
            params: None,
            error: None,
        }
    }

    #[test]
    fn acp_kind_classification_is_stable() {
        // B1：wire method 字符串 → 类型化分类契约（dispatcher 匹配依赖）。
        assert_eq!(AcpKind::from_method(None), AcpKind::Response);
        assert_eq!(
            AcpKind::from_method(Some(NOTIF_SESSION_UPDATE)),
            AcpKind::SessionUpdate
        );
        assert_eq!(
            AcpKind::from_method(Some(METHOD_SESSION_REQUEST_PERMISSION)),
            AcpKind::PermissionRequest
        );
        assert_eq!(
            AcpKind::from_method(Some(NOTIF_AGENT_CRASHED)),
            AcpKind::Crashed
        );
        assert_eq!(
            AcpKind::from_method(Some("unknown/method")),
            AcpKind::OtherNotification
        );
    }

    #[test]
    fn disconnected_client_is_not_marked_as_crashed() {
        assert!(!AcpClient::disconnected().is_crashed());
    }

    /// G1-06：close 降级判定类型化——-32601 信封（code 优先）与字符串兜底。
    #[test]
    fn method_not_found_detection() {
        // code 优先解析：-32601 信封命中
        assert!(
            AcpError::Rpc(r#"{"code":-32601,"message":"Method not found"}"#.into())
                .is_method_not_found()
        );
        assert!(AcpError::Rpc(r#"{"code":-32601}"#.into()).is_method_not_found());
        // 字符串兜底：纯文案 / 无 code 信封
        assert!(AcpError::Rpc("RPC error: Method not found".into()).is_method_not_found());
        assert!(AcpError::Rpc("RPC error: -32601".into()).is_method_not_found());
        assert!(AcpError::Rpc(r#"{"message":"Method not found"}"#.into()).is_method_not_found());
        // 非 -32601 错误 → false
        assert!(
            !AcpError::Rpc(r#"{"code":-32602,"message":"Invalid params"}"#.into())
                .is_method_not_found()
        );
        assert!(
            !AcpError::Rpc(r#"{"code":-32000,"message":"session missing"}"#.into())
                .is_method_not_found()
        );
        assert!(!AcpError::Rpc("RPC error: connection closed".into()).is_method_not_found());
        assert!(!AcpError::Rpc("ACP write timeout".into()).is_method_not_found());
        // 非 Rpc 变体 → false
        assert!(!AcpError::ConnectionClosed.is_method_not_found());
        assert!(!AcpError::RpcTimeout.is_method_not_found());
        assert!(!AcpError::WriteTimeout.is_method_not_found());
    }

    #[test]
    fn session_update_variant_wire_strings_are_stable() {
        // 契约锁定：wire 字符串 ↔ 变体映射（前端/平台依赖这些字符串，勿改拼写）。
        assert_eq!(
            SessionUpdateVariant::from_str("agent_message_chunk"),
            Some(SessionUpdateVariant::AgentMessageChunk)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("user_message_chunk"),
            Some(SessionUpdateVariant::UserMessageChunk)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("usage_update"),
            Some(SessionUpdateVariant::UsageUpdate)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("tool_call"),
            Some(SessionUpdateVariant::ToolCall)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("tool_call_update"),
            Some(SessionUpdateVariant::ToolCallUpdate)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("session_info_update"),
            Some(SessionUpdateVariant::SessionInfoUpdate)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("config_option_update"),
            Some(SessionUpdateVariant::ConfigOptionUpdate)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("available_commands_update"),
            Some(SessionUpdateVariant::AvailableCommandsUpdate)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("current_mode_update"),
            Some(SessionUpdateVariant::CurrentModeUpdate)
        );
        assert_eq!(SessionUpdateVariant::from_str("unknown_variant"), None);
    }

    #[test]
    fn load_params_include_mcp_servers_field() {
        assert_eq!(
            load_params(
                "session-1",
                "G:/workspace",
                Vec::new(),
                crate::agent_config::McpServersMode::Always
            )
            .unwrap(),
            serde_json::json!({
                "sessionId": "session-1",
                "cwd": "G:/workspace",
                "mcpServers": [],
            })
        );
    }

    /// G1-07a：OmitIfEmpty 且空数组 → params 无 mcpServers 键（v2 语义）；
    /// 非空数组 → 照常插入。new/load 双路径。
    #[test]
    fn omit_if_empty_mode_omits_empty_field() {
        let params = crate::acp::session_new_params(
            "G:/workspace",
            Vec::new(),
            crate::agent_config::McpServersMode::OmitIfEmpty,
        )
        .unwrap();
        assert!(
            params.get("mcpServers").is_none(),
            "OmitIfEmpty + 空数组必须省略 mcpServers 键: {params}"
        );
        let params = crate::acp::session_new_params(
            "G:/workspace",
            vec![serde_json::json!({"name": "mcp-1"})],
            crate::agent_config::McpServersMode::OmitIfEmpty,
        )
        .unwrap();
        assert_eq!(params["mcpServers"][0]["name"], "mcp-1");
        // load 路径同语义
        let params = load_params(
            "session-1",
            "G:/workspace",
            Vec::new(),
            crate::agent_config::McpServersMode::OmitIfEmpty,
        )
        .unwrap();
        assert!(
            params.get("mcpServers").is_none(),
            "load OmitIfEmpty + 空数组必须省略 mcpServers 键: {params}"
        );
        let params = load_params(
            "session-1",
            "G:/workspace",
            vec![serde_json::json!({"name": "mcp-1"})],
            crate::agent_config::McpServersMode::OmitIfEmpty,
        )
        .unwrap();
        assert_eq!(params["mcpServers"][0]["name"], "mcp-1");
    }

    /// G1-07a：Always = 现状 wire——空数组恒发 mcpServers 字段（new/load 双路径）。
    #[test]
    fn always_mode_keeps_field() {
        let params =
            crate::acp::session_new_params("G:/workspace", Vec::new(), McpServersMode::Always)
                .unwrap();
        assert_eq!(params["mcpServers"], serde_json::json!([]));
        let params = crate::acp::session_new_params(
            "G:/workspace",
            Vec::new(),
            crate::agent_config::McpServersMode::Always,
        )
        .unwrap();
        assert_eq!(params["mcpServers"], serde_json::json!([]));
        let params = load_params(
            "session-1",
            "G:/workspace",
            Vec::new(),
            crate::agent_config::McpServersMode::Always,
        )
        .unwrap();
        assert_eq!(params["mcpServers"], serde_json::json!([]));
    }

    #[test]
    fn rejects_empty_and_error_session_ids() {
        for session_id in ["", "   ", "error", "ERROR"] {
            let response = serde_json::json!({"sessionId": session_id});
            assert!(session_id_from(&response).is_err());
        }
    }

    #[test]
    fn accepts_valid_session_id_after_trimming_whitespace() {
        let response = serde_json::json!({"sessionId": "  session-42  "});
        assert_eq!(session_id_from(&response).unwrap(), "session-42");
    }

    #[test]
    fn validates_prompt_stop_reasons() {
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "end_turn"})),
            Ok("end_turn")
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "max_turn_requests"})),
            Ok("max_turn_requests")
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "cancelled"}))
                .expect_err("cancelled must not complete normally")
                .to_string(),
            "prompt cancelled"
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "refusal"}))
                .expect_err("refusal must not complete normally")
                .to_string(),
            "prompt refused by agent"
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "paused"}))
                .expect_err("unknown stop reason must be rejected")
                .to_string(),
            "unsupported prompt stopReason: paused"
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({}))
                .expect_err("missing stop reason must be rejected")
                .to_string(),
            "invalid session/prompt response: {}"
        );
    }

    #[test]
    fn prompt_without_attachments_contains_one_text_block() {
        let blocks = prompt_blocks(
            "hello".to_string(),
            &[],
            crate::agent_config::AttachmentLimits::default(),
        )
        .unwrap();
        assert_eq!(
            blocks,
            vec![serde_json::json!({"type": "text", "text": "hello"})]
        );
    }

    #[test]
    fn prompt_rejects_more_than_maximum_attachments() {
        let attachments = vec!["missing.txt".to_string(); DEFAULT_MAX_ATTACHMENTS + 1];
        let error = prompt_blocks(
            "hello".to_string(),
            &attachments,
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("attachment count limit must be enforced before file access");
        assert_eq!(
            error,
            format!("too many attachments: maximum is {DEFAULT_MAX_ATTACHMENTS}")
        );
    }

    #[test]
    fn prompt_rejects_missing_attachment_with_explicit_error() {
        let error = prompt_blocks(
            "hello".to_string(),
            &["definitely-missing-pylon-attachment.txt".to_string()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("missing attachment must fail");
        assert!(error.starts_with(
            "attachment metadata failed for definitely-missing-pylon-attachment.txt:"
        ));
    }

    #[test]
    fn prompt_rejects_directory_attachment() {
        let directory =
            std::env::temp_dir().join(format!("pylon-attachment-dir-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let error = prompt_blocks(
            "hello".to_string(),
            &[directory.to_string_lossy().into_owned()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("directory attachment must fail");
        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(
            error,
            format!("attachment is not a file: {}", directory.display())
        );
    }

    #[test]
    fn prompt_rejects_unknown_binary_attachment() {
        let path = std::env::temp_dir().join(format!(
            "pylon-attachment-binary-{}.bin",
            std::process::id()
        ));
        std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
        let error = prompt_blocks(
            "hello".to_string(),
            &[path.to_string_lossy().into_owned()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("unknown binary attachment must fail");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            error,
            format!("unsupported attachment type: {}", path.display())
        );
    }

    #[test]
    fn prompt_rejects_attachment_grown_beyond_limit_after_metadata_check() {
        // A9：metadata 校验与读取间文件被增长（TOCTOU）时必须拒绝，不能无上限读取。
        let path = std::env::temp_dir().join(format!(
            "pylon-attachment-toctou-{}.bin",
            std::process::id()
        ));
        std::fs::write(&path, vec![0u8; DEFAULT_MAX_ATTACHMENT_BYTES as usize + 1]).unwrap();
        let error = prompt_blocks(
            "hello".to_string(),
            &[path.to_string_lossy().into_owned()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("oversized attachment must fail");
        std::fs::remove_file(&path).unwrap();
        assert!(
            error.starts_with("attachment too large:"),
            "must reject with the bounded-read too-large message, got: {error}"
        );
    }

    /// G1-04：缩小附件限制后边界拒绝——数量上限先行、大小上限按自定义值生效。
    #[test]
    fn custom_attachment_limits_apply() {
        let limits = crate::agent_config::AttachmentLimits {
            max_attachments: 1,
            max_attachment_bytes: 1024,
        };
        // 数量上限：2 个附件在文件访问前即拒绝（数量检查先行）
        let error = prompt_blocks(
            "hello".to_string(),
            &["a.txt".to_string(), "b.txt".to_string()],
            limits,
        )
        .expect_err("超过自定义数量上限必须拒绝");
        assert_eq!(error, "too many attachments: maximum is 1");
        // 大小上限：1KB 限制下 2KB 文本拒绝；默认限制（10MB）下通过
        let path = std::env::temp_dir().join(format!(
            "pylon-attachment-custom-{}.txt",
            std::process::id()
        ));
        std::fs::write(&path, "x".repeat(2048)).unwrap();
        let error = prompt_blocks(
            "hello".to_string(),
            &[path.to_string_lossy().into_owned()],
            limits,
        )
        .expect_err("超过自定义大小上限必须拒绝");
        assert!(error.starts_with("attachment too large:"));
        let blocks = prompt_blocks(
            "hello".to_string(),
            &[path.to_string_lossy().into_owned()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect("默认限制下必须通过");
        assert_eq!(blocks.len(), 2, "text + attachment 两个块");
        std::fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn timeout_sends_cancel_and_waits_for_final_response() {
        let (tx, mut rx) = oneshot::channel();
        let cancel_called = Arc::new(AtomicBool::new(false));
        let cancel_called_for_task = cancel_called.clone();

        let outcome = wait_prompt_with_cancel(
            &mut rx,
            std::time::Duration::from_millis(200),
            std::time::Duration::from_millis(10),
            std::time::Duration::from_millis(10),
            || None,
            move || async move {
                cancel_called_for_task.store(true, Ordering::SeqCst);
                tx.send(response())
                    .map_err(|_| "receiver closed".to_string())
            },
        )
        .await;

        assert!(cancel_called.load(Ordering::SeqCst));
        match outcome {
            PromptWaitOutcome::CancelledAfterTimeout {
                response,
                cancel_error,
            } => {
                assert!(cancel_error.is_none());
                assert_eq!(
                    response
                        .and_then(|raw| raw.result)
                        .and_then(|value| value.get("stopReason").cloned()),
                    Some(serde_json::json!("cancelled"))
                );
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[tokio::test]
    async fn recovery_callback_runs_only_when_cancel_does_not_settle() {
        let (_tx, mut rx) = oneshot::channel();
        let force_called = Arc::new(AtomicBool::new(false));
        let force_called_for_task = force_called.clone();

        let outcome = wait_prompt_with_recovery(
            &mut rx,
            std::time::Duration::from_millis(5),
            std::time::Duration::from_millis(5),
            std::time::Duration::from_millis(5),
            || None,
            || async { Ok(()) },
            move || async move {
                force_called_for_task.store(true, Ordering::SeqCst);
            },
        )
        .await;

        assert!(force_called.load(Ordering::SeqCst));
        assert!(matches!(
            outcome,
            PromptWaitOutcome::CancelledAfterTimeout { response: None, .. }
        ));
    }

    #[tokio::test]
    async fn response_before_timeout_does_not_send_cancel() {
        let (tx, mut rx) = oneshot::channel();
        tx.send(response()).expect("receiver must be open");
        let cancel_called = Arc::new(AtomicBool::new(false));
        let cancel_called_for_task = cancel_called.clone();

        let outcome = wait_prompt_with_cancel(
            &mut rx,
            std::time::Duration::from_millis(10),
            std::time::Duration::from_secs(1),
            std::time::Duration::from_secs(1),
            || None,
            move || async move {
                cancel_called_for_task.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(!cancel_called.load(Ordering::SeqCst));
        assert!(matches!(outcome, PromptWaitOutcome::Response(_)));
    }

    #[tokio::test]
    async fn sustained_activity_is_not_limited_by_prompt_total_timeout() {
        let (_tx, mut rx) = tokio::sync::oneshot::channel();
        let wait = wait_prompt_with_cancel(
            &mut rx,
            std::time::Duration::from_millis(5),
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(20),
            // A real dispatcher updates this value for every thinking/tool/output step.
            // Returning now on every poll models an indefinitely active turn.
            || Some(std::time::Instant::now()),
            || async { Ok(()) },
        );

        // The whole turn must remain alive despite prompt_timeout being shorter than
        // this observation window; only a quiet step may trigger cancellation.
        let result = tokio::time::timeout(std::time::Duration::from_millis(80), wait).await;
        assert!(
            result.is_err(),
            "持续活动不得受 prompt total timeout 截断，实际结果: {result:?}"
        );
    }

    #[test]
    fn drain_pending_notifies_every_waiter_and_clears_registry() {
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        let mut receivers = Vec::new();
        for id in [1_u64, 16, 31] {
            let (tx, rx) = oneshot::channel();
            pending[id as usize % PENDING_SHARDS]
                .lock()
                .unwrap()
                .insert(id, tx);
            receivers.push(rx);
        }

        assert_eq!(drain_pending(&pending), 3);
        assert!(pending.iter().all(|shard| shard.lock().unwrap().is_empty()));
        for receiver in receivers {
            let message = receiver
                .blocking_recv()
                .expect("EOF should wake pending request");
            assert_eq!(
                message.error,
                Some(serde_json::json!("ACP connection closed"))
            );
        }
    }

    #[test]
    fn drain_pending_is_idempotent_after_first_close() {
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        assert_eq!(drain_pending(&pending), 0);
        assert_eq!(drain_pending(&pending), 0);
    }

    #[tokio::test]
    async fn fake_acp_subprocess_completes_initialize_new_and_prompt_wire() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'session/new':
        response['result']={'sessionId':'fake-session-1'}
    elif method == 'session/prompt':
        response['result']={'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp", script);
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let child_id = client.child_id().expect("fake ACP child must exist");
        let new_response = client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )
            .expect("session/new must prepare")
            .complete()
            .await
            .expect("session/new must succeed");
        assert_eq!(session_id_from(&new_response).unwrap(), "fake-session-1");

        let rpc = client
            .prepare_prompt(
                "fake-session-1",
                vec![serde_json::json!({"type":"text","text":"hello"})],
            )
            .expect("prompt must serialize");
        assert!(rpc.line.contains("session/prompt"));
        let request_id = rpc.id;
        let mut response_rx = rpc
            .send_keep_rx()
            .await
            .expect("fake child stdin must remain open");
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), &mut response_rx)
            .await
            .expect("fake ACP prompt response must arrive")
            .expect("fake ACP prompt pending must settle");
        assert_eq!(response.id, Some(RequestId::Number(request_id)));
        assert_eq!(
            prompt_stop_reason(&response.result.unwrap()).unwrap(),
            "end_turn"
        );

        client.kill().expect("explicit child cleanup must succeed");
        assert!(
            !process_exists(child_id),
            "fake ACP child must exit after kill_and_wait"
        );
    }

    #[tokio::test]
    async fn wire_trace_preserves_id_kinds_and_full_sequence() {
        // OBS-01 验收：fake ACP 发送 number/string/null/无 id 四类报文，trace 保留
        // 四类差异；一次 permission 闭环按 seq 排出完整顺序；方向/身份逐条保留。
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'initialize':
        print(json.dumps(response), flush=True)
        # unsolicited：absent-id 通知、string-id 消息、null-id 消息
        print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'s-1'}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':'str-id-1','result':{'ok':True}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':None,'result':None}), flush=True)
    elif method == 'session/new':
        response['result']={'sessionId':'fake-session-1'}
        print(json.dumps(response), flush=True)
    elif method == 'session/prompt':
        # P1 场景：string-id 的 request_permission 先到，再 update 通知，最后响应
        print(json.dumps({'jsonrpc':'2.0','id':'perm-1','method':'session/request_permission','params':{'sessionId':'fake-session-1','toolCallId':'tc-1','options':[{'optionId':'allow_once'},{'optionId':'deny'}]}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'fake-session-1','toolCallId':'tc-1','type':'tool_call_update'}}), flush=True)
        response['result']={'stopReason':'end_turn'}
        print(json.dumps(response), flush=True)
    else:
        print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-trace", script);
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let trace = client
            .wire_trace()
            .expect("connected client must expose wire trace");
        assert!(trace.is_enabled());

        let new_response = client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )
            .expect("session/new must prepare")
            .complete()
            .await
            .expect("session/new must succeed");
        assert_eq!(session_id_from(&new_response).unwrap(), "fake-session-1");

        let rpc = client
            .prepare_prompt(
                "fake-session-1",
                vec![serde_json::json!({"type":"text","text":"hello"})],
            )
            .expect("prompt must serialize");
        let mut response_rx = rpc
            .send_keep_rx()
            .await
            .expect("fake child stdin must remain open");
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), &mut response_rx)
            .await
            .expect("fake ACP prompt response must arrive")
            .expect("fake ACP prompt pending must settle");
        assert_eq!(
            prompt_stop_reason(&response.result.unwrap()).unwrap(),
            "end_turn"
        );

        // 轮询等待 writer/reader 线程把全部 wire 记录落进 ring buffer。
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let snap = loop {
            let snap = trace.snapshot();
            if snap.len() >= 11 {
                break snap;
            }
            if tokio::time::Instant::now() >= deadline {
                break snap;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };

        // 四条 id 形态必须全部保留（number/string/null/absent）。
        let kinds: Vec<WireIdKind> = snap.iter().map(|record| record.id_kind).collect();
        assert!(
            kinds.contains(&WireIdKind::Number),
            "number id 必须保留，实际 {kinds:?}"
        );
        assert!(
            kinds.contains(&WireIdKind::String),
            "string id 必须保留，实际 {kinds:?}"
        );
        assert!(
            kinds.contains(&WireIdKind::Null),
            "null id 必须保留，实际 {kinds:?}"
        );
        assert!(
            kinds.contains(&WireIdKind::Absent),
            "absent id 必须保留，实际 {kinds:?}"
        );

        // monotonicSeq 严格单调（CR-003 命名；CR-001 snapshot 已排齐）。
        let seqs: Vec<u64> = snap.iter().map(|record| record.monotonic_seq).collect();
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        assert_eq!(seqs, sorted, "seq 必须可排出完整顺序");
        assert!(
            seqs.windows(2).all(|pair| pair[1] > pair[0]),
            "seq 严格递增"
        );

        // string-id request_permission（P1 场景）必须按原样记录。
        let permission = snap
            .iter()
            .find(|record| record.method.as_deref() == Some("session/request_permission"))
            .expect("request_permission 必须在 trace 中");
        assert_eq!(permission.id_kind, WireIdKind::String);
        assert_eq!(permission.id_value, Some(serde_json::json!("perm-1")));
        assert_eq!(permission.direction, WireDirection::AgentToPylon);
        assert_eq!(permission.tool_call_id.as_deref(), Some("tc-1"));
        assert_eq!(
            permission.remote_session_id.as_deref(),
            Some("fake-session-1")
        );
        assert_eq!(
            permission.request_id.as_deref(),
            Some("perm-1"),
            "OBS-02：request_permission 的 wire id 必须记为 requestId"
        );

        // 方向/状态：至少存在 outbound 与 inbound 记录，状态与方向一致。
        assert!(
            snap.iter().any(|record| {
                record.direction == WireDirection::PylonToAgent && record.status == "sent"
            }),
            "必须存在 outbound(sent) 记录"
        );
        assert!(
            snap.iter().any(|record| {
                record.direction == WireDirection::AgentToPylon && record.status == "received"
            }),
            "必须存在 inbound(received) 记录"
        );
        // 身份逐条保留。
        for record in &snap {
            assert_eq!(record.agent_id, "fake-acp-trace");
            assert_eq!(record.source, "subprocess");
        }

        client.kill().expect("explicit child cleanup must succeed");
    }

    #[tokio::test]
    async fn fake_acp_initialize_stores_agent_capabilities() {
        // P1（能力协商暴露）：initialize 响应里的 agentCapabilities 必须存进
        // AcpClient——前端能力驱动 UI（agent_status.capabilities）依赖此存储。
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'initialize':
        response['result']={'protocolVersion':1,'agentCapabilities':{'loadSession':True,'promptCapabilities':{'image':True}}}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-caps", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let caps = client
            .agent_capabilities()
            .expect("agentCapabilities 必须从握手响应存储");
        assert_eq!(caps["loadSession"], true);
        assert_eq!(caps["promptCapabilities"]["image"], true);
        // 断开态无 capabilities
        assert!(AcpClient::disconnected().agent_capabilities().is_none());
    }

    #[tokio::test]
    async fn connect_failures_have_typed_preflight_and_spawn_stages() {
        let mut missing = crate::test_utils::fake_acp_agent("missing", "print('x')");
        missing.exe = std::env::temp_dir()
            .join("definitely-missing-pylon-agent")
            .to_string_lossy()
            .to_string();
        let error = AcpClient::connect_with_logs(&missing, None)
            .await
            .err()
            .expect("missing executable path must fail preflight");
        let AcpError::Connect(failure) = error else {
            panic!("expected typed connect failure")
        };
        assert_eq!(failure.stage, AgentConnectStage::Preflight);
        assert_eq!(failure.code, "agent_executable_missing");
        assert!(!failure.retryable);

        let mut spawn = crate::test_utils::fake_acp_agent("spawn", "print('x')");
        spawn.exe = format!("pylon-command-that-does-not-exist-{}", std::process::id());
        let error = AcpClient::connect_with_logs(&spawn, None)
            .await
            .err()
            .expect("unknown PATH command must fail spawn");
        let AcpError::Connect(failure) = error else {
            panic!("expected typed spawn failure")
        };
        assert_eq!(failure.stage, AgentConnectStage::Spawn);
        assert_eq!(failure.code, "agent_spawn_failed");
        assert!(failure.io_kind.is_some());
    }

    #[tokio::test]
    async fn initialize_rpc_failure_keeps_safe_remote_summary() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'error':{'code':-32041,'message':'profile invalid','data':{'token':'must-not-leak','attempt':1}}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("typed-init-error", script);
        let error = AcpClient::connect_with_logs(&agent, None)
            .await
            .err()
            .expect("initialize RPC error must fail connect");
        let AcpError::Connect(failure) = error else {
            panic!("expected typed initialize failure")
        };
        assert_eq!(failure.stage, AgentConnectStage::Initialize);
        assert_eq!(failure.code, "agent_initialize_failed");
        assert_eq!(failure.remote_code, Some(-32041));
        assert_eq!(
            failure.remote_data_summary.as_deref(),
            Some("object(2 keys)")
        );
        assert!(!failure.message.contains("must-not-leak"));
    }

    #[tokio::test]
    async fn malformed_capabilities_have_capability_stage() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'agentCapabilities':[]}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("typed-capability-error", script);
        let error = AcpClient::connect_with_logs(&agent, None)
            .await
            .err()
            .expect("non-object capabilities must fail connect");
        let AcpError::Connect(failure) = error else {
            panic!("expected typed capability failure")
        };
        assert_eq!(failure.stage, AgentConnectStage::Capability);
        assert_eq!(failure.code, "agent_capability_invalid");
        assert!(!failure.retryable);
    }

    #[test]
    fn rpc_failure_kind_distinguishes_missing_session_from_method_and_transient_errors() {
        for raw in [
            r#"{"code":-32602,"message":"session not found: s-1"}"#,
            r#"{"code":-32000,"message":"invalid session: s-1"}"#,
            r#"{"code":-32000,"message":"request rejected","data":{"kind":"session_missing"}}"#,
        ] {
            assert_eq!(
                AcpError::Rpc(raw.into()).rpc_failure_kind(),
                Some(RpcFailureKind::SessionMissing),
                "{raw}"
            );
        }
        for raw in [
            r#"{"code":-32601,"message":"Method not found"}"#,
            r#"{"code":-32602,"message":"invalid params: missing content"}"#,
            r#"{"code":-32001,"message":"rate limited"}"#,
        ] {
            assert_ne!(
                AcpError::Rpc(raw.into()).rpc_failure_kind(),
                Some(RpcFailureKind::SessionMissing),
                "{raw}"
            );
        }
    }

    #[tokio::test]
    async fn fake_acp_eof_drains_pending_requests() {
        let script = r#"import sys
sys.exit(0)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-eof", script);
        let client = AcpClient::connect_with_logs(&agent, None).await;
        assert!(
            client.is_err(),
            "initialize must fail when fake ACP closes without a response"
        );
    }

    #[tokio::test]
    async fn crashed_watch_signals_eof_after_broadcast_overflow() {
        // A7：洪泛 300 条（> BROADCAST_CAP=256）后 EOF——NOTIF_AGENT_CRASHED 广播
        // 必然被 Lagged 丢弃；崩溃信号必须经独立 watch 通道仍可靠送达（watch 保留
        // 最新值：订阅晚于崩溃时 has_changed 直接可读，订阅早于崩溃时 changed 触发）。
        let script = r#"import json,sys
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
        for i in range(300):
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'flood','update':{'sessionUpdate':'agent_message_chunk','content':{'text':'x'}}}}), flush=True)
        break
sys.exit(0)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-flood-crash", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("flood fake ACP must initialize");
        let mut crashed_rx = client.crashed_receiver();
        if crashed_rx.has_changed().unwrap_or(false) {
            // 崩溃发生在订阅之前（connect 成功后立刻 EOF）——watch 保留最新值，直接可读
        } else {
            tokio::time::timeout(std::time::Duration::from_secs(5), crashed_rx.changed())
                .await
                .expect("watch must signal crash within 5s")
                .expect("watch channel must stay open");
        }
        assert!(
            *crashed_rx.borrow_and_update(),
            "crashed watch value must be true after EOF"
        );
        assert!(client.is_crashed());
    }

    #[tokio::test]
    async fn fake_acp_session_load_collects_replay_before_response() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'initialize':
        response['result']={}
    elif method == 'session/load':
        session_id=request['params']['sessionId']
        for text in ['history-1','history-2']:
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':text}}}}), flush=True)
        response['result']={'loaded':True}
    else:
        response['result']={}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-replay", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP replay agent must initialize");
        let (response, replay) = load_session_with_replay(
            client.replay_handles(),
            "fake-session-replay",
            ".",
            Vec::new(),
            McpServersMode::Always,
        )
        .await
        .expect("session/load must return after replay response");
        assert_eq!(response, serde_json::json!({"loaded": true}));
        assert_eq!(replay.events.len(), 2);
        assert_eq!(replay.events[0]["update"]["content"]["text"], "history-1");
        assert_eq!(replay.events[1]["update"]["content"]["text"], "history-2");
        assert!(replay.metadata.complete);
        assert!(!replay.metadata.truncated);
        assert_eq!(replay.metadata.dropped_count, 0);
        assert_eq!(replay.metadata.boundary.observed_count, 2);
        assert_eq!(replay.metadata.boundary.retained_start_ordinal, Some(1));
        assert_eq!(replay.metadata.boundary.retained_end_ordinal, Some(2));
    }

    /// G1-02：rpc_timeout 参数化——配置短 rpc_timeout 的 client 在 fake 慢响应上
    /// 必须按配置超时返回 RpcTimeout（而非默认 30s 等待）。
    #[tokio::test]
    async fn rpc_timeout_from_config_is_used() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    else:
        pass
"#;
        let mut agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-rpc-timeout",
            script,
            Vec::new(),
            HashMap::new(),
        );
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            rpc_timeout_secs: Some(1),
            ..Default::default()
        });
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let start = std::time::Instant::now();
        let result = client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )
            .expect("session/new must prepare")
            .complete()
            .await;
        assert!(
            matches!(result, Err(AcpError::RpcTimeout)),
            "慢响应必须按配置短超时超时，实际: {result:?}"
        );
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "必须用配置的短超时（1s）而非默认 30s，实际耗时 {:?}",
            start.elapsed()
        );
    }

    /// G1-02：replay_max 参数化——回放超过配置上限时截断且继续等响应（响应不得丢）。
    #[tokio::test]
    async fn replay_max_truncation_respects_config() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif request.get('method') == 'session/load':
        session_id=request['params']['sessionId']
        for i in range(3):
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'h%d' % i}}}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'loaded':True}}), flush=True)
"#;
        let mut agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-replay-cap",
            script,
            Vec::new(),
            HashMap::new(),
        );
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            replay_max_events: Some(2),
            ..Default::default()
        });
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP replay cap agent must initialize");
        let (response, replay) = load_session_with_replay(
            client.replay_handles(),
            "target-cap",
            ".",
            Vec::new(),
            McpServersMode::Always,
        )
        .await
        .expect("session/load must return after replay response");
        assert_eq!(response, serde_json::json!({"loaded": true}));
        assert_eq!(
            replay.events.len(),
            2,
            "回放必须按 replay_max=2 截断（3 条 fake 事件）"
        );
        assert_eq!(replay.events[0]["update"]["content"]["text"], "h1");
        assert_eq!(replay.events[1]["update"]["content"]["text"], "h2");
        assert!(!replay.metadata.complete);
        assert!(replay.metadata.truncated);
        assert_eq!(replay.metadata.dropped_count, 1);
        assert_eq!(replay.metadata.boundary.kind, "session-load-response");
        assert_eq!(replay.metadata.boundary.observed_count, 3);
        assert_eq!(replay.metadata.boundary.retained_start_ordinal, Some(2));
        assert_eq!(replay.metadata.boundary.retained_end_ordinal, Some(3));
        assert_eq!(
            serde_json::to_value(&replay.metadata).expect("replay metadata serializes"),
            serde_json::json!({
                "complete": false,
                "truncated": true,
                "droppedCount": 1,
                "boundary": {
                    "kind": "session-load-response",
                    "observedCount": 3,
                    "retainedStartOrdinal": 2,
                    "retainedEndOrdinal": 3
                }
            })
        );
    }

    #[tokio::test]
    async fn fake_acp_cancel_and_close_send_expected_notifications() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-control-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'session/close':
        response['result']={'closed':True}
    if request.get('id') is not None:
        print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-control",
            script,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP control agent must initialize");
        client
            .cancel_session("fake-session-control")
            .await
            .expect("cancel notification must write");
        close_session_rpc(&client, "fake-session-control")
            .await
            .expect("close request must respond");
        let trace =
            std::fs::read_to_string(&trace_path).expect("fake ACP must record control requests");
        std::fs::remove_file(&trace_path).ok();
        let requests: Vec<serde_json::Value> = trace
            .lines()
            .map(|line| serde_json::from_str(line).expect("trace line must be JSON"))
            .collect();
        assert!(requests.iter().any(|request| {
            request.get("method").and_then(|value| value.as_str()) == Some(METHOD_SESSION_CANCEL)
                && request.get("id").is_none()
                && request["params"]["sessionId"] == "fake-session-control"
        }));
        assert!(requests.iter().any(|request| {
            request.get("method").and_then(|value| value.as_str()) == Some(METHOD_SESSION_CLOSE)
                && request.get("id").and_then(|value| value.as_u64()).is_some()
                && request["params"]["sessionId"] == "fake-session-control"
        }));
    }
    #[tokio::test]
    async fn fake_acp_eof_wakes_pending_request_after_initialize() {
        let script = r#"import json,sys
line=sys.stdin.readline()
request=json.loads(line)
print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
sys.exit(0)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-eof-after-init", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("initialize response must arrive before EOF");
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if client.is_crashed() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fake child EOF must be observed");
        let error =
            tokio::time::timeout(std::time::Duration::from_secs(2), new_session_rpc(&client))
                .await
                .expect("pending request must settle after EOF")
                .expect_err("EOF must reject a new request");
        assert!(error.to_string().contains("ACP connection closed"));
    }

    #[tokio::test]
    async fn fake_acp_malformed_json_does_not_break_following_response() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print('{malformed-json', flush=True)
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if request.get('method') == 'session/new':
        response['result']={'sessionId':'after-malformed'}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-malformed", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("malformed line must not break initialize");
        let response = new_session_rpc(&client)
            .await
            .expect("response after malformed line must arrive");
        assert_eq!(session_id_from(&response).unwrap(), "after-malformed");
    }

    #[tokio::test]
    async fn fake_acp_stderr_is_drained_into_safe_runtime_log() {
        let script = r#"import json,sys
print('fake stderr diagnostic', file=sys.stderr, flush=True)
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-stderr", script);
        let logs = crate::runtime_log::RuntimeLogHub::new(16);
        let client = AcpClient::connect_with_logs(&agent, Some(logs.clone()))
            .await
            .expect("stderr fake ACP must initialize");
        let _ = client;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let entries = logs.list(&crate::runtime_log::RuntimeLogQuery::default());
                if entries.iter().any(|entry| entry.source == "agent-stderr") {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("stderr reader must publish runtime log");
        let entry = logs
            .list(&crate::runtime_log::RuntimeLogQuery::default())
            .into_iter()
            .find(|entry| entry.source == "agent-stderr")
            .expect("agent stderr log must exist");
        // LOG-01：message 必须是真实行文本（原占位 "Agent stderr output" 改为真实行，
        // 真实错误可检索）；同一 stderr 行只进 hub 一次（A 型 tracing 回声已被 target 跳过）。
        assert_eq!(entry.message, "fake stderr diagnostic");
        // LOG-02：普通 stderr 行不再默认 error——非结构化、无致命信号的普通行 → info。
        assert_eq!(entry.level, "info", "LOG-02：普通 stderr 行不得默认 error");
        assert_eq!(
            entry.fields.get("agent").and_then(|value| value.as_str()),
            Some("fake-acp-stderr")
        );
        let entries = logs.list(&crate::runtime_log::RuntimeLogQuery::default());
        let stderr_line_entries = entries
            .iter()
            .filter(|entry| {
                entry.source == "agent-stderr" || entry.message.contains("fake stderr diagnostic")
            })
            .count();
        // LOG-01 CR-001 消化（玉衡 MINOR）：本断言只守护"stderr reader 显式 push 恰好
        // 一次"（读线程是 `logs` 唯一来源）；A/B 双写中 A 型（tracing layer 捕获回声）
        // 在本测试 harness 下不可达——connect 未把 RuntimeLogLayer 绑定到本 hub，
        // tracing 事件到不了 `logs`。A/B 去重由 runtime_log 层单测
        // layer_skips_agent_stderr_echo_target_but_keeps_other_errors 真实兜底
        // （旧代码该测试必失败，非 vacuous）。
        assert_eq!(
            stderr_line_entries, 1,
            "stderr 行显式 push 恰好一次（A/B 去重另由 layer 单测守护）"
        );
    }

    #[tokio::test]
    async fn fake_acp_delayed_response_stays_pending_until_response() {
        let script = r#"import json,sys,time
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'session/new':
        time.sleep(0.15)
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'sessionId':'delayed-session'}}), flush=True)
    else:
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-delayed", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("delayed fake ACP must initialize");
        let response =
            tokio::time::timeout(std::time::Duration::from_secs(2), new_session_rpc(&client))
                .await
                .expect("delayed response must not hit test timeout")
                .expect("delayed response must succeed");
        assert_eq!(session_id_from(&response).unwrap(), "delayed-session");
    }
    #[tokio::test]
    async fn fake_acp_prompt_timeout_sends_cancel_and_waits_for_cancelled_response() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-prompt-{}.jsonl", std::process::id()));
        let script = r#"import json,sys,time
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    method=request.get('method')
    if method == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif method == 'session/prompt':
        time.sleep(0.2)
    elif method == 'session/cancel':
        print(json.dumps({'jsonrpc':'2.0','id':None,'method':'session/update','params':{'sessionId':request['params']['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'cancelled'}}}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-prompt-timeout",
            script,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("timeout fake ACP must initialize");
        let rpc = client
            .prepare_prompt(
                "fake-session-timeout",
                vec![serde_json::json!({"type":"text","text":"hello"})],
            )
            .expect("prompt must serialize");
        let request_id = rpc.id;
        let mut response_rx = rpc.send_keep_rx().await.expect("prompt must write");
        let cancel_tx = client.write_tx.clone();
        let outcome = wait_prompt_with_cancel(
            &mut response_rx,
            std::time::Duration::from_millis(200),
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(20),
            || None,
            move || async move {
                cancel_tx
                    .send(
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": METHOD_SESSION_CANCEL,
                            "params": {"sessionId": "fake-session-timeout"}
                        })
                        .to_string(),
                    )
                    .await
                    .map_err(|_| "ACP connection closed".to_string())
            },
        )
        .await;
        assert!(matches!(
            outcome,
            PromptWaitOutcome::CancelledAfterTimeout {
                response: None,
                cancel_error: None
            }
        ));
        client.remove_pending(request_id);
        let trace =
            std::fs::read_to_string(&trace_path).expect("fake ACP must record prompt and cancel");
        std::fs::remove_file(&trace_path).ok();
        assert!(trace.lines().any(|line| {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            value.get("method").and_then(|method| method.as_str()) == Some(METHOD_SESSION_CANCEL)
                && value["params"]["sessionId"] == "fake-session-timeout"
        }));
    }

    #[tokio::test]
    async fn send_line_write_timeout_marks_connection_crashed() {
        // 假死连接：容量 1 的写通道被填满且无人消费（writer 卡死），send_line 超时 →
        // WriteTimeout + crashed 置位，后续命令快速失败并触发自动重连。
        // 与 fake_acp_* 一致用真实时钟，超时等待 DEFAULT_WRITE_TIMEOUT_SECS。
        let (write_tx, _write_rx) = mpsc::channel::<String>(1);
        write_tx
            .send("first-line".to_string())
            .await
            .expect("empty channel must accept the first line");
        let crashed = Arc::new(AtomicBool::new(false));
        let error = send_line(write_tx, "second-line".to_string(), &crashed)
            .await
            .expect_err("full channel with no consumer must time out");
        assert!(matches!(error, AcpError::WriteTimeout));
        assert!(
            crashed.load(Ordering::Relaxed),
            "write timeout must mark the connection as crashed"
        );
    }

    #[tokio::test]
    async fn writer_failure_signals_watch_and_pending_settles() {
        // 方案 2A 测试门：writer 写失败（EPIPE）必须经 fail_connection 统一结算——
        // crashed=true、watch 发 true、pending waiter 立即 ConnectionClosed，
        // 不再只置 crashed 等下次 EOF（agent 僵死时 EOF 永不来）。
        let trace_path = std::env::temp_dir().join(format!(
            "pylon-acp-writer-fail-{}.jsonl",
            std::process::id()
        ));
        // 读一行后立即退出：initialize 写入成功，后续写触发 EPIPE。
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
line=sys.stdin.readline()
request=json.loads(line)
trace.write(json.dumps(request)+'\n')
trace.flush()
print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-writer-fail".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: crate::test_utils::test_python_exe().to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("initialize 应成功（首行写入正常）");
        let mut crashed_rx = client.crashed_receiver();
        // 子进程已退出，writer 下次写必 EPIPE → fail_connection → watch 发 true。
        let rpc = client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )
            .expect("prepare_rpc 不依赖进程状态");
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), rpc.complete())
            .await
            .expect("写失败必须在 5s 内收敛（不得悬挂）");
        assert!(outcome.is_err(), "写失败必须返回 Err");
        assert!(client.is_crashed(), "crashed 必须置位");
        // watch 通道必须送达 true（dispatcher 依赖它触发自动重连）
        let watch_hit = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            if *crashed_rx.borrow_and_update() {
                return true;
            }
            crashed_rx.changed().await.is_ok() && *crashed_rx.borrow_and_update()
        })
        .await
        .unwrap_or(false);
        assert!(watch_hit, "writer failure 必须经 watch 信号送达");
        client.kill().expect("cleanup");
        std::fs::remove_file(&trace_path).ok();
    }

    #[tokio::test]
    async fn fail_connection_signals_watch_drains_pending_and_is_idempotent() {
        // 方案 2A：fail_connection 统一结算——crashed=true、watch 发 true、
        // pending drain 一次、重复调用幂等（不 double-resolve）。
        let crashed = Arc::new(AtomicBool::new(false));
        let (crashed_watch, mut crashed_rx) = watch::channel(false);
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        // 预注册 2 个 pending waiter
        for id in [3u64, 9] {
            let (tx, _rx) = tokio::sync::oneshot::channel();
            pending[id as usize % PENDING_SHARDS]
                .lock()
                .unwrap()
                .insert(id, tx);
        }
        let drained = super::transport::fail_connection(&crashed, &crashed_watch, &pending);
        assert_eq!(drained, 2, "首次结算必须 drain 全部 pending");
        assert!(crashed.load(Ordering::Relaxed), "crashed 必须置位");
        // watch 通道已送达最新值 true（dispatcher 依赖它触发自动重连）
        assert!(*crashed_rx.borrow_and_update(), "watch 最新值必须为 true");
        // 幂等：重复调用不 double-resolve
        let drained_again = super::transport::fail_connection(&crashed, &crashed_watch, &pending);
        assert_eq!(drained_again, 0, "重复调用不得重复 drain");
        assert!(*crashed_rx.borrow_and_update());
    }

    #[tokio::test]
    async fn send_after_crash_returns_connection_closed_without_pending_stall() {
        // A6：模拟 EOF 竞态窗口——pending 注册后于 drain（drain 未 resolve 该 id），
        // 但 reader 已 store crashed。send 成功后复检 crashed 必须立即返回
        // ConnectionClosed 并清理 pending（修复前 send_keep_rx 挂满 300s / complete
        // 挂满 30s 假超时）。
        for complete in [false, true] {
            let (write_tx, _write_rx) = mpsc::channel::<String>(1);
            let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
                Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
            let crashed = Arc::new(AtomicBool::new(true));
            let (_tx, rx) = oneshot::channel();
            let rpc = PreparedRpc {
                id: 7,
                line: "test-line".to_string(),
                write_tx,
                rx,
                pending: pending.clone(),
                crashed,
                rpc_timeout: std::time::Duration::from_secs(30),
            };
            let result = tokio::time::timeout(std::time::Duration::from_secs(2), async move {
                if complete {
                    rpc.complete().await.map(|_| ())
                } else {
                    rpc.send_keep_rx().await.map(|_| ())
                }
            })
            .await
            .expect("crashed path must return immediately, not stall");
            assert!(matches!(result, Err(AcpError::ConnectionClosed)));
            assert!(
                !pending[7 % PENDING_SHARDS].lock().unwrap().contains_key(&7),
                "pending must be cleaned up on the crashed path"
            );
        }
    }

    #[tokio::test]
    async fn fake_acp_session_load_ignores_updates_from_other_sessions() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif request.get('method') == 'session/load':
        session_id=request['params']['sessionId']
        updates=[
            (session_id, 'target-1'),
            ('other-session', 'must-not-leak'),
            (session_id, 'target-2'),
        ]
        for update_session, text in updates:
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':update_session,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':text}}}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'loaded':True}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-update-isolation", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("update isolation fake ACP must initialize");
        let (_response, replay) = load_session_with_replay(
            client.replay_handles(),
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        )
        .await
        .expect("target session load must succeed");
        let texts: Vec<&str> = replay
            .events
            .iter()
            .filter_map(|params| params["update"]["content"]["text"].as_str())
            .collect();
        assert_eq!(texts, vec!["target-1", "target-2"]);
        assert!(!texts.contains(&"must-not-leak"));
    }

    #[tokio::test]
    async fn fake_acp_session_load_replay_eof_returns_connection_closed() {
        // 优化 3：回放期间 EOF（崩溃）——每轮复检 crashed 立即 ConnectionClosed，
        // 而非依赖 NOTIF_AGENT_CRASHED 广播被跳过（非目标 session/update）后
        // 挂满 30s 假超时。
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif request.get('method') == 'session/load':
        session_id=request['params']['sessionId']
        print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'history-1'}}}}), flush=True)
        break
sys.exit(0)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-replay-eof", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP replay EOF agent must initialize");
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            load_session_with_replay(
                client.replay_handles(),
                "fake-session-replay-eof",
                ".",
                Vec::new(),
                McpServersMode::Always,
            ),
        )
        .await
        .expect("replay EOF must fail fast, not hang until the 30s timeout");
        assert!(matches!(result, Err(AcpError::ConnectionClosed)));
        assert!(client.is_crashed(), "EOF must mark the connection crashed");
    }

    #[tokio::test]
    async fn fake_acp_prompt_cancel_returns_final_cancelled_response() {
        let script = r#"import json,sys
prompt_id=None
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    if method == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif method == 'session/prompt':
        prompt_id=request.get('id')
    elif method == 'session/cancel':
        print(json.dumps({'jsonrpc':'2.0','id':prompt_id,'result':{'stopReason':'cancelled'}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-cancel-response", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("cancel-response fake ACP must initialize");
        let rpc = client
            .prepare_prompt(
                "fake-session-cancel-response",
                vec![serde_json::json!({"type":"text","text":"hello"})],
            )
            .expect("prompt must serialize");
        let mut response_rx = rpc.send_keep_rx().await.expect("prompt must write");
        let cancel_tx = client.write_tx.clone();
        let outcome = wait_prompt_with_cancel(
            &mut response_rx,
            std::time::Duration::from_millis(200),
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(20),
            || None,
            move || async move {
                cancel_tx
                    .send(
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": METHOD_SESSION_CANCEL,
                            "params": {"sessionId": "fake-session-cancel-response"}
                        })
                        .to_string(),
                    )
                    .await
                    .map_err(|_| "ACP connection closed".to_string())
            },
        )
        .await;
        match outcome {
            PromptWaitOutcome::CancelledAfterTimeout {
                response: Some(raw),
                cancel_error,
            } => {
                assert!(cancel_error.is_none());
                assert_eq!(
                    raw.result
                        .and_then(|value| value.get("stopReason").cloned()),
                    Some(serde_json::json!("cancelled"))
                );
            }
            other => panic!("expected final cancelled response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_response_writes_result_with_matching_id() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-response-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    trace.write(line)
    trace.flush()
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-response",
            script,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let result =
            serde_json::json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}});
        client
            .send_response(42, result.clone())
            .await
            .expect("send_response must write");
        // 等待写通道 flush（fake 脚本逐行写 trace）
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let lines: Vec<serde_json::Value> = trace
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let response = lines
            .iter()
            .find(|line| line.get("id").and_then(|v| v.as_u64()) == Some(42))
            .expect("response line must exist");
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["result"]["outcome"]["outcome"], "selected");
        assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");
        client.kill().expect("cleanup");
    }

    #[tokio::test]
    async fn fake_acp_initialize_uses_configured_client_capabilities() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-caps-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-caps".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: Some(crate::agent_config::AcpProtocolConfig {
                initialize_caps: Some(serde_json::json!({
                    "fs": {},
                    "auth": {},
                    "_meta": {"peri.skillNames": true}
                })),
                ..Default::default()
            }),
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP with configured caps must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let request: serde_json::Value = trace
            .lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
            })
            .expect("initialize must be traced");
        assert_eq!(
            request["params"]["clientCapabilities"]["fs"],
            serde_json::json!({})
        );
        assert_eq!(
            request["params"]["clientCapabilities"]["_meta"]["peri.skillNames"],
            serde_json::json!(true)
        );
        assert!(
            request["params"]["clientCapabilities"]
                .get("tokenStats")
                .is_none(),
            "覆盖后不再带统一默认 caps"
        );
        // G1-03：未配置的 protocolVersion/clientInfo 保持默认现值（wire 不变）
        assert_eq!(request["params"]["protocolVersion"], serde_json::json!(1));
        assert_eq!(
            request["params"]["clientInfo"],
            serde_json::json!({"name": "Pylon", "version": "1.0.0"})
        );
    }

    #[tokio::test]
    async fn fake_acp_initialize_defaults_to_unified_capabilities() {
        let trace_path = std::env::temp_dir().join(format!(
            "pylon-acp-caps-default-{}.jsonl",
            std::process::id()
        ));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-caps-default",
            script,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP with default caps must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let request: serde_json::Value = trace
            .lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
            })
            .expect("initialize must be traced");
        assert_eq!(
            request["params"]["clientCapabilities"]["tokenStats"],
            serde_json::json!(true)
        );
        assert_eq!(
            request["params"]["clientCapabilities"]["_meta"]["peri.replay"],
            serde_json::json!(true)
        );
        // G1-03：默认路径 protocolVersion/clientInfo 为现状现值（wire 逐字节不变）
        assert_eq!(request["params"]["protocolVersion"], serde_json::json!(1));
        assert_eq!(
            request["params"]["clientInfo"],
            serde_json::json!({"name": "Pylon", "version": "1.0.0"})
        );
    }

    /// G1-03：声明 protocol_version/client_info 后按声明进 wire（覆盖路径）。
    #[tokio::test]
    async fn custom_protocol_version_and_client_info_reach_wire() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-handshake-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-handshake".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: crate::test_utils::test_python_exe().to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: Some(crate::agent_config::AcpProtocolConfig {
                protocol_version: Some(2),
                client_info: Some(serde_json::json!({"name": "Pylon", "version": "9.9.9"})),
                ..Default::default()
            }),
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP with custom handshake must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let request: serde_json::Value = trace
            .lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
            })
            .expect("initialize must be traced");
        assert_eq!(
            request["params"]["protocolVersion"],
            serde_json::json!(2),
            "声明的 protocol_version 必须进 wire"
        );
        assert_eq!(
            request["params"]["clientInfo"],
            serde_json::json!({"name": "Pylon", "version": "9.9.9"}),
            "声明的 client_info 必须进 wire"
        );
        // caps 未声明 → 默认统一 caps 不受影响
        assert_eq!(
            request["params"]["clientCapabilities"]["tokenStats"],
            serde_json::json!(true)
        );
    }

    /// 方案 G 演进：hermes_profile 绝对路径 → 子进程 HERMES_HOME 注入。
    /// fake 脚本把 HERMES_HOME 写入 trace 文件，回读断言注入生效。
    #[tokio::test]
    async fn hermes_profile_injects_hermes_home_env() {
        let profile_dir =
            std::env::temp_dir().join(format!("pylon-profile-{}", std::process::id()));
        std::fs::create_dir_all(&profile_dir).unwrap();
        let trace_path =
            std::env::temp_dir().join(format!("pylon-hermes-env-{}.jsonl", std::process::id()));
        let script = r#"import json,sys,os
with open(sys.argv[1],'w',encoding='utf-8') as f:
    f.write(os.environ.get('HERMES_HOME','')+'\n')
print(json.dumps({'jsonrpc':'2.0','id':1,'result':{}}), flush=True)
"#;
        let mut agent = crate::agent_config::AgentDef {
            name: "fake-hermes".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: crate::test_utils::test_python_exe().to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: true,
            model: None,
            hermes_profile: Some(profile_dir.to_string_lossy().into_owned()),
            acp_args: Vec::new(),
            acp: None,
        };
        // 绝对路径形态不需要 Hermes home 探测，测试不依赖本机环境。
        agent.hermes_profile = Some(profile_dir.to_string_lossy().into_owned());
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake hermes must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read env trace");
        std::fs::remove_file(&trace_path).ok();
        std::fs::remove_dir_all(&profile_dir).ok();
        assert_eq!(
            trace.trim(),
            profile_dir.to_string_lossy(),
            "HERMES_HOME 必须注入为 hermes_profile 解析目录"
        );
    }

    /// 方案 G 演进：未配置 hermes_profile 时不注入 HERMES_HOME（现状行为不回归）。
    #[tokio::test]
    async fn unset_hermes_profile_does_not_inject_env() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-hermes-noenv-{}.jsonl", std::process::id()));
        let script = r#"import json,sys,os
with open(sys.argv[1],'w',encoding='utf-8') as f:
    f.write(os.environ.get('HERMES_HOME','<absent>')+'\n')
print(json.dumps({'jsonrpc':'2.0','id':1,'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-hermes-plain".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: crate::test_utils::test_python_exe().to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: true,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake hermes must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read env trace");
        std::fs::remove_file(&trace_path).ok();
        // 子进程默认继承 Pylon 进程环境——测试进程若本身有 HERMES_HOME 则透传。
        // 断言只能区分"显式注入的 profile 路径"与"未注入"两种：未配置时子进程
        // 读到的是进程环境原值（非注入产物），不可能等于临时 profile 目录。
        assert_ne!(
            trace.trim(),
            format!(
                "{}",
                std::env::temp_dir()
                    .join(format!("pylon-profile-{}", std::process::id()))
                    .to_string_lossy()
            ),
            "未配置 hermes_profile 时不得注入临时 profile 路径"
        );
    }

    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
