//! host 工具门路由缝（#317 批次二 ④ 自 mod.rs 主泵分支迁入）：
//! terminal/* 与 fs/* 的 host_tools_policy 门 + 沙箱/registry 委派。
//! 两个分支在主泵中均为纯 `continue` 语义。

use super::{
    handle_filesystem_request, handle_terminal_request, session_workspace_root, AcpLock,
    SessionsLock,
};
use agent_client_protocol_schema::v1::ErrorCode as WireErrorCode;

/// terminal/* 请求（host_tools_policy 门；禁用回 Method Not Found）。
pub(crate) async fn route_terminal_request(
    acp: &AcpLock,
    terminal_registry: &crate::acp::terminal_runtime::TerminalRegistry,
    host_tools_policy: &std::sync::Mutex<crate::acp::host_tools::HostToolsPolicy>,
    raw: crate::acp::RawMessage,
) {
    if let Some(request_id) = raw.id {
        if host_tools_policy
            .lock()
            .map(|policy| policy.allows_terminal_request(raw.method.as_deref().unwrap_or_default()))
            .unwrap_or(false)
        {
            handle_terminal_request(
                acp,
                terminal_registry,
                raw.method.as_deref().unwrap_or_default(),
                request_id,
                raw.params.as_ref(),
            )
            .await;
        } else {
            let responder = { acp.lock().await.responder() };
            let _ = responder
                .respond_error(
                    request_id,
                    WireErrorCode::MethodNotFound,
                    "host terminal tools are disabled for this agent",
                )
                .await;
        }
    }
}

/// fs/read_text_file | fs/write_text_file 请求（host_tools_policy 门 + strict 沙箱根）。
pub(crate) async fn route_fs_request(
    acp: &AcpLock,
    host_tools_policy: &std::sync::Mutex<crate::acp::host_tools::HostToolsPolicy>,
    sessions: &SessionsLock,
    generation: u64,
    raw: crate::acp::RawMessage,
) {
    if let Some(request_id) = raw.id {
        let allowed = host_tools_policy
            .lock()
            .map(|policy| policy.allows_fs_request(raw.method.as_deref().unwrap_or_default()))
            .unwrap_or(false);
        if allowed {
            // #316（P0 修复）：strict = fs 门为 host 档。沙箱根取自
            // **Pylon 会话工作区**（按 params.sessionId 查 peri_id 映射
            // 的 SessionInfo.cwd）——不取 agent 自报 cwd：官方 fs 请求
            // 形状本无 cwd 字段，且沙箱根若由 agent 声明即可被
            // prompt 注入逃逸（声明 `cwd: "C:\\"` 放大沙箱到全盘）。
            // unrestricted = 不设根限制（语义与门名对齐）。
            let strict = host_tools_policy
                .lock()
                .map(|p| p.fs == crate::agent_config::HostToolsMode::Host)
                .unwrap_or(false);
            let filesystem = if strict {
                let peri_session = raw
                    .params
                    .as_ref()
                    .and_then(|v| v.get("sessionId").or_else(|| v.get("session_id")))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let workspace = session_workspace_root(sessions, peri_session, generation);
                match workspace {
                    Some(workspace) => {
                        match crate::acp::file_system_runtime::FileSystemRuntime::new_strict(
                            &workspace,
                        ) {
                            Ok(filesystem) => filesystem,
                            Err(_) => {
                                let responder = { acp.lock().await.responder() };
                                let _ = responder
                                    .respond_error(
                                        request_id,
                                        WireErrorCode::InvalidParams,
                                        "host filesystem workspace is inaccessible",
                                    )
                                    .await;
                                return;
                            }
                        }
                    }
                    None => {
                        let responder = { acp.lock().await.responder() };
                        let _ = responder
                            .respond_error(
                                request_id,
                                WireErrorCode::InvalidParams,
                                "host filesystem sandbox unavailable: session workspace unknown",
                            )
                            .await;
                        return;
                    }
                }
            } else {
                crate::acp::file_system_runtime::FileSystemRuntime::new(Vec::new())
            };
            handle_filesystem_request(
                acp,
                raw.method.as_deref().unwrap_or_default(),
                request_id,
                raw.params.as_ref(),
                filesystem,
            )
            .await;
        } else {
            let responder = { acp.lock().await.responder() };
            let _ = responder
                .respond_error(
                    request_id,
                    WireErrorCode::MethodNotFound,
                    "host filesystem tools are disabled for this agent",
                )
                .await;
        }
    }
}
