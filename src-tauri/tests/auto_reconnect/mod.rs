//! #106 P5：auto_reconnect 全链路（自 lib 内嵌形态迁入，装配经 test_harness 门面，
//! 断言逐条保持——验收 8）。
//!
//! 覆盖：crash → 崩溃通知 → 自动重连调度 → 代际迁移；crash-loop（成功后再崩）
//! 持续退避；洪泛（> BROADCAST_CAP）后经 watch 通道的崩溃信号；手动重连释放
//! 防重入标志；agent 主动 request_permission 的挂起与 wire round-trip。

use prism_desktop_lib::test_harness::{HarnessConfig, LifecycleStatusView, TestHarness};
use std::time::Duration;

/// fake ACP（P1 后为 bin 场景）：`alive` 常驻应答；`crash` 响应首个请求后立即
/// 退出 → stdout EOF → 崩溃通知。initialize 声明 `loadSession`（alive 场景内置）：
/// 连续性探针在宿主不支持 loadSession 时会把保留会话标为 detached 而**不迁移
/// 代际**——「kept sessions must migrate generation」验的正是「确认连续后迁移」。
fn alive_args() -> &'static [&'static str] {
    &["--scenario", "alive"]
}

fn crash_args() -> &'static [&'static str] {
    &["--scenario", "crash-after-init"]
}

/// 崩溃前已有会话映射（generation 0）——重连后应保留并迁移到新代际。
async fn boot_with_seeded_session(args: &'static [&'static str]) -> TestHarness {
    let harness = TestHarness::boot(
        HarnessConfig::new()
            .with_fake_agent("fake-acp", args)
            .with_approval_mode("default"),
    )
    .await;
    harness.seed_session("source-a", "fake-session-1", "persona", ".", 0);
    harness
}

/// G5-2：crash → 状态置 Crashed + 自动重连已调度 → agents 表切 alive →
/// Connected + generation 前进 + 会话代际迁移 + 防重入标志释放。
#[tokio::test]
async fn fake_acp_crash_triggers_auto_reconnect() {
    let harness = boot_with_seeded_session(crash_args()).await;

    // 等待崩溃被 dispatcher 处理：状态置 Crashed + 自动重连已调度
    harness
        .wait_for_status(LifecycleStatusView::Crashed, 5)
        .await;
    assert!(
        harness.auto_reconnect_active(),
        "auto-reconnect must be scheduled on crash"
    );

    // 注入重连成功：自动重连（2s 退避）开始前把 agents 表切到 alive 模式
    harness.redefine_fake_agent("fake-acp", alive_args());

    // 等待自动重连完成：Connected + generation 前进 + 会话代际迁移（异步探针落定）
    harness
        .wait_for_status(LifecycleStatusView::Connected, 15)
        .await;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if harness.session_generation("source-a") == Some(1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("kept sessions must migrate generation within 15s");

    // 断言：generation +1、sessions 保留且迁移到新代际、防重入标志释放
    assert_eq!(
        harness.client_generation(),
        1,
        "auto-reconnect must bump generation"
    );
    assert_eq!(
        harness.sessions_len(),
        1,
        "sessions must survive auto-reconnect"
    );
    assert_eq!(
        harness.session_generation("source-a"),
        Some(1),
        "kept sessions must migrate generation"
    );
    assert!(
        !harness.auto_reconnect_active(),
        "auto-reconnect flag must release after loop"
    );
}

/// A5 回归：重连成功后又立即崩溃（crash-loop，激活后 200ms 退出）时，成功分支
/// 复查 still_stale 后继续退避重连，agent 不会因防重入标志吞掉第二次崩溃通知而
/// 永久下线（修复前 generation 永远停 1）。
#[tokio::test]
async fn fake_acp_crash_loop_keeps_reconnecting_then_flag_releases() {
    let harness = TestHarness::boot(HarnessConfig::new().with_fake_agent(
        "fake-acp",
        &["--scenario", "crash-after-init", "--delay-ms", "200"],
    ))
    .await;
    harness.seed_session("source-a", "fake-session-1", "persona", ".", 0);

    // 首次崩溃 → 自动重连已调度（标志 true）
    harness
        .wait_for_status(LifecycleStatusView::Crashed, 5)
        .await;
    assert!(
        harness.auto_reconnect_active(),
        "dispatcher must observe crash and schedule auto-reconnect"
    );

    // 持续崩溃：每次重连成功（generation +1）后 200ms 又崩 → 循环必须继续退避重连
    harness.wait_for_generation_at_least(2, 20).await;

    // 恢复场景收尾：切 alive + 手动 reconnect → 在途退避循环复查非 Crashed 提前
    // 放弃并释放防重入标志（可再次调度），agent 稳定 Connected。
    harness.redefine_fake_agent("fake-acp", alive_args());
    harness
        .manual_reconnect()
        .await
        .expect("manual reconnect must succeed");
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let connected = {
                // 状态 + 标志双条件
                harness.client_generation() >= 2 && !harness.auto_reconnect_active()
            };
            if connected {
                // 以 Connected 状态为准做最终确认
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("flag must release and agent must stay Connected within 15s");
    harness
        .wait_for_status(LifecycleStatusView::Connected, 15)
        .await;
    assert!(
        !harness.auto_reconnect_active(),
        "auto-reconnect flag must be released and reschedulable"
    );
}

/// A7 回归：洪泛 300 条（> BROADCAST_CAP=256）后 EOF——NOTIF_AGENT_CRASHED 广播
/// 必然被 Lagged 丢弃（dispatcher 逐条处理期间队列溢出），崩溃信号必须经独立
/// watch 通道送达，自动重连才仍会触发。
#[tokio::test]
async fn flood_crash_still_triggers_auto_reconnect_via_watch() {
    let harness = TestHarness::boot(
        HarnessConfig::new().with_fake_agent("fake-acp", &["--scenario", "flood"]),
    )
    .await;
    harness.seed_session("source-a", "fake-session-1", "persona", ".", 0);

    // 等待崩溃被 dispatcher 处理：状态置 Crashed（经 watch 路径，广播已丢）
    harness
        .wait_for_status(LifecycleStatusView::Crashed, 5)
        .await;
    assert!(
        harness.auto_reconnect_active(),
        "auto-reconnect must be scheduled on crash even after broadcast overflow"
    );
}

/// 核验回归：崩溃触发自动重连调度后，用户手动 reconnect 成功——自动重连闭包
/// 复查 status!=Crashed 提前放弃时**必须释放防重入标志**，否则下一次崩溃将永远
/// 不再自动重连。
#[tokio::test]
async fn manual_reconnect_releases_auto_reconnect_flag() {
    let harness = boot_with_seeded_session(crash_args()).await;

    // 崩溃 → 自动重连已调度（标志 true）
    harness.wait_for_auto_reconnect_scheduled(5).await;

    // 用户手动 reconnect：agents 表切 alive + 走手动连接路径（状态置 Connected）
    harness.redefine_fake_agent("fake-acp", alive_args());
    harness
        .manual_reconnect()
        .await
        .expect("manual reconnect must succeed");

    // 自动重连闭包（2s 退避后复查）发现 status!=Crashed → 提前放弃并释放标志
    harness.wait_for_auto_reconnect_released(10).await;
    assert_eq!(
        harness.client_generation(),
        1,
        "manual reconnect must bump generation"
    );
}

/// fake ACP：initialize 后主动发 request_permission（id 5），随后把 stdin 收到的
/// 每一行写入 trace（验证客户端应答 wire round-trip）。
#[tokio::test]
async fn fake_acp_request_permission_pends_then_resolves_on_wire() {
    let trace_path = TestHarness::temp_file("permission").with_extension("jsonl");
    let permission_params = serde_json::json!({
        "sessionId": "fake-session-p1",
        "toolCall": {"toolCallId": "call-9", "title": "edit_file",
                     "rawInput": "{\"token=SECRET}\",\"path\":\"x\"}"},
        "options": [
            {"optionId": "allow_once", "name": "Allow once", "kind": "allowOnce"},
            {"optionId": "reject_once", "name": "Reject", "kind": "rejectOnce"}
        ]
    })
    .to_string();

    let harness = TestHarness::boot(HarnessConfig::new().with_fake_agent(
        "fake-permission",
        &[
            "--scenario",
            "permission-proactive",
            "--permission-id",
            "5",
            "--permission-delay-ms",
            "500",
            "--trace-file",
            &trace_path.to_string_lossy(),
            "--permission-params",
            &permission_params,
        ],
    ))
    .await;
    // P0-3（R2-WI03）：request_permission 走 provider-scoped adapter dispatch，
    // fake agent 必须声明 provider=peri（未注册 provider 会被 dispatcher 丢弃）。
    harness.set_active_agent_provider("fake-permission", "peri");

    // 等 dispatcher 挂起权限请求，检查窄值视图（toolCallId / options / prompt 脱敏）
    let permission = harness.wait_for_pending_permission(5, 5).await;
    assert_eq!(permission.tool_call_id, "call-9");
    assert_eq!(permission.options.len(), 2);
    assert_eq!(permission.options[0].option_id, "allow_once");
    assert_eq!(permission.options[0].kind.as_deref(), Some("allowOnce"));
    assert_eq!(permission.options[0].name.as_deref(), Some("Allow once"));
    assert_eq!(permission.options[0].raw, None);
    assert_eq!(permission.options[1].option_id, "reject_once");
    assert_eq!(permission.options[1].kind.as_deref(), Some("rejectOnce"));
    assert!(
        !permission.prompt.contains("SECRET"),
        "事件 prompt 必须脱敏"
    );

    // 应答（approve_tool_call 等价路径）
    harness
        .resolve_permission(5, "allow_once")
        .await
        .expect("resolve must succeed");
    assert!(!harness.pending_permission_exists(5), "应答后必须清理挂起");

    // 等 fake ACP 收到响应并写入 trace
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if std::fs::metadata(&trace_path)
                .map(|meta| meta.len() > 0)
                .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
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
