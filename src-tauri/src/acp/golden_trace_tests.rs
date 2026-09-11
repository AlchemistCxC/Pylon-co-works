//! A0：Pylon 现有 ACP 的 golden trace 基线生成器（test-only，不改运行路径）。
//!
//! 目的：在 A1a 换官方 `agent-client-protocol` 引擎之前，把当前手写 ACP 在
//! 8 个场景下的 wire 时序固化为**可重复生成**的基线，供 A1c / A9 的 parity 比较。
//!
//! 启用方式：
//!
//! ```text
//! PYLON_GOLDEN_TRACE_DIR=<dir> cargo test --lib acp::golden_trace_tests::golden_trace_baseline_generation
//! ```
//!
//! 未设置环境变量时该测试直接返回（no-op），因此不影响常规 `cargo test --lib acp::`。
//! 生成入口与确定性校验见 `scripts/generate-acp-golden-trace.mjs`（连跑两遍并
//! 逐字节比对）。
//!
//! 记录形状：`WireRecord` 去掉机器相关的 `traceId` / `timestamp`，补上三条身份轴
//! —— `owner`（durable session owner key）、`generation`（`clientGeneration`）、
//! `ordinal`（= `monotonicSeq`）——再加 `scenario` 列。

use std::path::PathBuf;
use std::time::Duration;

use super::wire_trace::{WireDirection, WireIdKind, WireRecord};
use super::{AcpClient, AcpError, METHOD_SESSION_LOAD, METHOD_SESSION_NEW};

/// A0 固定场景清单（顺序即基线文件生成顺序，对应施工书 §A0 步骤 4）。
pub(crate) const SCENARIOS: [&str; 10] = [
    "initialize",
    "new_load",
    "prompt",
    "tool",
    "permission",
    "done_error",
    "cancel",
    "reconnect",
    // A5①：wrapper provider 的基线。这两个场景带真实 `provider`，把
    // catalog 声明的 clientCapabilities 与实际启动路径一起钉进 wire 基线。
    "wrapper_claude",
    "wrapper_codex",
];

/// 施工书 §A0 步骤 4 点名的 8 个场景。与 [`SCENARIOS`] 的前缀断言对齐：
/// 新增场景只允许追加，不得删改这 8 个。
const CONSTRUCTION_BOOK_SCENARIOS: [&str; 8] = [
    "initialize",
    "new_load",
    "prompt",
    "tool",
    "permission",
    "done_error",
    "cancel",
    "reconnect",
];

/// A5① wrapper 场景 → catalog provider。`None` = 不带 provider 的基线场景。
fn scenario_provider(scenario: &str) -> Option<&'static str> {
    match scenario {
        "wrapper_claude" => Some("claude-code"),
        "wrapper_codex" => Some("codex"),
        _ => None,
    }
}

/// 基线使用的 durable owner（真实 `DurableSessionOwner`，不是占位字符串）。
const OWNER_PARTS: (&str, &str, &str) = ("golden-profile", "fake-acp-golden", "local:golden");
const SESSION_ID: &str = "golden-session";
/// permission 场景的 agent 请求 id（数字形态，便于测试用 responder 应答）。
const PERMISSION_REQUEST_ID: u64 = 9001;

/// 单一 fake agent 脚本，按 `GOLDEN_SCENARIO` 分支；避免为 8 个场景维护 8 份脚本。
const GOLDEN_AGENT_SCRIPT: &str = r#"import json,sys,os
scenario = os.environ.get('GOLDEN_SCENARIO', 'initialize')
pending_prompt = None
def emit(payload):
    print(json.dumps(payload), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method is None:
        # 客户端应答（permission）——收到后结束当前 prompt。
        if pending_prompt is not None:
            emit({'jsonrpc': '2.0', 'id': pending_prompt, 'result': {'stopReason': 'end_turn'}})
            pending_prompt = None
        continue
    rid = request.get('id')
    params = request.get('params') or {}
    session_id = params.get('sessionId', 'golden-session')
    if method == 'initialize':
        emit({'jsonrpc': '2.0', 'id': rid, 'result': {'agentCapabilities': {'loadSession': True}}})
    elif method == 'session/new':
        emit({'jsonrpc': '2.0', 'id': rid, 'result': {'sessionId': 'golden-session'}})
    elif method == 'session/load':
        for text in ['history-1', 'history-2']:
            emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': session_id,
                'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'text': text}}}})
        emit({'jsonrpc': '2.0', 'id': rid, 'result': {'loaded': True}})
    elif method == 'session/prompt':
        pending_prompt = rid
        emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': session_id,
            'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'text': 'golden reply'}}}})
        if scenario == 'tool':
            emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': session_id,
                'update': {'sessionUpdate': 'tool_call', 'toolCallId': 'tc-golden', 'title': 'golden tool',
                           'status': 'in_progress'}}})
            emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': session_id,
                'update': {'sessionUpdate': 'tool_call_update', 'toolCallId': 'tc-golden', 'status': 'completed',
                           'content': [{'type': 'text', 'text': 'tool output'}]}}})
            emit({'jsonrpc': '2.0', 'id': rid, 'result': {'stopReason': 'end_turn'}})
            pending_prompt = None
        elif scenario == 'permission':
            emit({'jsonrpc': '2.0', 'id': 9001, 'method': 'session/request_permission',
                  'params': {'sessionId': session_id, 'toolCallId': 'tc-golden',
                             'options': [{'optionId': 'allow_once', 'name': 'Allow once'},
                                         {'optionId': 'deny', 'name': 'Deny'}]}})
        elif scenario == 'done_error':
            emit({'jsonrpc': '2.0', 'id': rid, 'error': {'code': -32000, 'message': 'golden failure'}})
            pending_prompt = None
        elif scenario == 'cancel':
            pass
        else:
            emit({'jsonrpc': '2.0', 'id': rid, 'result': {'stopReason': 'end_turn'}})
            pending_prompt = None
    elif method == 'session/cancel':
        if pending_prompt is not None:
            emit({'jsonrpc': '2.0', 'id': pending_prompt, 'result': {'stopReason': 'cancelled'}})
            pending_prompt = None
    else:
        emit({'jsonrpc': '2.0', 'id': rid, 'result': {}})
"#;

fn trace_dir() -> Option<PathBuf> {
    std::env::var("PYLON_GOLDEN_TRACE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn golden_agent(scenario: &str) -> crate::agent_config::AgentDef {
    let mut env = std::collections::HashMap::new();
    env.insert("GOLDEN_SCENARIO".to_string(), scenario.to_string());
    let mut agent = crate::test_utils::fake_acp_agent_with(
        "fake-acp-golden",
        GOLDEN_AGENT_SCRIPT,
        Vec::new(),
        env,
    );
    // A5①：wrapper 场景带真实 provider，使 catalog 声明的 clientCapabilities 与
    // provider 身份一起进入 wire 基线；其余场景保持 provider = None（P60 基线不变）。
    agent.provider = scenario_provider(scenario).map(str::to_string);
    agent
}

fn owner_key() -> String {
    crate::session::DurableSessionOwner::new(OWNER_PARTS.0, OWNER_PARTS.1, OWNER_PARTS.2)
        .key()
        .expect("golden owner must be valid")
}

fn text_block() -> serde_json::Value {
    serde_json::json!({"type": "text", "text": "golden prompt"})
}

/// 归一化：丢弃机器相关字段，补 scenario/connection/owner/generation/ordinal。
/// `connections` 每个元素是一条连接的快照（reconnect 场景有两条）。
fn normalize(connections: &[Vec<WireRecord>], scenario: &str, owner: &str) -> String {
    connections
        .iter()
        .enumerate()
        .flat_map(|(index, records)| {
            // SDK 为出站请求生成 UUID，而 legacy 基线使用递增数字。将每条连接内
            // 首次出现的 wire id 映射到稳定序号，保留 idKind 与请求/响应关联，
            // 这样 golden trace 比较的是 id 语义和顺序，而不是机器随机 UUID。
            let mut id_numbers = std::collections::HashMap::<String, u64>::new();
            let mut next_id = 1_u64;
            records.iter().map(move |record| {
                let mut value =
                    serde_json::to_value(record).expect("wire record must serialize to JSON");
                let object = value
                    .as_object_mut()
                    .expect("wire record must serialize to a JSON object");
                object.remove("traceId");
                object.remove("timestamp");
                // 身份三轴：owner / generation / ordinal（施工书 §A0 步骤 4）。
                object.remove("clientGeneration");
                object.insert("scenario".into(), serde_json::json!(scenario));
                object.insert("connection".into(), serde_json::json!(index + 1));
                object.insert("owner".into(), serde_json::json!(owner));
                object.insert(
                    "generation".into(),
                    serde_json::json!(record.client_generation),
                );
                object.insert("ordinal".into(), serde_json::json!(record.monotonic_seq));
                if let Some(id) = object.get("idValue").cloned() {
                    if !id.is_null() {
                        let key = serde_json::to_string(&id).expect("wire id must serialize");
                        let stable_id = if let Some(existing) = id_numbers.get(&key) {
                            *existing
                        } else {
                            let assigned = next_id;
                            next_id += 1;
                            id_numbers.insert(key, assigned);
                            assigned
                        };
                        let normalized = match object.get("idKind").and_then(|kind| kind.as_str()) {
                            Some("number") => serde_json::json!(stable_id),
                            Some("string") => serde_json::json!(format!("wire-{stable_id}")),
                            _ => id,
                        };
                        object.insert("idValue".into(), normalized);
                    }
                }
                serde_json::to_string(&value).expect("normalized record must serialize")
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn new_session(client: &AcpClient) -> Result<(), AcpError> {
    client
        .prepare_rpc(
            METHOD_SESSION_NEW,
            serde_json::json!({"cwd": ".", "mcpServers": []}),
        )?
        .complete()
        .await?;
    Ok(())
}

async fn load_session(client: &AcpClient) -> Result<(), AcpError> {
    client
        .prepare_rpc(
            METHOD_SESSION_LOAD,
            serde_json::json!({"sessionId": SESSION_ID, "cwd": ".", "mcpServers": []}),
        )?
        .complete()
        .await?;
    Ok(())
}

async fn prompt(client: &AcpClient) -> Result<serde_json::Value, AcpError> {
    client
        .prepare_prompt(SESSION_ID, vec![text_block()])?
        .complete()
        .await
}

/// 轮询等待 agent 发出 `session/request_permission`，且 SDK 已登记对应 responder。
/// wire capture 与 dispatch handler 是两个异步观察点，不能只看到 capture 就立即应答。
async fn wait_for_permission_request(client: &AcpClient) -> super::RequestId {
    let trace = client
        .wire_trace()
        .expect("golden client must expose wire trace");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(record) = trace.snapshot().into_iter().find(|record| {
            record.method.as_deref() == Some("session/request_permission")
                && record.direction == WireDirection::AgentToPylon
        }) {
            let id = record
                .id_value
                .as_ref()
                .and_then(super::RequestId::from_json_value)
                .unwrap_or(super::RequestId::Number(PERMISSION_REQUEST_ID));
            let registered = client
                .backend
                .pending_requests
                .lock()
                .map(|pending| pending.contains_key(&id))
                .unwrap_or(false);
            if registered {
                return id;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "golden permission request must arrive within 5s"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// 驱动一个场景，返回每条连接的 wire 记录（reconnect 场景含两代连接）。
async fn drive_scenario(scenario: &str) -> Result<Vec<Vec<WireRecord>>, AcpError> {
    let agent = golden_agent(scenario);
    let mut client = AcpClient::connect_with_generation(&agent, None, 1).await?;
    let trace = client
        .wire_trace()
        .expect("golden client must expose wire trace");

    match scenario {
        "initialize" => {}
        "new_load" => {
            new_session(&client).await?;
            load_session(&client).await?;
        }
        "prompt" | "tool" | "done_error" => {
            new_session(&client).await?;
            let _ = prompt(&client).await;
        }
        "permission" => {
            new_session(&client).await?;
            let mut rx = client
                .prepare_prompt(SESSION_ID, vec![text_block()])?
                .send_keep_rx()
                .await?;
            let request_id = wait_for_permission_request(&client).await;
            assert!(
                client
                    .responder()
                    .respond(
                        request_id,
                        serde_json::json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}}),
                    )
                    .await,
                "golden trace responder must answer the permission request"
            );
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut rx).await;
        }
        "cancel" => {
            new_session(&client).await?;
            let mut rx = client
                .prepare_prompt(SESSION_ID, vec![text_block()])?
                .send_keep_rx()
                .await?;
            client.cancel_session(SESSION_ID).await?;
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut rx).await;
        }
        "reconnect" => {
            new_session(&client).await?;
            let _ = prompt(&client).await;
            client.kill()?;
            let mut second = AcpClient::connect_with_generation(&agent, None, 2).await?;
            let second_trace = second
                .wire_trace()
                .expect("golden client must expose wire trace");
            load_session(&second).await?;
            let mut records = vec![trace.snapshot()];
            records.push(second_trace.snapshot());
            second.kill()?;
            return Ok(records);
        }
        // A5①：wrapper provider 走完整的 initialize → session/new → prompt，
        // 与真实会话同一条路径（都经 `spawn_agent_child` 的 LaunchPlan）。
        "wrapper_claude" | "wrapper_codex" => {
            new_session(&client).await?;
            let _ = prompt(&client).await;
        }
        other => panic!("unknown golden scenario: {other}"),
    }

    let records = vec![trace.snapshot()];
    client.kill()?;
    Ok(records)
}

/// 生成基线：仅在 `PYLON_GOLDEN_TRACE_DIR` 设置时执行（否则 no-op）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn golden_trace_baseline_generation() {
    let Some(dir) = trace_dir() else {
        return;
    };
    std::fs::create_dir_all(&dir).expect("golden trace dir must be creatable");
    let owner = owner_key();
    for scenario in SCENARIOS {
        let records = tokio::time::timeout(Duration::from_secs(30), drive_scenario(scenario))
            .await
            .unwrap_or_else(|_| panic!("golden scenario {scenario} timed out"))
            .unwrap_or_else(|error| panic!("golden scenario {scenario} failed: {error:?}"));
        assert!(
            records.iter().any(|connection| !connection.is_empty()),
            "golden scenario {scenario} produced no wire records"
        );
        let jsonl = normalize(&records, scenario, &owner);
        std::fs::write(dir.join(format!("{scenario}.jsonl")), format!("{jsonl}\n"))
            .expect("golden trace must be writable");
    }
}

/// 场景清单与施工书 §A0 步骤 4 的 8 个场景逐项对齐（常驻断言，不依赖环境变量）。
///
/// A5① 追加了两个 wrapper 场景，所以这里断言的是「施工书 8 场景是 SCENARIOS 的
/// 前缀」而不是「SCENARIOS 就是这 8 个」——前缀断言仍然禁止删改/重排原 8 场景，
/// 只是允许向后追加（严格程度不降）。
#[test]
fn golden_trace_scenarios_match_construction_book() {
    assert_eq!(
        &SCENARIOS[..CONSTRUCTION_BOOK_SCENARIOS.len()],
        &CONSTRUCTION_BOOK_SCENARIOS[..]
    );
    assert_eq!(SCENARIOS.len(), CONSTRUCTION_BOOK_SCENARIOS.len() + 2);
}

/// A5① 验收：wrapper 场景必须带真实 provider，否则基线里就看不出声明是 provider
/// 作用域的（`initialize` 的 `clientCapabilities` 会与无 provider 场景同形）。
#[test]
fn wrapper_scenarios_carry_their_catalog_provider() {
    assert_eq!(scenario_provider("wrapper_claude"), Some("claude-code"));
    assert_eq!(scenario_provider("wrapper_codex"), Some("codex"));
    for scenario in CONSTRUCTION_BOOK_SCENARIOS {
        assert_eq!(
            scenario_provider(scenario),
            None,
            "{scenario} 必须保持无 provider"
        );
    }
    // 带 provider 的场景必须真的能在 catalog 里解析出 profile。
    for scenario in ["wrapper_claude", "wrapper_codex"] {
        let provider = scenario_provider(scenario).expect("wrapper 场景必须有 provider");
        assert!(
            crate::agent_catalog::provider_profile(provider)
                .expect("catalog 必须可解析")
                .is_some(),
            "{provider} 必须在 catalog 中"
        );
    }
}

/// 归一化必须去掉机器相关字段、保留身份轴。
#[test]
fn golden_trace_normalization_drops_volatile_fields() {
    let record = WireRecord {
        trace_id: "fake-acp-golden-42".to_string(),
        monotonic_seq: 7,
        timestamp: crate::time::Timestamp::new(1_700_000_000_000),
        agent_id: "fake-acp-golden".to_string(),
        provider: None,
        source: "acp".to_string(),
        local_session_id: None,
        remote_session_id: Some(SESSION_ID.to_string()),
        peri_id: None,
        client_generation: 1,
        request_id: None,
        direction: WireDirection::PylonToAgent,
        method: Some("session/prompt".to_string()),
        id_kind: WireIdKind::Number,
        id_value: Some(serde_json::json!(2)),
        params: None,
        result: None,
        error: None,
        tool_call_id: None,
        status: "sent".to_string(),
    };
    let line = normalize(&[vec![record]], "prompt", "owner-key");
    let value: serde_json::Value = serde_json::from_str(&line).expect("normalized JSON");
    assert!(value.get("traceId").is_none());
    assert!(value.get("timestamp").is_none());
    assert_eq!(value["scenario"], "prompt");
    assert_eq!(value["connection"], 1);
    assert_eq!(value["owner"], "owner-key");
    assert_eq!(value["ordinal"], 7);
    assert_eq!(value["generation"], 1);
    assert_eq!(value["idKind"], "number");
    assert_eq!(value["status"], "sent");
}
