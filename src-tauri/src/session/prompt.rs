//! Prompt 域：消息发送 / PromptFlow / prompt 编排。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use super::*;
use crate::acp::AcpError;

/// A2/A3：向 source 已注册的流式通道发送终帧（done/error 信封）并注销注册。
/// B1 扩展：user echo 也经此单轨化。未注册 → 返回 false（调用方走广播兜底）。
/// 发送失败仅告警，返回 true（注册已 take，广播会双投递——失败视为连接已断）。
/// payload 为完整终态载荷（含 canonicalEvent），前端按既有 done/error 分支处理。
/// 幂等：take 注销先行，重复调用安全（第二次返回 false）。
fn send_channel_terminal(
    _state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    event: &str,
    mut payload: serde_json::Value,
) -> bool {
    if let Some(channel) = runtime.take_update_channel(source) {
        if let serde_json::Value::Object(ref mut map) = payload {
            map.entry("source".to_string())
                .or_insert_with(|| serde_json::Value::String(source.to_string()));
        }
        let frame = serde_json::json!({ "event": event, "payload": payload });
        if let Err(error) = channel.send(frame) {
            tracing::warn!("channel 终帧发送失败 event={event} source={source}: {error}");
        }
        true
    } else {
        false
    }
}

/// Prompt-generated event 与 dispatcher ACP update 共用 EventService ingest；不持有
/// 独立 sequence/normalizer。平台会话无 GUI Profile，明确跳过本地 journal。
async fn ingest_prompt_event(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    remote_session_id: Option<String>,
    generation: u64,
    raw_payload: serde_json::Value,
) -> Result<Option<CanonicalEventRow>, PylonError> {
    let owner = {
        let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
        let session = sessions
            .get(source)
            .ok_or_else(|| PylonError::SessionNotFound(source.to_string()))?;
        let Some(agent_id) = state.agent_id_for_runtime(runtime) else {
            if session.profile_id.is_some() {
                return Err(PylonError::AgentRuntimeUnavailable {
                    agent_id: "unknown".to_string(),
                });
            }
            return Ok(None);
        };
        session.durable_owner(&agent_id, source)?
    };
    let Some(owner) = owner else {
        return Ok(None);
    };
    let result = event_service_of(state)?
        .ingest_event(owner, remote_session_id, generation, raw_payload)
        .await?;
    Ok(result.events.into_iter().next())
}

async fn publish_prompt_failure<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    window: Option<&tauri::Window<R>>,
    gateway: &GatewayCore,
    ctx: &PromptContext,
    error: &PylonError,
) -> Result<(), PylonError> {
    let mut error_payload = serde_json::json!({
        "source": ctx.source,
        "code": error.code(),
        "error": error.to_string(),
    });
    if let Some(profile_id) = ctx.profile_id.as_deref() {
        let agent_id = state.agent_id_for_runtime(runtime).ok_or_else(|| {
            PylonError::AgentRuntimeUnavailable {
                agent_id: "unregistered-runtime".to_string(),
            }
        })?;
        let (owner, remote_session_id) = {
            let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
            if let Some(session) = sessions.get(&ctx.source) {
                (
                    session
                        .durable_owner(&agent_id, &ctx.source)?
                        .expect("profile-backed prompt must have durable owner"),
                    Some(session.peri_id.clone()),
                )
            } else {
                let owner = DurableSessionOwner::new(profile_id, &agent_id, &ctx.source);
                owner.validate()?;
                (owner, None)
            }
        };
        let result = event_service_of(state)?
            .ingest_event(
                owner,
                remote_session_id,
                state.current_generation(runtime),
                serde_json::json!({
                    "source": ctx.source,
                    "update": {
                        "sessionUpdate": "error",
                        "errorCode": error.code(),
                        "error": error.to_string(),
                    }
                }),
            )
            .await?;
        if let Some(committed_event) = result.events.into_iter().next() {
            error_payload["canonicalEvent"] = serde_json::to_value(committed_event)?;
        }
    }
    if let Some(window) = window {
        emit_event_all(
            window,
            gateway,
            &ctx.source,
            crate::event_names::SESSION_ERROR,
            error_payload.clone(),
        );
    }
    send_channel_terminal(state, runtime, &ctx.source, crate::event_names::SESSION_ERROR, error_payload);
    Ok(())
}
#[tauri::command(rename_all = "camelCase")]
// clippy 2026-08-02：8 参含 2 个 Tauri 注入（state/window）+ 6 个业务参数（source/content/
// persona/session_prompt/attachments/mcp_servers），send_message 为 IPC 契约签名不可折叠。
// OWNER-02（§5.8）：新增 agent_id 显式路由（9 参，含 3 个 Tauri 注入 + 6 业务参数）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_message<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::Window<R>,
    agent_id: String,
    source: String,
    profile_id: Option<String>,
    content: String,
    persona: String,
    session_prompt: Option<String>,
    attachments: Option<Vec<String>>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<String, PylonError> {
    // OWNER-02（§5.8）：显式 agentId 路由到 owner runtime——只要求 agent runtime 存在，
    // 不要求会话已存在（send_message 允许自动创建会话）；不存在 owner runtime →
    // agent_runtime_unavailable，绝不 fallback active runtime。
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    // G2-05：PromptContext 内联构造（IPC 签名锁定；字段全部 move，零 clone）。
    let ctx = PromptContext {
        source,
        profile_id,
        content,
        persona,
        session_prompt,
        attachments,
        mcp_servers,
        cwd: None,
    };
    send_prompt_core(state.inner(), &runtime, Some(&window), &state.gateway, &ctx).await
}

/// A2：流式版本 send_message——前端必携 Channel（on_update），注册后走 Channel
/// 推送（A3 跳过广播）。其余语义与 send_message 完全一致；旧命令 send_message
/// 保留为非流式兼容路径（无 Channel 参数）。
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn send_message_streaming<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::Window<R>,
    agent_id: String,
    source: String,
    profile_id: Option<String>,
    content: String,
    persona: String,
    session_prompt: Option<String>,
    attachments: Option<Vec<String>>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
    on_update: tauri::ipc::Channel<serde_json::Value>,
) -> Result<String, PylonError> {
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    runtime.register_update_channel(&source, on_update);
    let ctx = PromptContext {
        source,
        profile_id,
        content,
        persona,
        session_prompt,
        attachments,
        mcp_servers,
        cwd: None,
    };
    // 终帧/注销由收尾两路（finalize_response → DONE 帧 / publish_prompt_failure →
    // ERROR 帧）经 send_channel_terminal 完成，不绑本函数生命周期。
    send_prompt_core(state.inner(), &runtime, Some(&window), &state.gateway, &ctx).await
}

/// G2-06：管线运行期载体——阶段函数（ensure_session/prepare/send/finalize）不再
/// 逐参重传。输入借用（state/runtime/window/gateway/ctx），派生产物（peri_id/
/// generation/is_first/message_round/inject_activated/prompt_blocks/request_id）
/// 在管线内逐步填充。
pub(crate) struct PromptFlow<'a, R: tauri::Runtime> {
    pub(crate) state: &'a AppState,
    pub(crate) runtime: &'a Arc<AgentRuntime>,
    pub(crate) window: Option<&'a tauri::Window<R>>,
    pub(crate) gateway: &'a GatewayCore,
    pub(crate) ctx: &'a PromptContext,
    /// ensure_session 后确定。
    pub(crate) peri_id: String,
    /// prompt_generation（ensure 后快照）。
    pub(crate) generation: u64,
    /// ensure 后确定。
    pub(crate) is_first: bool,
    /// prepare 后确定（inject 回合）。
    pub(crate) message_round: u64,
    /// prepare 后确定（注入命中的来源列表）。
    pub(crate) inject_activated: Vec<String>,
    /// prepare 后确定（prompt blocks，prepare_prompt 消费）。
    pub(crate) prompt_blocks: Vec<serde_json::Value>,
    /// prepare_prompt 后捕获（取消/清理用）。
    pub(crate) request_id: u64,
}

/// R33a：prompt 阶段纯函数——content 构造 + persona 拼接 + B11.1 注入调用 +
/// attachments 块构建。G2-06：9 参收敛为 (&mut PromptFlow) 单参；prompt_blocks/
/// inject_activated/message_round 写入 flow。注入日志（activated/empty/failed）在
/// 本函数内按原顺序发出；pet/用户事件由调用方在返回后触发——wire/事件顺序不变。
async fn prepare_prompt_blocks<R: tauri::Runtime>(
    flow: &mut PromptFlow<'_, R>,
) -> Result<(), PylonError> {
    let state = flow.state;
    let runtime = flow.runtime;
    let gateway = flow.gateway;
    let source = &flow.ctx.source;
    let content = &flow.ctx.content;
    let is_first = flow.is_first;
    let attachment_paths = flow.ctx.attachments.as_deref().unwrap_or_default();
    let effective_persona = flow
        .ctx
        .session_prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&flow.ctx.persona);

    let prompt_content =
        if is_first && !effective_persona.is_empty() && !content.trim_start().starts_with('/') {
            format!("{}\n\n---\n\n{}", effective_persona, content)
        } else {
            content.to_string()
        };

    // B11.1：发送前置注入钩子（GUI 与平台 ingest 统一入口）——Prism 可用 +
    // gateway 配置开启 + 非命令消息 → POST /inject 拿 context 前置拼进 prompt。
    // Prism 不可用/请求失败 → 降级为不注入（消息照发，fail-open）。
    let mut inject_activated: Vec<String> = Vec::new();
    let message_round = {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(source).map(|s| s.inject_round).unwrap_or(0)
    };
    let prompt_text = if gateway.inject_enabled() && inject_applies_to(content) {
        match state
            .prism
            .inject(
                &gateway.inject_scenario().unwrap_or_default(),
                &gateway.inject_sources(),
                content,
                message_round,
            )
            .await
        {
            Ok(result) => {
                if result.activated.is_empty() {
                    state.log_runtime_summary(
                        "info",
                        "inject",
                        Some(source.to_string()),
                        "Prism inject returned empty context",
                        serde_json::Map::from_iter([(
                            "contextLength".to_string(),
                            serde_json::Value::from(result.context.len()),
                        )]),
                    );
                } else {
                    state.log_runtime_summary(
                        "info",
                        "inject",
                        Some(source.to_string()),
                        "Prism inject activated",
                        serde_json::Map::from_iter([
                            (
                                "activatedCount".to_string(),
                                serde_json::Value::from(result.activated.len()),
                            ),
                            (
                                "contextLength".to_string(),
                                serde_json::Value::from(result.context.len()),
                            ),
                        ]),
                    );
                }
                inject_activated = result.activated;
                compose_inject_prompt(&result.context, &prompt_content)
            }
            Err(error) => {
                tracing::warn!("Prism inject failed: {error}");
                state.log_runtime_summary(
                    "warn",
                    "inject",
                    Some(source.to_string()),
                    "Prism inject failed; sent without injection",
                    serde_json::Map::new(),
                );
                prompt_content
            }
        }
    } else {
        prompt_content
    };
    // clippy needless_borrow 误报（2026-08-02）：建议去掉 & 直接传 attachment_paths，
    // 但 prompt_blocks 参数是 &[String]，Vec 不会自动借用（编译失败）；&Vec → &[T]
    // 是 deref coercion 的惯用写法，allow 保留。
    // G1-04 + E-11：附件限制按 runtime 归属 agent 协议配置解析（平台 ingest 绑定
    // agent ≠ GUI active agent 时精确归属，缺省 = 现状 8/10MB，wire 不变）；
    // 未注册 runtime（测试直构形态）回退 active agent（原 G1-04 行为）。
    let limits = match state.agent_for_runtime(runtime) {
        Some(agent) => crate::agent_config::AttachmentLimits::from_agent(&agent),
        None => crate::agent_config::AttachmentLimits::from_agent(&state.get_active_agent()?),
    };
    #[allow(clippy::needless_borrow)]
    let prompt_blocks = crate::acp::prompt_blocks(prompt_text, &attachment_paths, limits)?;
    flow.message_round = message_round;
    flow.inject_activated = inject_activated;
    flow.prompt_blocks = prompt_blocks;
    Ok(())
}

/// R33b：回合推进纯函数——该 session 用户回合 +1、标记收集回合（dispatcher
/// 据此绑定流式收集）、清空上一回合回复文本（本轮回复由 dispatcher 重新收集）。
/// 必须在发送（send_keep_rx）之前完成（P2-8：发送成功后清空会与 dispatcher
/// 的并行追加竞态：agent 极快响应时本轮回复文本会被清掉）。
fn advance_round<R: tauri::Runtime>(flow: &mut PromptFlow<'_, R>) {
    if let Ok(mut sessions) = flow.runtime.sessions.lock() {
        if let Some(session) = sessions.get_mut(&flow.ctx.source) {
            session.inject_round = session.inject_round.saturating_add(1);
            // B11.2：先标记收集回合（dispatcher 据此绑定流式收集），再清空文本。
            session.last_response_round = session.inject_round;
            session.last_response_text.clear();
        }
    }
}

/// R33c：Response 成功路径收尾——stop reason 校验（M5 感知）、generation 复核、
/// 首轮标记、pylon:done 广播、B11.2 完成持久化、完成日志。wire/事件顺序与
/// 拆分前内联路径完全一致（pylon:error 先于 pet 感知、done 先于 persist）。
/// G2-06：11 参收敛为 (flow, data) 两参；函数体经局部别名访问 flow 派生字段。
async fn finalize_response<R: tauri::Runtime>(
    flow: &mut PromptFlow<'_, R>,
    data: serde_json::Value,
) -> Result<String, PylonError> {
    let state = flow.state;
    let runtime = flow.runtime;
    let window = flow.window;
    let gateway = flow.gateway;
    let source = &flow.ctx.source;
    let content = &flow.ctx.content;
    let peri_id = &flow.peri_id;
    let prompt_generation = flow.generation;
    let is_first = flow.is_first;
    let message_round = flow.message_round;
    crate::acp::prompt_stop_reason(&data).map_err(|error| {
        let error = error.to_string();
        // M5 感知：refusal / max_turn 区分于普通失败
        if error.contains("refused") {
            let _ = state
                .pet
                .lock()
                .map(|mut pet| crate::pet::on_refused(&mut pet));
        } else if error.contains("max_turn") {
            let _ = state
                .pet
                .lock()
                .map(|mut pet| crate::pet::on_maxed(&mut pet));
        } else {
            let _ = state
                .pet
                .lock()
                .map(|mut pet| crate::pet::on_error(&mut pet));
        }
        error
    })?;
    if let Err(error) = state.ensure_generation(runtime, prompt_generation) {
        let _ = state.remove_session_if_matches(runtime, source, peri_id, prompt_generation);
        return Err(error.into());
    }
    if is_first {
        state.mark_first_prompt_if_matches(runtime, source, peri_id, prompt_generation)?;
    }
    let mut done_payload = serde_json::json!({"source": source, "data": data});
    if let Some(committed_event) = ingest_prompt_event(
        state,
        runtime,
        source,
        Some(peri_id.clone()),
        prompt_generation,
        serde_json::json!({
            "source": source,
            "update": { "sessionUpdate": "done" },
        }),
    )
    .await?
    {
        done_payload["canonicalEvent"] = serde_json::to_value(committed_event)?;
    }
    if let Some(window) = window {
        emit_event_all(
            window,
            gateway,
            source,
            crate::event_names::SESSION_DONE,
            done_payload.clone(),
        );
    }
    send_channel_terminal(state, runtime, source, crate::event_names::SESSION_DONE, done_payload);
    let _ = state.pet.lock().map(|mut p| crate::pet::on_done(&mut p));
    // B11.2：完成持久化（gateway.inject.persist = "prism"）——把本回合
    // （用户消息 + 流式收集的回复文本）交 Prism /persist（LLM 摘要 +
    // recent.json + active.round 推进）。失败只告警，不阻断。
    if gateway.inject_persist() == "prism" {
        let response_text = {
            let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
            sessions
                .get(source)
                .map(|s| s.last_response_text.clone())
                .unwrap_or_default()
        };
        if !response_text.trim().is_empty() {
            match state
                .prism
                .persist_round(
                    &gateway.inject_scenario().unwrap_or_default(),
                    &gateway.inject_sources(),
                    content,
                    &response_text,
                    message_round,
                )
                .await
            {
                Ok(value) => {
                    let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                    if !ok {
                        tracing::warn!("Prism persist 返回失败: {value}");
                    }
                    state.log_runtime_summary(
                        "info",
                        "persist",
                        Some(source.to_string()),
                        if ok {
                            "Prism round persisted"
                        } else {
                            "Prism persist returned failure"
                        },
                        serde_json::Map::new(),
                    );
                }
                Err(error) => {
                    tracing::warn!("Prism persist failed: {error}");
                    state.log_runtime_summary(
                        "warn",
                        "persist",
                        Some(source.to_string()),
                        "Prism persist failed",
                        serde_json::Map::new(),
                    );
                }
            }
        }
    }
    state.log_runtime_summary(
        "info",
        "prompt",
        Some(source.to_string()),
        "Prompt completed",
        serde_json::Map::from_iter([(
            "result".to_string(),
            serde_json::Value::String("success".to_string()),
        )]),
    );
    Ok(flow.peri_id.clone())
}

/// S3：prompt Response 错误是否携带"会话不存在"语义（幽灵映射自动重建判定）。
/// agent 重启/会话回收后，本地映射的 peri_id 指向已死会话，prompt 会返回
/// "session not found" 类 RPC 错误。分类只读取 [`AcpError::Rpc`] 的结构化
/// code/data/message；method-not-found 与传输/超时错误不命中。
pub(crate) fn prompt_error_indicates_missing_session(error: &AcpError) -> bool {
    error.rpc_failure_kind() == Some(crate::acp::RpcFailureKind::SessionMissing)
}

/// S3：Response 错误分支的幽灵映射清理——错误含"会话不存在"语义时，按
/// (peri_id, generation) 复核删除本地映射（O1：锁表同步收敛），并保留 Detached
/// 健康快照，要求用户显式 load/retry/fork。返回是否删除了映射。事件与 pet 感知
/// 由调用方保持原顺序，本函数只负责映射收敛与日志。
pub(crate) fn cleanup_ghost_session_mapping(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    peri_id: &str,
    prompt_generation: u64,
    error: &AcpError,
) -> bool {
    if !prompt_error_indicates_missing_session(error) {
        return false;
    }
    match crate::session_store::mark_detached_if_current(
        runtime,
        source,
        peri_id,
        prompt_generation,
        prompt_generation,
        "remote-session-missing".into(),
        false,
        true,
    ) {
        Ok(true) => {
            state.log_runtime_summary(
                "warn",
                "session",
                Some(source.to_string()),
                &format!("Agent session {peri_id} missing; removed stale mapping — explicit reload is required"),
                serde_json::Map::new(),
            );
            true
        }
        Ok(false) => false,
        Err(remove_error) => {
            tracing::warn!("remove stale session mapping failed: {remove_error}");
            false
        }
    }
}

/// G2-05：一次 prompt 发送的不可变输入（来源无关：GUI send_message / 平台 ingest 共用）。
/// 字段 = 原 send_prompt_core 8 个业务参数一对一搬运，零语义变化。
/// E8 封闭：纯 owned 字段（不持 &AppState 引用）——derive Clone/Default 无冲突；
/// 构造点 send_message 全部 move 无 clone，ingest 调用点 source 需 clone（回滚仍用）。
#[derive(Clone, Default)]
pub(crate) struct PromptContext {
    pub(crate) source: String,
    /// GUI owner profile；平台 ingest 没有 UI Profile，保持 None，不做默认猜测。
    pub(crate) profile_id: Option<String>,
    pub(crate) content: String,
    pub(crate) persona: String,
    pub(crate) session_prompt: Option<String>,
    pub(crate) attachments: Option<Vec<String>>,
    pub(crate) mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
    pub(crate) cwd: Option<String>,
}

/// 公共发送管线（GUI `send_message` 与 gateway 平台 ingest 共用，B10.3）：
/// per-runtime 会话创建/映射/prompt 锁/等待/cancel/事件广播。
/// 平台 ingest 经 handler 路由到绑定 agent 的 runtime 后调用本函数。
/// `ctx.cwd`：自动建会话时的工作目录——平台路由必须传绑定 agent 的 cwd
/// （绑定 agent ≠ GUI active agent 时 agent_cwd() 会读错）；None 回退 active agent。
/// G2-05：11 参 → 5 参（state/runtime/window/gateway + ctx 上下文对象，E8 封闭）。
pub(crate) async fn send_prompt_core<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    window: Option<&tauri::Window<R>>,
    gateway: &GatewayCore,
    ctx: &PromptContext,
) -> Result<String, PylonError> {
    let result = send_prompt_core_impl(state, runtime, window, gateway, ctx).await;
    if let Err(error) = &result {
        if let Err(persistence_error) =
            publish_prompt_failure(state, runtime, window, gateway, ctx, error).await
        {
            tracing::error!(
                code = persistence_error.code(),
                source = ctx.source,
                original_error = %error,
                persistence_error = %persistence_error,
                "prompt failure could not be committed; failure event was not published"
            );
            return Err(persistence_error);
        }
    }
    result
}

async fn send_prompt_core_impl<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    window: Option<&tauri::Window<R>>,
    gateway: &GatewayCore,
    ctx: &PromptContext,
) -> Result<String, PylonError> {
    // 解构 ctx 业务参数（引用形态，管线内只读；session_prompt 由 prepare_prompt_blocks
    // 经 flow.ctx 直接读取，不在本函数体内消费）。
    let PromptContext {
        source,
        profile_id,
        content,
        persona,
        attachments,
        mcp_servers,
        cwd,
        ..
    } = ctx;
    // B1：GUI source 不得冒名平台源——is_platform_source（注册适配器 OR 绑定命中）
    // 且无 binding → 拒绝（防冒名出站投递到 QQ）。平台 ingest 的 qq:* 必带 binding
    // （绑定命中），不受影响。G4 §3-9（C4）：E14 语义——QQ 适配器未注册时 qq:*
    // 未绑定源放行（无注册 = 无投递路径，安全等价）。
    if gateway.is_platform_source(source) && gateway.binding(source).is_none() {
        return Err(PylonError::Protocol(format!(
            "invalid GUI source: {source}"
        )));
    }
    state.log_runtime_summary(
        "info",
        "prompt",
        Some(source.to_string()),
        "Prompt started",
        serde_json::Map::from_iter([
            (
                "contentLength".to_string(),
                serde_json::Value::from(content.len()),
            ),
            (
                "attachmentCount".to_string(),
                serde_json::Value::from(attachments.as_deref().map_or(0, <[String]>::len)),
            ),
        ]),
    );
    // P1（E10）：GUI 显式 mcp_servers（前端每消息下发）直校验；None（平台 ingest
    // 路径）走 mcp_wire 缓存——命中零重算，miss 回退全量重算并回填（E3 自愈）。
    let requested_mcp_servers = match mcp_servers {
        Some(servers) => mcp::validate_and_serialize(Some(servers.clone()))?,
        None => state.wire_mcp_servers()?,
    };
    let prompt_lock = prompt_lock_for(&runtime.prompt_locks, source);
    let _prompt_guard = prompt_lock.lock().await;

    // G2-08 锁合并：updated_at 刷新移入 ensure_session_mapping 的存在性读取
    // （guard 内一次 sessions.lock() 完成"刷新 + 存在性读取 + is_first"）——
    // E10 拍板接受的行为差异：crashed 早退路径不再刷新 updated_at（发送失败的
    // 消息不再计为活动，仅崩溃路径可见，语义更正确）。

    if runtime.acp.lock().await.is_crashed() {
        return Err(PylonError::AgentCrashed);
    }

    // G2-04：会话建立/复用收敛——ensure_session_mapping（复用优先）→
    // create_session_slot（自动建会话，E7 拍板 close_replaced=true）。
    // P1-1：会话 cwd 优先取调用方显式绑定（平台路由 = 绑定 agent 的 cwd，
    // 可能 ≠ GUI active agent）；无则回退 active agent cwd。
    let session_cwd = cwd
        .as_deref()
        .map(str::to_string)
        .unwrap_or_else(|| state.agent_cwd());
    let (peri_id, is_first) = {
        // 方案 I：session/new（建会话/复用）失败必须立即向前端广播 pylon:error，
        // 不能静默传播 Err——否则用户看到的是"消息滞留 + 生成指示器空转"而非明确错误
        // （Hermes 无 provider/401 等均在此时失败）。错误同时进 runtime 日志带上下文。
        let mapping = match ensure_session_mapping(
            state,
            runtime,
            source,
            profile_id.as_deref(),
            persona,
            &session_cwd,
            &requested_mcp_servers,
        )
        .await
        {
            Ok(mapping) => mapping,
            Err(error) => {
                let message = error.to_string();
                let _ = state.pet.lock().map(|mut p| crate::pet::on_error(&mut p));
                state.log_runtime_summary(
                    "error",
                    "prompt",
                    Some(source.to_string()),
                    "Prompt session ensure failed",
                    serde_json::Map::from_iter([(
                        "error".to_string(),
                        serde_json::Value::String(message.clone()),
                    )]),
                );
                return Err(PylonError::Protocol(message));
            }
        };
        (mapping.peri_id, mapping.is_first)
    };

    // G2-06：管线阶段载体（PromptFlow）——派生字段由阶段函数逐步填充。
    let mut flow = PromptFlow {
        state,
        runtime,
        window,
        gateway,
        ctx,
        peri_id,
        generation: state.current_generation(runtime),
        is_first,
        message_round: 0,
        inject_activated: Vec::new(),
        prompt_blocks: Vec::new(),
        request_id: 0,
    };

    let committed_user_event = ingest_prompt_event(
        state,
        runtime,
        source,
        Some(flow.peri_id.clone()),
        flow.generation,
        serde_json::json!({
            "source": source,
            "update": {
                "sessionUpdate": "user_message_chunk",
                "content": { "text": content },
            }
        }),
    )
    .await?;

    // R33a：content 构造 + persona 拼接 + B11.1 注入 + attachments 块构建。
    prepare_prompt_blocks(&mut flow).await?;

    state
        .pet
        .lock()
        .map(|mut p| crate::pet::on_user_sent(&mut p))
        .ok();
    {
        let mut user_payload = serde_json::json!({ "source": source, "content": content });
        if !flow.inject_activated.is_empty() {
            user_payload["injectActivated"] = serde_json::Value::Array(
                flow.inject_activated
                    .iter()
                    .map(|item| serde_json::Value::String(item.clone()))
                    .collect(),
            );
        }
        if let Some(committed_event) = committed_user_event {
            user_payload["canonicalEvent"] = serde_json::to_value(committed_event)?;
        }
        // B1（传输收敛）：已注册 Channel 的 GUI 会话走信封帧单轨；未注册
        // （平台 ingest / 未升级前端）保留广播。user echo 与 update 同构。
        // 注意：必须用非破坏性 send_update_frame——此处会话尚未结束，take 注销
        // 会让后续 update/done 流失去通道（前端 C2 已拆广播 listen → 断流）。
        let frame = serde_json::json!({
            "event": crate::event_names::USER_ECHO,
            "payload": user_payload,
        });
        if !runtime.send_update_frame(source, frame) {
            if let Some(window) = window {
                emit_event(window, crate::event_names::USER_ECHO, user_payload);
            }
        }
    }
    let rpc = {
        let acp = runtime.acp.lock().await;
        acp.prepare_prompt(&flow.peri_id, std::mem::take(&mut flow.prompt_blocks))?
    };
    // 取消/连接关闭分支清理 pending 仍需 request_id（send_keep_rx 会消费 rpc）。
    flow.request_id = rpc.id;
    // R33b：回合推进（该 session 用户回合 +1、标记收集回合、清空回复文本）。
    // P2-8：必须在发送（send_keep_rx）之前完成，见 advance_round 说明。
    advance_round(&mut flow);
    // R3：send_keep_rx 统一 10s 写超时（对齐 complete 路径；原裸 write_tx.send 在
    // writer 阻塞 + 队列满时会无限挂起），失败已清理 pending，只收敛会话映射。
    let mut rx = match rpc.send_keep_rx().await {
        Ok(rx) => rx,
        Err(error) => {
            let _ =
                state.remove_session_if_matches(runtime, source, &flow.peri_id, flow.generation);
            return Err(PylonError::from(error));
        }
    };
    let acp_for_cancel = runtime.acp.clone();
    let peri_id_for_cancel = flow.peri_id.clone();
    // G2-06：超时参数化（per-agent 协议配置，缺省 300/30 = 现状常量值）。
    let protocol = state.protocol_for_runtime(runtime);
    let prompt_timeout_secs = protocol.prompt_timeout();
    let cancel_settle_timeout_secs = protocol.cancel_settle_timeout();
    let idle_timeout_secs = protocol.idle_timeout();
    let first_token_timeout_secs = protocol.first_token_timeout();
    // Only the Hermes/Windows runtime owns the force-recovery path.  The
    // generic ACP transport keeps its historical cancel-only behavior for
    // Peri and custom agents.
    let hermes_force_recovery = state
        .agent_for_runtime(runtime)
        .is_some_and(|agent| crate::hermes_runtime::should_apply(&agent));
    let runtime_for_recovery = runtime.clone();
    let expected_generation = flow.generation;
    // R-t5：liveness 探针——读本会话最近一次 ACP 活动时刻（dispatcher 刷新）。
    // 用作"闲置超时"判据：活动即续命，只有持续无输出才截。
    let source_for_liveness = source.to_string();
    let liveness_activity = move || {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string()).ok()?;
        sessions
            .get(&source_for_liveness)
            .and_then(|s| s.last_activity)
    };
    let result = acp::wait_prompt_with_recovery(
        &mut rx,
        Duration::from_secs(cancel_settle_timeout_secs),
        Duration::from_secs(idle_timeout_secs),
        Duration::from_secs(first_token_timeout_secs),
        liveness_activity,
        move || async move {
            // R6e：cancel 闭包契约是 Result<(), String>（wait_prompt_with_cancel 泛型边界）
            acp_for_cancel
                .lock()
                .await
                .cancel_session(&peri_id_for_cancel)
                .await
                .map_err(|e| e.to_string())
        },
        move || async move {
            if !hermes_force_recovery {
                return;
            }
            // Take the same ACP lock used by client replacement before checking
            // generation. Replacement updates the generation while holding this
            // lock, so checking only before locking would leave a race in which
            // a reconnect wins between the read and the kill.
            let mut acp = runtime_for_recovery.acp.lock().await;
            let current_generation = runtime_for_recovery
                .client_generation
                .load(Ordering::Acquire);
            if current_generation != expected_generation {
                tracing::debug!(
                    expected_generation,
                    current_generation,
                    "skip Hermes force recovery for stale prompt generation"
                );
                return;
            }
            if acp.is_crashed() {
                return;
            }
            if let Err(error) = acp.kill() {
                tracing::warn!("Hermes force recovery could not kill ACP child: {error}");
            } else {
                tracing::warn!(
                    expected_generation,
                    "Hermes ACP child force-killed after cancel did not settle"
                );
            }
        },
    )
    .await;

    match result {
        PromptWaitOutcome::Response(raw) => {
            state.ensure_generation(runtime, flow.generation)?;
            if !state.session_matches(runtime, source, &flow.peri_id, flow.generation)? {
                return Err(PylonError::Protocol(format!(
                    "stale session mapping for source: {source}"
                )));
            }
            if let Some(error) = raw.error {
                let error = error.to_string();
                let typed_error = AcpError::Rpc(error.clone());
                let _ = state.pet.lock().map(|mut p| crate::pet::on_error(&mut p));
                // S3：幽灵映射自动重建——agent 侧会话已不存在（重启/回收后映射滞留）
                // 时清理本地映射，下一条消息自动走会话重建路径；网络/临时错误不清理。
                cleanup_ghost_session_mapping(
                    state,
                    runtime,
                    source,
                    &flow.peri_id,
                    flow.generation,
                    &typed_error,
                );
                Err(PylonError::Protocol(error))
            } else {
                // R33c：成功路径收尾（stop reason 校验 / generation 复核 / 首轮标记 /
                // pylon:done 广播 / B11.2 完成持久化）委托阶段函数，顺序不变。
                let data = raw.result.unwrap_or(serde_json::Value::Null);
                finalize_response(&mut flow, data).await
            }
        }
        PromptWaitOutcome::ConnectionClosed => {
            runtime.acp.lock().await.remove_pending(flow.request_id);
            // 崩溃不在此删除映射：自动重连会先置 Probing，再用无 prompt 的
            // session/load probe 收敛 Attached/Detached；删除会丢失待验证证据。
            // 方案 I：连接关闭日志携带 request/session/agent 上下文，便于
            // 对齐 ACP wire 时间线定位终态缺失点。
            state.log_runtime_summary(
                "error",
                "prompt",
                Some(source.to_string()),
                "Prompt connection closed",
                serde_json::Map::from_iter([
                    (
                        "requestId".to_string(),
                        serde_json::Value::from(flow.request_id),
                    ),
                    (
                        "sessionId".to_string(),
                        serde_json::Value::String(flow.peri_id.clone()),
                    ),
                    (
                        "agentId".to_string(),
                        serde_json::Value::String(
                            state
                                .agent_for_runtime(runtime)
                                .map(|a| a.name)
                                .unwrap_or_default(),
                        ),
                    ),
                ]),
            );
            Err(PylonError::Protocol("ACP connection closed".to_string()))
        }
        PromptWaitOutcome::CancelledAfterTimeout {
            response,
            cancel_error,
        } => {
            runtime.acp.lock().await.remove_pending(flow.request_id);
            if let Some(cancel_error) = cancel_error {
                tracing::warn!("cancel timed-out prompt {}: {}", flow.peri_id, cancel_error);
            }
            // B9：cancel 后应答该 session 挂起的权限请求为 Cancelled
            crate::permission::respond_pending_permissions_cancelled(runtime, &flow.peri_id).await;
            if response.is_none() {
                match state.remove_session_if_matches(
                    runtime,
                    source,
                    &flow.peri_id,
                    flow.generation,
                ) {
                    Ok(true) => {
                        tracing::error!(
                            "cancelled prompt {} did not settle within {}s; removed local session mapping",
                            flow.peri_id,
                            cancel_settle_timeout_secs
                        );
                        // 方案 6：统一 close RPC 入口（LocalFirstBestEffort，吞错误）。
                        let _ = close_session_rpc(
                            state,
                            runtime,
                            &flow.peri_id,
                            flow.generation,
                            false,
                        )
                        .await;
                    }
                    Ok(false) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            // G2-06：超时文案参数化（缺省 300 时与旧文案逐字一致——session.rs:2108
            // 负例表 "timed out after 300s" 依赖此不变量）。
            // 方案 I：区分"流式内容已到、终态缺失"与"完全无输出"——本回合是否收到过
            // assistant 内容（dispatcher 经 collect_response_chunk 写入 last_response_text）。
            let has_streamed_content = {
                let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
                sessions
                    .get(source)
                    .map(|s| !s.last_response_text.trim().is_empty())
                    .unwrap_or(false)
            };
            let error = format!("timed out after {prompt_timeout_secs}s");
            // M5 感知：超时 → 发呆（区别于普通失败）
            let _ = state.pet.lock().map(|mut p| crate::pet::on_timeout(&mut p));
            // 方案 I：超时日志区分内容状态 + 携带 request/session/agent 上下文。
            state.log_runtime_summary(
                "error",
                "prompt",
                Some(source.to_string()),
                if has_streamed_content {
                    "Prompt timed out (streamed content, missing final response)"
                } else {
                    "Prompt timed out (no content streamed)"
                },
                serde_json::Map::from_iter([
                    (
                        "result".to_string(),
                        serde_json::Value::String("timeout".to_string()),
                    ),
                    (
                        "hasStreamedContent".to_string(),
                        serde_json::Value::Bool(has_streamed_content),
                    ),
                    (
                        "requestId".to_string(),
                        serde_json::Value::from(flow.request_id),
                    ),
                    (
                        "sessionId".to_string(),
                        serde_json::Value::String(flow.peri_id.clone()),
                    ),
                    (
                        "agentId".to_string(),
                        serde_json::Value::String(
                            state
                                .agent_for_runtime(runtime)
                                .map(|a| a.name)
                                .unwrap_or_default(),
                        ),
                    ),
                ]),
            );
            Err(PylonError::Protocol(error))
        }
    }
}
