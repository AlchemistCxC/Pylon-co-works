//! 会话创建域：槽位替换 / session/new / 建立与复用。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use super::*;
/// R32：会话槽位替换——上限检查 + 插入新 SessionInfo +
/// 返回被替换的旧会话（None = 新槽位）。`allow_same_source_replace`：
/// true = 同 source 替换不占新名额（load_persisted_session 既有语义）；
/// false = 满额即拒绝，无论是否替换（new_session 既有语义）。
/// G2-07：上限参数化（E9 拍板 per-agent——调用方传 SessionSlotPolicy::default()
/// 解析值，每 runtime 100；G1 acp.max_sessions 落地后按 agent 解析覆盖）。
/// 检查与插入在同一写锁内完成；会话创建路径由 session_creation 串行化，
/// 与原先"读锁检查 + 写锁插入"行为等价。
pub(crate) fn replace_session_slot(
    runtime: &AgentRuntime,
    source: &str,
    session: SessionInfo,
    allow_same_source_replace: bool,
    max_sessions: usize,
) -> Result<Option<SessionInfo>, PylonError> {
    // 方案 8：委托 SessionStore（满额策略 + mapping_ready 通知 + 锁序纪律）。
    crate::session_store::insert(
        runtime,
        source,
        session,
        allow_same_source_replace,
        max_sessions,
    )
    .map_err(|e| PylonError::Protocol(e.to_string()))
}

/// G2-04：会话建立结果——peri_id + 是否首轮 + session/new 原始响应（new_session 命令回传前端）。
pub(crate) struct SessionMapping {
    pub(crate) peri_id: String,
    pub(crate) is_first: bool,
    pub(crate) new_response: Option<serde_json::Value>,
}

/// G2-04：无条件建会话——上限检查 + session/new RPC + ensure_generation +
/// SessionInfo 构造 + apply_session_response + replace_session_slot（notify 唯一出口）+
/// 可选 close 被替换旧会话（new_session 语义；E7 拍板：ensure 路径也传 true）。
/// 调用方必须持有 runtime.session_creation 锁（并发建会话串行化，覆盖"检查 +
/// RPC + 插入"全程；tokio Mutex 不可重入，本函数内部不取锁）；RPC await 期间
/// 不持 sessions 锁（V14），await 后 ensure_generation（RPC 后位置不变量）。
/// "Session creation failed" 日志在本函数内发出（唯一出口）。
async fn create_session_slot(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    profile_id: Option<&str>,
    persona: &str,
    session_cwd: &str,
    workspace_id: Option<String>,
    wire_mcp_servers: &[serde_json::Value],
    close_replaced: bool,
) -> Result<SessionMapping, PylonError> {
    {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= crate::agent_runtime::SessionSlotPolicy::default().max_sessions {
            return Err(PylonError::Protocol("max sessions reached".to_string()));
        }
    }
    let generation = state.current_generation(runtime);
    // G2-07：McpServersMode 消费（G1 入口，E4 警告语义见 acp.rs 构造器 doc）——
    // per-agent 协议配置解析，缺省 Always = 现状 wire；OmitIfEmpty 显式删键（v2 语义）。
    let params = acp::session_new_params(
        session_cwd,
        wire_mcp_servers.to_vec(),
        state.protocol_for_runtime(runtime).mcp_servers,
    )?;
    let mut response = match state
        .acp_rpc(runtime, acp::METHOD_SESSION_NEW, params)
        .await
    {
        Ok(response) => response,
        Err(error) => {
            state.log_runtime_summary(
                "error",
                "session",
                Some(source.to_string()),
                "Session creation failed",
                serde_json::Map::new(),
            );
            return Err(error.into());
        }
    };
    state.ensure_generation(runtime, generation)?;
    let peri_id = crate::acp::session_id_from(&response)?;
    let mut session = SessionInfo::new(
        peri_id.clone(),
        persona.to_string(),
        session_cwd.to_string(),
        false,
        generation,
    );
    session.profile_id = profile_id.map(str::to_string);
    // CWD-03：Workspace 绑定（方案 C；None = legacy 未绑定，root 解析回退 cwd）。
    session.workspace_id = workspace_id;
    session.apply_session_response(&response);
    restore_session_state(&session, &mut response);
    let replaced = replace_session_slot(
        runtime,
        source,
        session,
        false,
        crate::agent_runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    let attached = crate::session_store::mark_attached_if_current(
        runtime, source, &peri_id, generation, generation,
    )
    .map_err(|error| PylonError::Protocol(error.to_string()))?;
    if !attached {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    if close_replaced {
        if let Some(old) = replaced {
            // 方案 6：统一 close RPC 入口（LocalFirstBestEffort，吞错误）。
            let _ = close_session_rpc(state, runtime, &old.peri_id, generation, false).await;
        }
    }
    Ok(SessionMapping {
        peri_id,
        is_first: true,
        new_response: Some(response),
    })
}

/// G2-04：会话建立/复用——已有映射则复用（返回 is_first = !has_first_prompt），
/// 否则走 create_session_slot（E7 拍板：自动建会话覆盖旧映射时 close 旧 peri，
/// close_replaced 传 true——覆盖场景仅并发 replace 返回 Some 的幽灵映射）。
/// 调用方须已持有该 source 的 prompt 锁（send_prompt_core 路径）。
pub(crate) async fn ensure_session_mapping(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    profile_id: Option<&str>,
    persona: &str,
    session_cwd: &str,
    wire_mcp_servers: &[serde_json::Value],
) -> Result<SessionMapping, PylonError> {
    let _creation_guard = runtime.session_creation.lock().await;
    if let Some(health) = runtime
        .binding_health
        .lock()
        .map_err(|error| error.to_string())?
        .get(source)
        .cloned()
    {
        let unavailable = match health {
            crate::agent_runtime::SessionBindingHealth::Attached { .. } => None,
            crate::agent_runtime::SessionBindingHealth::Probing { .. } => Some("probing"),
            crate::agent_runtime::SessionBindingHealth::Detached { .. } => Some("detached"),
        };
        if let Some(health) = unavailable {
            return Err(PylonError::SessionBindingUnavailable {
                session_source: source.to_string(),
                health: health.to_string(),
            });
        }
    }
    // G2-08 锁合并：消息到达即活动（B10.3b 会话超时判定）——updated_at 刷新与
    // 存在性读取合并为 guard 内一次 sessions.lock()（每消息 7 处 sessions 锁降为
    // 6 处）。行为差异（E10 已拍板）：crashed 早退路径不再刷新 updated_at。
    let existing = {
        let mut sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get_mut(source) {
            session.attach_profile_id(profile_id, source)?;
            session.updated_at = Some(Timestamp::now());
            Some((session.peri_id.clone(), !session.has_first_prompt))
        } else {
            None
        }
    };
    if let Some((peri_id, is_first)) = existing {
        return Ok(SessionMapping {
            peri_id,
            is_first,
            new_response: None,
        });
    }
    create_session_slot(
        state,
        runtime,
        source,
        profile_id,
        persona,
        session_cwd,
        None,
        wire_mcp_servers,
        true,
    )
    .await
}

/// G2-02：load_persisted_session 失败恢复去重——锁 sessions → 复核映射
/// （(peri_id, generation) 匹配）→ 有 previous 则 insert 否则 remove。
/// 调用方不得持有 sessions 锁（E5 锁序纪律：sessions → prompt_locks 单向）。
/// 错误传播：锁错误经 String → PylonError::Protocol（与调用方原样语义一致）。
pub(crate) fn restore_previous_slot(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
    previous: Option<SessionInfo>,
) -> Result<(), PylonError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|lock_error| lock_error.to_string())?;
    if sessions.get(source).map(|session| {
        session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
    }) == Some(true)
    {
        if let Some(previous) = previous {
            sessions.insert(source.to_string(), previous);
        } else {
            sessions.remove(source);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn new_session(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    source: String,
    profile_id: String,
    persona: String,
    cwd: Option<String>,
    workspace_id: Option<String>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, PylonError> {
    DurableSessionOwner::new(&profile_id, &agent_id, &source).validate()?;
    // OWNER-02（§5.8）：显式 agentId 路由到 owner runtime——建会话前本地映射必不存在，
    // 故只要求 agent runtime 存在（不要求会话已存在）；不存在 owner runtime →
    // agent_runtime_unavailable，绝不 fallback active runtime。
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    // B1：GUI 不得冒名平台源——is_platform_source（注册适配器 OR 绑定命中）且
    // 无 binding → 拒绝（防会话建立后出站投递到 QQ）。G4 §3-9（C3）：E14 语义——
    // QQ 适配器未注册时 qq:* 未绑定源放行（无注册 = 无投递路径，安全等价，见
    // gateway/mod.rs is_platform_source doc）。
    if state.gateway.is_platform_source(&source) && state.gateway.binding(&source).is_none() {
        return Err(PylonError::Protocol(format!(
            "invalid GUI source: {source}"
        )));
    }
    state.inner().log_runtime_summary(
        "info",
        "session",
        Some(source.clone()),
        "Session creation started",
        serde_json::Map::new(),
    );
    let _creation_guard = runtime.session_creation.lock().await;
    // CWD-03：Workspace 绑定优先（root_path 单一来源）；未绑定走 cwd 缺省链。
    let (session_cwd, workspace_id) =
        crate::workspaces::resolve_session_cwd(state.inner(), cwd, workspace_id)?;
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    // G2-04：会话建立收敛——守卫/上限/RPC/构造/插入（notify 唯一出口）/
    // close 旧会话全部收敛进 create_session_slot（close_replaced=true，new_session 语义）。
    let mapping = create_session_slot(
        state.inner(),
        &runtime,
        &source,
        Some(&profile_id),
        &persona,
        &session_cwd,
        workspace_id,
        &mcp_servers,
        true,
    )
    .await?;
    state.inner().log_runtime_summary(
        "info",
        "session",
        Some(source.clone()),
        "Session creation succeeded",
        serde_json::Map::new(),
    );
    // Return full response so frontend gets modes + configOptions + sessionId
    Ok(mapping
        .new_response
        .expect("create_session_slot 必返回 session/new 原始响应"))
}
