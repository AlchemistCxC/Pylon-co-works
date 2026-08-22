//! 隔离连接测试命令（自 mod.rs 拆分；行为零变化）。
//!
//! test_agent_connection / test_agent_candidate：复用 ACP connect 做一次真实握手，
//! 成功即 kill；不修改 active agent、不写 runtimes registry、不触发事件广播。

use super::*;
use crate::acp::{AcpClient, AcpError, AgentConnectFailure, AgentConnectStage};
use crate::agent_config::AgentDef;
use crate::error::PylonError;
use crate::AppState;

pub(super) const AGENT_VALIDATION_TIMEOUT_SECS: u64 = 15;

pub(crate) fn connection_test_error_payload_with_diagnostics(
    error: &AcpError,
    stderr: Option<&str>,
    exit_code: Option<i32>,
) -> serde_json::Value {
    let fallback;
    let failure = match error {
        AcpError::Connect(failure) => failure,
        _ => {
            fallback = AgentConnectFailure {
                stage: AgentConnectStage::Initialize,
                code: "agent_initialize_failed".to_string(),
                message: error.to_string(),
                exit_code: None,
                stderr_excerpt: None,
                retryable: true,
                io_kind: None,
                remote_code: None,
                remote_data_summary: None,
            };
            &fallback
        }
    };
    let action = if failure.code == "agent_executable_missing" {
        "select_executable"
    } else {
        "open-runtime-log"
    };
    serde_json::json!({
        "code": failure.code,
        "message": failure.message,
        "action": action,
        "stage": failure.stage,
        "exitCode": exit_code.or(failure.exit_code),
        "stderr": stderr.or(failure.stderr_excerpt.as_deref()),
        "retryable": failure.retryable,
        "ioKind": failure.io_kind,
        "remoteCode": failure.remote_code,
        "remoteDataSummary": failure.remote_data_summary,
    })
}

pub(crate) fn connection_test_error_payload(error: &AcpError) -> serde_json::Value {
    connection_test_error_payload_with_diagnostics(error, None, None)
}

/// 连接测试超时的 error payload（两处超时分支共用；字段与连接失败 payload 同形）。
pub(crate) fn connection_timeout_payload(timeout_secs: u64, stderr: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "code": "agent_connection_timeout",
        "message": format!("连接测试超时（{timeout_secs}s）"),
        "action": "open-runtime-log",
        "stage": "timeout",
        "exitCode": null,
        "stderr": stderr,
        "retryable": true,
        "ioKind": null,
        "remoteCode": null,
        "remoteDataSummary": null,
    })
}

pub(crate) fn candidate_stderr(logs: &crate::runtime_log::RuntimeLogHub) -> Option<String> {
    let lines = logs
        .list(&crate::runtime_log::RuntimeLogQuery {
            source: Some("agent-stderr".to_string()),
            limit: Some(16),
            ..Default::default()
        })
        .into_iter()
        .rev()
        .map(|entry| entry.message)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    let joined = lines.join("\n");
    Some(joined.chars().take(4096).collect())
}

async fn settle_candidate_stderr(started: std::time::Instant) {
    // stdout/RPC 关闭与 stderr reader 在不同异步任务中收敛。只使用握手总预算内
    // 尚未消耗的极短窗口，避免错误返回抢在最后一行安全诊断之前，同时保证命令
    // 从开始到返回仍不超过 15 秒的候选验证上限。
    let remaining = std::time::Duration::from_secs(AGENT_VALIDATION_TIMEOUT_SECS)
        .saturating_sub(started.elapsed());
    let settle = remaining.min(std::time::Duration::from_millis(50));
    if !settle.is_zero() {
        tokio::time::sleep(settle).await;
    }
}

/// 隔离连接测试（施工文档 §4.5）：复用 ACP connect 做一次真实握手，成功后立即
/// kill 子进程。不修改 active agent、不写 runtimes registry、不触发 agent-switched。
#[tauri::command]
pub(crate) async fn test_agent_connection(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    let agent = agent_from_registry(inner, &agent_id)?;

    let started = std::time::Instant::now();
    // 施工文档 §4.5：后端用 tokio::time::timeout 包裹整个 connect；禁止无限等待。
    let timeout_secs = AGENT_VALIDATION_TIMEOUT_SECS;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        AcpClient::connect_with_generation(&agent, Some(inner.runtime_logs.clone()), 0),
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(mut client)) => {
            let _ = client.kill();
            Ok(serde_json::json!({
                "ok": true,
                "agentId": agent_id,
                "durationMs": duration_ms,
                "error": null,
            }))
        }
        Ok(Err(error)) => Ok(serde_json::json!({
            "ok": false,
            "agentId": agent_id,
            "durationMs": duration_ms,
            "error": connection_test_error_payload(&error),
        })),
        Err(_elapsed) => Ok(serde_json::json!({
            "ok": false,
            "agentId": agent_id,
            "durationMs": duration_ms,
            "error": connection_timeout_payload(timeout_secs, None),
        })),
    }
}

/// Candidate validation is isolated like test_agent_connection, but consumes an ephemeral
/// definition and never writes agents.yaml or mutates the runtime registry.
#[tauri::command]
pub(crate) async fn test_agent_candidate(
    _state: tauri::State<'_, AppState>,
    agent_id: String,
    agent: AgentDef,
) -> Result<serde_json::Value, PylonError> {
    let started = std::time::Instant::now();
    let timeout_secs = AGENT_VALIDATION_TIMEOUT_SECS;
    // 候选验证使用隔离日志池：既能返回该次握手的安全 stderr，又不污染运行时日志。
    let diagnostic_logs = crate::runtime_log::RuntimeLogHub::new(64);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        AcpClient::connect_with_generation(&agent, Some(diagnostic_logs.clone()), 0),
    )
    .await;
    match result {
        Ok(Ok(mut client)) => {
            let _ = client.kill();
            let duration_ms = started.elapsed().as_millis() as u64;
            Ok(
                serde_json::json!({ "ok": true, "agentId": agent_id, "durationMs": duration_ms, "error": null }),
            )
        }
        Ok(Err(error)) => {
            settle_candidate_stderr(started).await;
            let duration_ms = started.elapsed().as_millis() as u64;
            let stderr = candidate_stderr(&diagnostic_logs);
            Ok(serde_json::json!({
                "ok": false,
                "agentId": agent_id,
                "durationMs": duration_ms,
                "error": connection_test_error_payload_with_diagnostics(&error, stderr.as_deref(), None),
            }))
        }
        Err(_) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            Ok(serde_json::json!({
                "ok": false,
                "agentId": agent_id,
                "durationMs": duration_ms,
                "error": connection_timeout_payload(timeout_secs, candidate_stderr(&diagnostic_logs)),
            }))
        }
    }
}
