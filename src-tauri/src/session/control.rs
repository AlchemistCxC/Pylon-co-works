//! 会话控制域：set_mode / set_config_option / close / cancel。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use super::*;
#[tauri::command]
pub(crate) async fn set_mode(
    state: tauri::State<'_, AppState>,
    source: String,
    mode: String,
) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source)?;
    state
        .inner()
        .acp_rpc(
            &runtime,
            acp::METHOD_SESSION_SET_MODE,
            acp::session_set_mode_params(&peri_id, &mode)?,
        )
        .await?;
    state.ensure_generation(&runtime, generation)?;
    state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
        session.mode = Some(mode);
    })?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn set_config_option(
    state: tauri::State<'_, AppState>,
    source: String,
    key: String,
    value: String,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source)?;
    // G2-03：D2 路由收敛——set_model_api 枚举三路（ConfigOption 默认 / SetModel /
    // Disabled）；route() 收编了 key=="model" 特判（G1 交付，agent_config.rs）。
    // 方案 4：路由按 target runtime 归属 agent 的 protocol 决定（protocol_for_runtime），
    // 而非 active agent 的协议——多 runtime/agents 表与注册不同步时避免跨 runtime
    // 读取错误协议策略；无 active runtime 时 require_runtime 已返回 no_active_agent。
    let target = state
        .protocol_for_runtime(&runtime)
        .set_model_api()
        .route(&key);
    let response = match target {
        crate::agent_config::ModelSwitchTarget::Disabled => {
            return Err(PylonError::Protocol("model switching disabled".to_string()));
        }
        crate::agent_config::ModelSwitchTarget::SetModel => {
            state
                .inner()
                .acp_rpc(
                    &runtime,
                    acp::METHOD_SESSION_SET_MODEL,
                    acp::session_set_model_params(&peri_id, &value)?,
                )
                .await?
        }
        crate::agent_config::ModelSwitchTarget::ConfigOption => {
            state
                .inner()
                .acp_rpc(
                    &runtime,
                    acp::METHOD_SESSION_SET_CONFIG_OPTION,
                    acp::session_set_config_option_params(&peri_id, &key, &value)?,
                )
                .await?
        }
    };
    state.ensure_generation(&runtime, generation)?;
    state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
        if let Some(options) = response
            .get("configOptions")
            .and_then(|value| value.as_array())
        {
            session.config_options = options.clone();
            session.apply_config_options(options);
        } else if key == "model" {
            session.model = value.clone();
        } else if key == "mode" {
            session.mode = Some(value.clone());
        }
    })?;
    Ok(response)
}

/// 方案 6：统一 close RPC 发送入口（四处 close 路径复用）。
/// 统一：close_via_rpc 判定、params 构造、method-not-found 类型化降级、
/// generation-bound（方案 5，旧 periId 不进入新 ACP）、日志。
/// 保留差异：strict=true（close_session，RemoteFirst）普通 RPC 错误上抛；
/// strict=false（expiry/replaced/unsettled，LocalFirstBestEffort）吞错误
/// （失败不阻断本地清理）。返回 Ok(实际尝试了 RPC)。
pub(crate) async fn close_session_rpc(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    peri_id: &str,
    generation: u64,
    strict: bool,
) -> Result<bool, PylonError> {
    if !state.protocol_for_runtime(runtime).close_via_rpc() {
        return Ok(false); // 声明式配置跳过 RPC，仅本地清理
    }
    let close_params = acp::session_close_params(peri_id).map_err(|e| PylonError::Protocol(e))?;
    let result = state
        .acp_rpc_generation_checked(
            runtime,
            acp::METHOD_SESSION_CLOSE,
            close_params,
            generation,
        )
        .await;
    match result {
        Ok(_) => Ok(true),
        Err(error) if error.is_method_not_found() => {
            tracing::warn!("agent does not support session/close ({error}); local cleanup only");
            Ok(true)
        }
        Err(error) if error.to_string().contains("stale ACP client generation") => {
            // 客户端已替换：本地清理仍执行（本地映射迁移到新代际），远端旧
            // session 由新 client 的会话清单/替换流程处理，不再发旧 periId。
            tracing::warn!("close skipped: ACP client replaced (stale generation)");
            Ok(true)
        }
        Err(error) if strict => Err(error.into()),
        Err(error) => {
            tracing::warn!("close session {peri_id}: {error}");
            Ok(true)
        }
    }
}

#[tauri::command]
pub(crate) async fn close_session(
    state: tauri::State<'_, AppState>,
    source: String,
) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _creation_guard = runtime.session_creation.lock().await;
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source)?;
    // 若该 session 有在途 prompt，先发 cancel（fire-and-forget）让 Peri 侧 settle，
    // 否则 pending oneshot 会挂到 PROMPT_TIMEOUT 才结束——close 后 prompt 卡死 300s。
    // 方案 5：cancel 在 acp 锁内发送，replacement（同样持 acp 锁）无法插入——
    // 旧 periId 的 cancel 不会写入新 ACP。
    {
        let acp = runtime.acp.lock().await;
        let _ = acp.cancel_session(&peri_id).await;
    }
    // 方案 6：统一 close RPC 入口（close_via_rpc 判定 + params + method-not-found
    // 降级 + generation-bound 隔离）。close_session 为 RemoteFirst：普通 RPC 错误
    // 上抛（strict=true）；-32601 / stale generation 降级为本地清理。
    close_session_rpc(&state, &runtime, &peri_id, generation, true).await?;
    // B9：close 时应答该 session 全部挂起的权限请求为 Cancelled
    crate::permission::respond_pending_permissions_cancelled(&runtime, &peri_id).await;
    state.ensure_generation(&runtime, generation)?;
    if !state.session_matches(&runtime, &source, &peri_id, generation)? {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    let _ = state.remove_session_if_matches(&runtime, &source, &peri_id, generation)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn cancel_prompt(
    state: tauri::State<'_, AppState>,
    source: String,
) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source)?;
    // Fire-and-forget notification — Peri will respond with stopReason=cancelled
    // 方案 5：cancel 在 acp 锁内发送，replacement（同样持 acp 锁）无法插入——
    // 旧 periId 的 cancel 不会写入新 ACP。锁外无发送窗口。
    // B9：cancel 时应答该 session 全部挂起的权限请求为 Cancelled（协议要求）
    crate::permission::respond_pending_permissions_cancelled(&runtime, &peri_id).await;
    state.ensure_generation(&runtime, generation)?;
    if !state.session_matches(&runtime, &source, &peri_id, generation)? {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    Ok(())
}
