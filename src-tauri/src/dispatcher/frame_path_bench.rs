//! #331/U4 裁决：dispatcher 逐帧热路径基准——P2/P3/P5 改造前的数值基线。
//!
//! 频率假设（issue #331 P 节）：一轮流式回合产生 10²–10⁴ 帧 `session/update`，
//! 故以「每帧成本」为口径。方法论对齐 `pylon-session/src/storage_write_bench.rs`：
//! `#[cfg(test)]` 模块 + `#[test]` 载体，`cargo test -p pylon frame_path_bench --
//! --nocapture` 运行并读取打印值；**断言只钉功能不变量，不钉墙钟**（时序断言在
//! CI 会抖动），数字供开发记录对比「改造前/后」。
//!
//! 覆盖四个逐帧组件：
//! 1. `apply_update_event_with_pet_policy`（dispatcher 逐帧总入口，含 P2 第一处
//!    的 `json!` 喂食深拷贝 + reducer 应用 + delta 匹配）；
//! 2. `AcpSessionState::apply`（pylon-acp reducer 单独，chunk 文本路径）；
//! 3. `should_flush_batch`（P4 已改 `DurableSessionOwner` 值比较的窗口归属决策）；
//! 4. tool `rawOutput` 累积（P5 的 O(K²)——K=64 与 K=512 的每轮成本对比呈现增长）。

use std::time::Instant;

use super::canonical_flush::{should_flush_batch, PendingCanonicalPublish};
use super::routing::RoutingInput;
use super::{apply_update_event_with_pet_policy, SessionsLock};
use crate::acp::{AcpKind, RawMessage, ReplayClassification};
use crate::session::{DurableSessionOwner, SessionInfo};

const BENCH_AGENT_ID: &str = "agent-bench";
const BENCH_SOURCE: &str = "src-bench";
const BENCH_PERI_ID: &str = "peri-bench";

fn bench_session() -> SessionInfo {
    let mut session = SessionInfo::new(
        BENCH_PERI_ID.to_string(),
        BENCH_SOURCE.to_string(),
        "cwd".to_string(),
        true,
        1,
    );
    session
        .attach_profile_id(Some("profile-bench"), BENCH_SOURCE)
        .expect("attach profile");
    session
}

fn text_chunk_raw(session_id: &str, text: &str) -> RawMessage {
    RawMessage {
        id: None,
        method: Some(crate::acp::NOTIF_SESSION_UPDATE.to_string()),
        kind: AcpKind::SessionUpdate,
        result: None,
        params: Some(serde_json::json!({
            "sessionId": session_id,
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": text}}
        })),
        error: None,
    }
}

fn tool_update_raw(session_id: &str, output: &str) -> RawMessage {
    RawMessage {
        id: None,
        method: Some(crate::acp::NOTIF_SESSION_UPDATE.to_string()),
        kind: AcpKind::SessionUpdate,
        result: None,
        params: Some(serde_json::json!({
            "sessionId": session_id,
            "update": {"sessionUpdate": "tool_call_update", "toolCallId": "t-bench", "rawOutput": output}
        })),
        error: None,
    }
}

fn bench_pending_batch(owner: DurableSessionOwner) -> Vec<PendingCanonicalPublish> {
    // 窗口取常态下限：MAX_PENDING_CANONICAL_EVENTS=32 之前最常见的小批次。
    (0..8)
        .map(|_| PendingCanonicalPublish {
            input: RoutingInput {
                source: BENCH_SOURCE.to_string(),
                remote_session_id: BENCH_PERI_ID.to_string(),
                generation: 1,
                owner: Some(owner.clone()),
                classification: ReplayClassification::Live,
                variant: None,
                replay_loading: false,
                payload: serde_json::json!({"seq": 0}),
                wire_ordinal: None,
            },
            decision: super::routing::RoutingDecision {
                class: super::routing::RoutingClass::Live,
                variant: None,
                mutate_session: true,
                collect_response: true,
                apply_pet: false,
                persist_canonical: true,
                publish: true,
            },
            pet_events: Vec::new(),
            session_state_to_persist: None,
            wire: None,
        })
        .collect()
}

fn ns_per_iter(started: Instant, iterations: usize) -> u128 {
    started.elapsed().as_nanos() / iterations.max(1) as u128
}

/// 逐帧总入口：文本 chunk 走完整 `apply_update_event_with_pet_policy`
///（含 json! 深拷贝喂食）。功能不变量：usage/tools 不被 chunk 触碰。
#[test]
fn frame_cost_apply_update_event_with_pet_policy_text_chunk() {
    const FRAMES: usize = 20_000;
    let mut session = bench_session();
    let update = serde_json::json!({
        "sessionUpdate": "agent_message_chunk",
        "content": {"text": "基准帧"}
    });
    let started = Instant::now();
    for _ in 0..FRAMES {
        let events = apply_update_event_with_pet_policy(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::AgentMessageChunk),
            true,
        );
        assert!(events.is_empty(), "text chunk 不产出宠物事件");
    }
    println!(
        "frame-bench apply_update_event_with_pet_policy(text-chunk): {} ns/frame (N={FRAMES})",
        ns_per_iter(started, FRAMES)
    );
}

/// reducer 单独：`AcpSessionState::apply` 的 chunk 文本路径。
#[test]
fn frame_cost_acp_state_apply_text_chunk() {
    const FRAMES: usize = 20_000;
    let mut state = crate::acp::AcpSessionState::default();
    let raw = text_chunk_raw("s", "基准帧");
    let started = Instant::now();
    for _ in 0..FRAMES {
        let deltas = state.apply(&raw);
        assert!(matches!(
            deltas.as_slice(),
            [crate::acp::AcpStateDelta::Text { .. }]
        ));
    }
    println!(
        "frame-bench acp_state_apply(text-chunk): {} ns/frame (N={FRAMES})",
        ns_per_iter(started, FRAMES)
    );
}

/// 窗口归属决策：owner 同质的 8 项在途批次 + 每帧 owner 值比较（P4 后形态）。
#[test]
fn frame_cost_should_flush_batch_owner_homogeneous() {
    const FRAMES: usize = 20_000;
    let session = bench_session();
    let owner = session
        .durable_owner(BENCH_AGENT_ID, BENCH_SOURCE)
        .expect("durable_owner")
        .expect("profile 已附着 → Some");
    let sessions: SessionsLock = std::sync::Mutex::new(std::collections::HashMap::from([(
        BENCH_SOURCE.to_string(),
        session,
    )]));
    let pending = bench_pending_batch(owner);
    let raw = text_chunk_raw(BENCH_PERI_ID, "基准帧");
    let classification = ReplayClassification::Live;
    let started = Instant::now();
    for _ in 0..FRAMES {
        let flush = should_flush_batch(
            &pending,
            &raw,
            &classification,
            &sessions,
            1,
            BENCH_AGENT_ID,
        );
        assert!(
            !flush,
            "owner/session/generation 同质且非 user chunk → 不 flush"
        );
    }
    println!(
        "frame-bench should_flush_batch(8-pending, owner-compare): {} ns/frame (N={FRAMES})",
        ns_per_iter(started, FRAMES)
    );
}

/// P5 基线证据：`rawOutput` 累积的 O(K²)——K=64 与 K=512 的每轮成本对比。
/// 功能不变量：K 轮后累积值等于 K 份增量的顺序拼接。
#[test]
fn frame_cost_tool_raw_output_accumulation_grows_quadratic() {
    for frames in [64usize, 512] {
        let chunk = "x".repeat(64);
        let mut state = crate::acp::AcpSessionState::default();
        let first = RawMessage {
            id: None,
            method: Some(crate::acp::NOTIF_SESSION_UPDATE.to_string()),
            kind: AcpKind::SessionUpdate,
            result: None,
            params: Some(serde_json::json!({
                "sessionId": "s",
                "update": {"sessionUpdate": "tool_call", "toolCallId": "t-bench"}
            })),
            error: None,
        };
        state.apply(&first);
        let started = Instant::now();
        for _ in 0..frames {
            state.apply(&tool_update_raw("s", &chunk));
        }
        let accumulated = state.tools["t-bench"]["rawOutput"]
            .as_str()
            .expect("rawOutput str");
        assert_eq!(accumulated.len(), frames * 64, "K 轮累积长度");
        println!(
            "frame-bench tool_raw_output_accumulate: {} ns/frame (K={frames}, accumulated={}B)",
            ns_per_iter(started, frames),
            accumulated.len()
        );
    }
}

/// 基准自检：`should_flush_batch` 的跨 owner 批次拒绝仍生效（P4 改动面回归）。
#[test]
fn should_flush_batch_rejects_cross_owner_pending() {
    let session = bench_session();
    let sessions: SessionsLock = std::sync::Mutex::new(std::collections::HashMap::from([(
        BENCH_SOURCE.to_string(),
        session,
    )]));
    // 在途批次持有一个与当前会话不同的 owner → 必须判 flush。
    let foreign_owner = DurableSessionOwner::new("profile-other", BENCH_AGENT_ID, "src-other");
    let pending = bench_pending_batch(foreign_owner);
    let raw = text_chunk_raw(BENCH_PERI_ID, "基准帧");
    let classification = ReplayClassification::Live;
    assert!(should_flush_batch(
        &pending,
        &raw,
        &classification,
        &sessions,
        1,
        BENCH_AGENT_ID
    ));
}
