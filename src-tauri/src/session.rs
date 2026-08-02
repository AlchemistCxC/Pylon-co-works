//! 会话域：SessionInfo / AppState helpers / 会话命令 / 过期生命周期。
//! R1 拆分自 lib.rs（行为零变化）。

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::acp::{self, AcpClient, PromptWaitOutcome};
use crate::agent_config::AgentDef;
use crate::agent_runtime::{session_mapping_matches, AgentLifecycleStatus, AgentRuntimeState};
use crate::error::PylonError;
use crate::gateway::GatewayCore;
use crate::mcp;
use crate::runtime::AgentRuntime;
use crate::time::Timestamp;
use crate::workspace;
use crate::{emit_event, emit_event_all, prompt_lock_for, AppState, AppStateHandles};

#[derive(Clone)]
pub(crate) struct SessionInfo {
    pub(crate) peri_id: String,
    pub(crate) persona: String,
    pub(crate) cwd: String,
    pub(crate) has_first_prompt: bool,
    pub(crate) title: String,
    pub(crate) generation: u64,
    pub(crate) mode: Option<String>,
    pub(crate) config_options: Vec<serde_json::Value>,
    pub(crate) model: String,
    pub(crate) tokens_in: u64,
    pub(crate) tokens_out: u64,
    pub(crate) tokens_total: u64,
    pub(crate) context_size: u64,
    /// 最后活动时间（B10.3b 会话超时/重置判定；R4：Timestamp，仅内部使用不落 wire）。
    pub(crate) updated_at: Option<Timestamp>,
    /// B11：回合计数（每次用户消息 +1；注入与完成持久化共用同一 round）。
    pub(crate) inject_round: u64,
    /// B11.2：当前正在收集的回合号——回合推进时标记为最新 inject_round，
    /// dispatcher 据此绑定流式收集（SessionInfo 无 serde derive，不落 wire/落盘）。
    pub(crate) last_response_round: u64,
    /// B11.2：当前回合 agent 回复文本（dispatcher 流式收集，完成持久化用）。
    pub(crate) last_response_text: String,
}

impl SessionInfo {
    pub(crate) fn new(
        peri_id: String,
        persona: String,
        cwd: String,
        has_first_prompt: bool,
        generation: u64,
    ) -> Self {
        Self {
            peri_id,
            persona,
            cwd,
            has_first_prompt,
            title: String::new(),
            generation,
            mode: None,
            config_options: Vec::new(),
            model: String::new(),
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            context_size: 0,
            updated_at: Some(Timestamp::now()),
            inject_round: 0,
            last_response_round: 0,
            last_response_text: String::new(),
        }
    }

    pub(crate) fn apply_session_response(&mut self, response: &serde_json::Value) {
        if let Some(options) = response
            .get("configOptions")
            .and_then(|value| value.as_array())
        {
            self.config_options = options.clone();
            self.apply_config_options(options);
        }
        self.mode = response
            .get("modes")
            .and_then(|modes| {
                modes
                    .get("currentModeId")
                    .or_else(|| modes.get("currentMode"))
                    .or_else(|| modes.get("current"))
            })
            .and_then(value_as_string)
            .or_else(|| {
                find_config_option(&self.config_options, "mode")
                    .and_then(config_option_current_value)
            });
    }

    pub(crate) fn apply_config_options(&mut self, options: &[serde_json::Value]) {
        if let Some(model) =
            find_config_option(options, "model").and_then(config_option_current_value)
        {
            self.model = model;
        }
        if let Some(mode) =
            find_config_option(options, "mode").and_then(config_option_current_value)
        {
            self.mode = Some(mode);
        }
    }

    /// B11.2：流式收集当前回合回复文本（完成持久化 POST /persist 用）。
    /// 回合绑定：仅当 ① 收集标记回合 == 当前回合（标记未过期），且 ② chunk
    /// 的接收回合 == 当前回合（事件接收后回合未推进）才追加——Round N 迟到
    /// chunk 在 Round N+1 推进（clear）之后才被 dispatcher 追加 → 丢弃，防
    /// 跨回合污染 persist 落库。
    /// 上限 64KB 截断防超长回复撑爆内存；截断必须落在字符边界
    /// （String::truncate 在非边界处 panic，会 poison sessions 锁）。
    pub(crate) fn collect_response_chunk(&mut self, text: &str, received_round: u64) {
        if self.last_response_round != self.inject_round {
            return;
        }
        if received_round != self.inject_round {
            return;
        }
        self.last_response_text.push_str(text);
        if self.last_response_text.len() > 64 * 1024 {
            let mut end = 64 * 1024;
            while end > 0 && !self.last_response_text.is_char_boundary(end) {
                end -= 1;
            }
            self.last_response_text.truncate(end);
        }
    }
}

pub(crate) fn value_as_string(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .or_else(|| {
            value
                .get("value")
                .and_then(|nested| nested.as_str())
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            value
                .get("valueId")
                .and_then(|nested| nested.get("value"))
                .and_then(|nested| nested.as_str())
                .map(ToOwned::to_owned)
        })
}

pub(crate) fn find_config_option<'a>(
    options: &'a [serde_json::Value],
    key: &str,
) -> Option<&'a serde_json::Value> {
    options.iter().find(|option| {
        option
            .get("id")
            .or_else(|| option.get("key"))
            .or_else(|| option.get("name"))
            .and_then(|value| value.as_str())
            == Some(key)
    })
}

pub(crate) fn config_option_current_value(option: &serde_json::Value) -> Option<String> {
    option
        .get("currentValue")
        .and_then(value_as_string)
        .or_else(|| option.get("value").and_then(value_as_string))
        .or_else(|| option.get("current").and_then(value_as_string))
        .or_else(|| option.get("selected").and_then(value_as_string))
}

pub(crate) const MAX_SESSIONS: usize = 100;

/// 会话过期判定（B10.3b，参考 Hermes reset policy）：返回过期原因，None = 未过期。
///
/// - reset="off"：永不过期
/// - reset="daily"：按 UTC 日历天比较（updated_at 与 now 不同天 → 过期）
/// - 其他（默认 idle）：`now - updated_at > idle_minutes` → 过期
///   updated_at 缺失（历史数据）视为未过期（保守，防误杀）。
///
/// R4：参数从 &str 时间戳改为 Timestamp（消除 parse 往返），语义不变。
pub(crate) fn session_expired(
    updated_at: Option<Timestamp>,
    now: Timestamp,
    reset: &str,
    idle_minutes: u64,
) -> Option<String> {
    match reset {
        "off" => None,
        "daily" => match updated_at.map(Timestamp::day_number) {
            Some(updated_day) if updated_day != now.day_number() => Some("每日重置".to_string()),
            _ => None,
        },
        _ => {
            let idle_ms = idle_minutes.saturating_mul(60_000);
            let updated = updated_at?;
            if now.elapsed_since(updated) > idle_ms {
                Some(format!("超过 {idle_minutes} 分钟无活动"))
            } else {
                None
            }
        }
    }
}

/// 客户端替换后的 sessions 处理：keep=false 清空（跨 agent/全新进程语义）；
/// keep=true 保留映射但迁移 generation——通知路由按新代际匹配，旧 session 才能继续收事件。
pub(crate) fn apply_client_replacement_sessions(
    sessions: &mut HashMap<String, SessionInfo>,
    keep_sessions: bool,
    new_generation: u64,
) {
    if !keep_sessions {
        sessions.clear();
    } else {
        for session in sessions.values_mut() {
            session.generation = new_generation;
        }
    }
}

/// B11.1 注入适用性：命令消息（`/` 开头，与 persona 拼接规则一致）不注入。
pub(crate) fn inject_applies_to(content: &str) -> bool {
    !content.trim_start().starts_with('/')
}

/// M5 感知：从 tool_call rawInput 中脱敏提取文件名（`"path":"..."` 形态）。
/// 安全红线（审查修复）：必须解析为 JSON 后取**顶层键**——纯子串匹配会被
/// 值内嵌的 `"path":<secret>` 骗过，把 secret 以文件名形态带进宠物状态并落盘。
pub(crate) fn extract_tool_file_name(raw: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    for key in ["path", "file", "filename", "file_path"] {
        if let Some(value) = parsed.get(key).and_then(|v| v.as_str()) {
            if !value.is_empty() && value.len() <= 256 {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// B11.1 prompt 拼装：注入 context 前置 + 双换行分隔；context 空白时原样返回。
pub(crate) fn compose_inject_prompt(context: &str, text: &str) -> String {
    let context = context.trim();
    if context.is_empty() {
        text.to_string()
    } else {
        format!("{context}\n\n{text}")
    }
}
// ── AppState helpers ──

impl AppState {
    /// 当前 active agent 的 runtime；无 active agent 时返回 None。
    pub(crate) fn active_runtime(&self) -> Option<Arc<AgentRuntime>> {
        AppStateHandles::from_state(self).active_runtime()
    }

    /// 当前 active agent 的 runtime；缺失时返回错误（命令层统一错误路径）。
    /// A10（2026-08-02）：直接返回 PylonError::NoActiveAgent（code=no_active_agent）——
    /// 此前经 String 折叠成 protocol_error，专用码永远发不出。
    pub(crate) fn require_runtime(&self) -> Result<Arc<AgentRuntime>, PylonError> {
        self.active_runtime().ok_or(PylonError::NoActiveAgent)
    }

    /// 锁外 RPC：短锁仅覆盖同步准备（prepare_rpc），发送与等待在锁外执行——
    /// Peri 卡顿时不阻塞其他命令（V14「锁外写 prompt」模式推广到全部 RPC）。
    pub(crate) async fn acp_rpc(
        &self,
        runtime: &AgentRuntime,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, crate::acp::AcpError> {
        let rpc = {
            let acp = runtime.acp.lock().await;
            acp.prepare_rpc(method, params)?
        };
        rpc.complete().await
    }

    /// 差异适配：Hermes 的 set_config_option 不切 model（只认 edit_approval_policy），
    /// 切 model 必须走 unstable 的 session/set_model。核验修复：按 AgentDef 配置
    /// `set_model_api` 判定（不再硬编码 agent id "hermes"）。
    pub(crate) fn uses_set_model_api(&self) -> bool {
        let active_id = self
            .active_agent
            .lock()
            .ok()
            .map(|v| v.clone())
            .unwrap_or_default();
        self.agents
            .lock()
            .ok()
            .and_then(|agents| agents.get(&active_id).cloned())
            .map(|agent| agent.set_model_api)
            .unwrap_or(false)
    }

    pub(crate) fn current_generation(&self, runtime: &AgentRuntime) -> u64 {
        runtime.client_generation.load(Ordering::Acquire)
    }

    pub(crate) fn ensure_generation(
        &self,
        runtime: &AgentRuntime,
        expected: u64,
    ) -> Result<(), String> {
        let current = self.current_generation(runtime);
        if current == expected {
            Ok(())
        } else {
            Err(format!(
                "stale ACP client generation: expected {expected}, current {current}"
            ))
        }
    }

    pub(crate) fn get_active_agent(&self) -> Result<AgentDef, PylonError> {
        let name = self
            .active_agent
            .lock()
            .map_err(|e| PylonError::Acp(e.to_string()))?;
        self.agents
            .lock()
            .map_err(|e| PylonError::Acp(e.to_string()))?
            .get(&*name)
            .cloned()
            .ok_or(PylonError::NoActiveAgent)
    }

    pub(crate) fn agent_cwd(&self) -> String {
        self.active_agent
            .lock()
            .ok()
            .and_then(|name| self.agents.lock().ok()?.get(&*name).cloned())
            .and_then(|a| a.cwd.clone())
            .unwrap_or_else(|| ".".to_string())
    }

    pub(crate) fn current_mcp_servers(&self) -> Result<Vec<crate::mcp::McpServerConfig>, String> {
        Ok(self
            .runtime_mcp
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_default())
    }

    pub(crate) fn log_runtime_summary(
        &self,
        level: &str,
        source: &str,
        session: Option<String>,
        message: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) {
        // P2-6：委托 handles 版本（唯一实现，避免双份逐字重复）。
        AppStateHandles::from_state(self)
            .log_runtime_summary(level, source, session, message, fields);
    }

    pub(crate) fn workspace_root_for_source(
        &self,
        runtime: &AgentRuntime,
        source: &str,
    ) -> Result<String, PylonError> {
        // A10（2026-08-02）：Mutex 中毒视为协议层错误（Acp 变体只留给 ACP 客户端层）。
        let sessions = runtime
            .sessions
            .lock()
            .map_err(|e| PylonError::Protocol(e.to_string()))?;
        sessions
            .get(source)
            .map(|session| session.cwd.clone())
            .ok_or_else(|| PylonError::SessionNotFound(source.to_string()))
    }

    pub(crate) fn agent_status_payload(&self) -> serde_json::Value {
        let handles = AppStateHandles::from_state(self);
        handles.agent_status_payload(handles.active_runtime().as_deref())
    }

    pub(crate) fn get_peri_id(
        &self,
        runtime: &AgentRuntime,
        source: &str,
    ) -> Result<String, PylonError> {
        let sessions = runtime
            .sessions
            .lock()
            // A10（2026-08-02）：Mutex 中毒改 Protocol——Acp 变体只留给 ACP 客户端层。
            .map_err(|e| PylonError::Protocol(e.to_string()))?;
        sessions
            .get(source)
            .map(|s| s.peri_id.clone())
            .ok_or_else(|| PylonError::SessionNotFound(source.to_string()))
    }

    pub(crate) fn export_session_owner(
        &self,
        runtime: &AgentRuntime,
        peri_id: &str,
    ) -> Result<(String, u64, String), String> {
        let generation = self.current_generation(runtime);
        let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
        let matches: Vec<(&String, &SessionInfo)> = sessions
            .iter()
            .filter(|(_, session)| session.peri_id == peri_id && session.generation == generation)
            .collect();
        match matches.as_slice() {
            [(source, session)] => Ok(((*source).clone(), generation, session.cwd.clone())),
            [] => Err("export session not found in the active generation".to_string()),
            _ => Err("export session owner is ambiguous".to_string()),
        }
    }

    pub(crate) fn session_matches(
        &self,
        runtime: &AgentRuntime,
        source: &str,
        peri_id: &str,
        generation: u64,
    ) -> Result<bool, String> {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        Ok(sessions.get(source).map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true))
    }

    pub(crate) fn with_session_if_matches<T>(
        &self,
        runtime: &AgentRuntime,
        source: &str,
        peri_id: &str,
        generation: u64,
        update: impl FnOnce(&mut SessionInfo) -> T,
    ) -> Result<T, String> {
        self.ensure_generation(runtime, generation)?;
        let mut sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
        let session = sessions
            .get_mut(source)
            .ok_or_else(|| format!("stale session mapping for source: {source}"))?;
        if !session_mapping_matches(&session.peri_id, session.generation, peri_id, generation) {
            return Err(format!("stale session mapping for source: {source}"));
        }
        Ok(update(session))
    }

    pub(crate) fn mark_first_prompt_if_matches(
        &self,
        runtime: &AgentRuntime,
        source: &str,
        peri_id: &str,
        generation: u64,
    ) -> Result<(), String> {
        self.with_session_if_matches(runtime, source, peri_id, generation, |session| {
            session.has_first_prompt = true;
        })
    }

    pub(crate) fn remove_session_if_matches(
        &self,
        runtime: &AgentRuntime,
        source: &str,
        peri_id: &str,
        generation: u64,
    ) -> Result<bool, String> {
        let mut sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
        if sessions.get(source).map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true)
        {
            Ok(sessions.remove(source).is_some())
        } else {
            Ok(false)
        }
    }

    pub(crate) fn start_runtime_log_dispatcher(&self, window: tauri::WebviewWindow) {
        let mut events = self.runtime_logs.subscribe();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(entry) => match serde_json::to_value(entry) {
                        Ok(payload) => emit_event(&window, "pylon:runtime-log", payload),
                        Err(error) => log::warn!("serialize runtime log event failed: {error}"),
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        log::warn!("runtime log event dispatcher lagged by {count} entries");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    pub(crate) async fn connect_and_replace(
        &self,
        runtime: &Arc<AgentRuntime>,
        window: &tauri::WebviewWindow,
        agent: &AgentDef,
        agent_id: Option<String>,
        start_status: AgentLifecycleStatus,
        log_action: &str,
    ) -> Result<(), String> {
        // 手动 switch/reconnect：跨 agent/全新进程语义，keep_sessions=false（清空映射）。
        // 实现委托给静态辅助，自动重连（keep_sessions=true）与手动路径共用同一份逻辑。
        let handles = AppStateHandles::from_state(self);
        crate::lifecycle::do_connect_and_replace(
            &handles,
            runtime,
            window,
            agent,
            agent_id,
            start_status,
            log_action,
            false,
            true,
        )
        .await
    }

    /// 平台 ingest 目标 runtime 就绪检查（B10.3）：未连接时懒启动连接。
    /// announce=false——平台消息路由不切换/不广播 GUI active agent 状态。
    pub(crate) async fn ensure_runtime_ready(
        &self,
        runtime: &Arc<AgentRuntime>,
        agent_id: &str,
        window: &tauri::WebviewWindow,
    ) -> Result<(), String> {
        let status = runtime
            .agent_runtime
            .lock()
            .map(|s| s.status)
            .unwrap_or(AgentLifecycleStatus::Disconnected);
        if matches!(
            status,
            AgentLifecycleStatus::Connected
                | AgentLifecycleStatus::Connecting
                | AgentLifecycleStatus::Reconnecting
        ) {
            return Ok(());
        }
        let agent = self
            .agents
            .lock()
            .map_err(|e| e.to_string())?
            .get(agent_id)
            .cloned()
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        let keep = matches!(status, AgentLifecycleStatus::Crashed);
        let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
        // 双检查：拿到生命周期锁后重查（防并发连接）
        let status = runtime
            .agent_runtime
            .lock()
            .map(|s| s.status)
            .unwrap_or(AgentLifecycleStatus::Disconnected);
        if matches!(
            status,
            AgentLifecycleStatus::Connected
                | AgentLifecycleStatus::Connecting
                | AgentLifecycleStatus::Reconnecting
        ) {
            return Ok(());
        }
        let handles = AppStateHandles::from_state(self);
        crate::lifecycle::do_connect_and_replace(
            &handles,
            runtime,
            window,
            &agent,
            None,
            AgentLifecycleStatus::Connecting,
            "platform-ingest",
            keep,
            false,
        )
        .await
    }
}
/// 会话过期检查（B10.3b，expiry watcher 每轮调用）：
/// 遍历所有 runtime 的会话，按绑定 reset 策略判定过期；过期会话
/// close ACP + 移除映射 + 平台通知 + 日志。生成中会话（prompt 锁被占用）豁免。
pub(crate) async fn check_session_expiry(state: &AppState) {
    let now = Timestamp::now();
    // 核验修复：平台 source 判定（适配器前缀或静态绑定命中）。GUI local 会话
    // 由前端/用户管理，不参与后台过期重置（watcher 是 B10.3b 为平台会话设计）。
    let platform_keys: Vec<String> = state.gateway.adapter_keys();
    // P3：前缀循环外预构造，避免闭包内每 session 每 key 重复 format 分配。
    let platform_prefixes: Vec<String> = platform_keys
        .into_iter()
        .map(|key| format!("{key}:"))
        .collect();
    let is_platform_source = |source: &str| -> bool {
        platform_prefixes
            .iter()
            .any(|prefix| source.starts_with(prefix))
            || state.gateway.binding(source).is_some()
    };
    for runtime in state.runtimes.all() {
        let sessions: Vec<(String, String, Option<Timestamp>)> = runtime
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .map(|(source, info)| (source.clone(), info.peri_id.clone(), info.updated_at))
                    .collect()
            })
            .unwrap_or_default();
        for (source, peri_id, updated_at) in sessions {
            if !is_platform_source(&source) {
                continue;
            }
            // 活跃豁免：生成中（prompt 锁被占用）永不视为过期
            let generating = runtime
                .prompt_locks
                .lock()
                .ok()
                .and_then(|locks| locks.get(&source).cloned())
                .map(|lock| lock.try_lock().is_err())
                .unwrap_or(false);
            if generating {
                continue;
            }
            let binding = state.gateway.binding(&source);
            let reset = binding
                .as_ref()
                .and_then(|b| b.reset.as_deref())
                .unwrap_or("idle");
            let idle_minutes = binding
                .as_ref()
                .and_then(|b| b.idle_minutes)
                .unwrap_or(1440);
            let Some(reason) = session_expired(updated_at, now, reset, idle_minutes) else {
                continue;
            };
            log::info!("会话过期 ({source}): {reason}");
            // 审查修复：删除前按 (peri_id, generation) 复核映射——close RPC 期间若
            // 同 source 新建了会话，不得把新映射误删（旧映射已被 new_session 替换）。
            let removed = {
                let generation = runtime.client_generation.load(Ordering::Acquire);
                let mut sessions = match runtime.sessions.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let current = sessions.get(&source);
                if current.map(|session| {
                    session_mapping_matches(
                        &session.peri_id,
                        session.generation,
                        &peri_id,
                        generation,
                    )
                }) != Some(true)
                {
                    false
                } else {
                    let current = current.expect("已确认存在");
                    // 锁内用最新 updated_at 复核——快照值与删除时点之间新消息到达会刷新
                    // updated_at，不得误杀刚活跃的会话。
                    if session_expired(current.updated_at, now, reset, idle_minutes).is_some() {
                        sessions.remove(&source).is_some()
                    } else {
                        false
                    }
                }
            };
            if !removed {
                // 映射已变更（新会话已接管 source）——不 close、不通知
                continue;
            }
            // close ACP session（失败不阻断本地清理；旧 peri_id 独立于映射）
            if let Ok(close_params) = acp::session_close_params(&peri_id) {
                if let Err(error) = state
                    .acp_rpc(&runtime, acp::METHOD_SESSION_CLOSE, close_params)
                    .await
                {
                    log::warn!("close expired session {peri_id}: {error}");
                }
            }
            // 审查修复：应答该 session 挂起的权限请求为 Cancelled（协议要求）
            crate::permission::respond_pending_permissions_cancelled(&runtime, &peri_id).await;
            // 平台通知（用户可见重置原因）：投递给 source 归属的适配器。
            // 2026-08-02 修复：原硬编码 gateway.adapter("qq") 只有 QQ 能收到通知；
            // 泛化为与 deliver_all 同语义的前缀匹配（source 首段 == platform_key），
            // 未来新增平台适配器自动生效。
            let platform_key = source.split(':').next().unwrap_or("");
            if !platform_key.is_empty() {
                if let Some(adapter) = state.gateway.adapter(platform_key) {
                    let _ = adapter.deliver_text(&source, &format!("[会话已重置] {reason}"));
                }
            }
            state.log_runtime_summary(
                "warn",
                "session",
                Some(source),
                &format!("Session expired ({reason})"),
                serde_json::Map::new(),
            );
        }
    }
}
#[tauri::command]
pub(crate) async fn new_session(
    state: tauri::State<'_, AppState>,
    source: String,
    persona: String,
    cwd: Option<String>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    // B1：GUI 不得冒名平台源——qq:* 无 binding → 拒绝（防会话建立后出站投递到 QQ）。
    if source.starts_with("qq:") && state.gateway.binding(&source).is_none() {
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
    {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= MAX_SESSIONS {
            return Err(PylonError::Protocol("max sessions reached".to_string()));
        }
    }
    let session_cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    let generation = state.current_generation(&runtime);
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    let response = match state
        .inner()
        .acp_rpc(
            &runtime,
            acp::METHOD_SESSION_NEW,
            acp::session_new_params(&session_cwd, mcp_servers)?,
        )
        .await
    {
        Ok(response) => response,
        Err(error) => {
            state.inner().log_runtime_summary(
                "error",
                "session",
                Some(source.clone()),
                "Session creation failed",
                serde_json::Map::new(),
            );
            return Err(error.into());
        }
    };
    state.ensure_generation(&runtime, generation)?;
    let peri_id = AcpClient::session_id_from(&response)?;
    let mut session = SessionInfo::new(peri_id.clone(), persona, session_cwd, false, generation);
    session.apply_session_response(&response);
    let replaced = runtime
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(source.clone(), session);
    if let Some(old) = replaced {
        if let Ok(close_params) = acp::session_close_params(&old.peri_id) {
            if let Err(error) = state
                .inner()
                .acp_rpc(&runtime, acp::METHOD_SESSION_CLOSE, close_params)
                .await
            {
                log::warn!("close replaced session: {}", error);
            }
        }
    }
    state.inner().log_runtime_summary(
        "info",
        "session",
        Some(source.clone()),
        "Session creation succeeded",
        serde_json::Map::new(),
    );
    // Return full response so frontend gets modes + configOptions + sessionId
    Ok(response)
}

#[tauri::command]
// clippy 2026-08-02：8 参含 2 个 Tauri 注入（state/window）+ 6 个业务参数（source/content/
// persona/session_prompt/attachments/mcp_servers），send_message 为 IPC 契约签名不可折叠。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_message<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::Window<R>,
    source: String,
    content: String,
    persona: String,
    session_prompt: Option<String>,
    attachments: Option<Vec<String>>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<String, PylonError> {
    let runtime = state.inner().require_runtime()?;
    send_prompt_core(
        state.inner(),
        &runtime,
        Some(&window),
        &state.gateway,
        &source,
        &content,
        &persona,
        session_prompt.as_deref(),
        attachments.as_deref(),
        mcp_servers,
        None,
    )
    .await
}

/// 公共发送管线（GUI `send_message` 与 gateway 平台 ingest 共用，B10.3）：
/// per-runtime 会话创建/映射/prompt 锁/等待/cancel/事件广播。
/// 平台 ingest 经 handler 路由到绑定 agent 的 runtime 后调用本函数。
/// `cwd`：自动建会话时的工作目录——平台路由必须传绑定 agent 的 cwd
/// （绑定 agent ≠ GUI active agent 时 agent_cwd() 会读错）；None 回退 active agent。
// clippy 2026-08-02：11 参为管线全参数（state/runtime/window/gateway/source/content/persona/
// session_prompt/attachments/mcp_servers/cwd），GUI 与平台双调用点共享签名；收敛为参数
// 结构体需同步重构调用方与测试，收益低于风险，保持显式。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_prompt_core<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    window: Option<&tauri::Window<R>>,
    gateway: &GatewayCore,
    source: &str,
    content: &str,
    persona: &str,
    session_prompt: Option<&str>,
    attachments: Option<&[String]>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
    cwd: Option<&str>,
) -> Result<String, PylonError> {
    // B1：GUI source 不得冒名平台源——qq:* 无 binding → 拒绝（防冒名出站投递到 QQ）。
    // 平台 ingest 的 qq:* 必带 binding（绑定命中），不受影响。
    if source.starts_with("qq:") && gateway.binding(source).is_none() {
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
                serde_json::Value::from(attachments.map_or(0, <[String]>::len)),
            ),
        ]),
    );
    let requested_mcp_servers =
        mcp::validate_and_serialize(mcp_servers.or_else(|| state.current_mcp_servers().ok()))?;
    let prompt_lock = prompt_lock_for(&runtime.prompt_locks, source);
    let _prompt_guard = prompt_lock.lock().await;

    // 消息到达即活动：更新会话最后活动时间（B10.3b 会话超时判定）；
    // 生成中的会话另有 prompt 锁活跃豁免，双保险。
    if let Ok(mut sessions) = runtime.sessions.lock() {
        if let Some(session) = sessions.get_mut(source) {
            session.updated_at = Some(Timestamp::now());
        }
    }

    if runtime.acp.lock().await.is_crashed() {
        if let Some(window) = window {
            emit_event_all(
                window,
                gateway,
                source,
                "peri:error",
                serde_json::json!({"source": source, "error": PylonError::AgentCrashed.to_string()}),
            );
        }
        return Err(PylonError::AgentCrashed);
    }

    let (peri_id, is_first) = {
        let _creation_guard = runtime.session_creation.lock().await;
        let existing = {
            let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
            sessions
                .get(source)
                .map(|session| (session.peri_id.clone(), !session.has_first_prompt))
        };
        if let Some(result) = existing {
            result
        } else {
            {
                let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
                if sessions.len() >= MAX_SESSIONS {
                    return Err(PylonError::Protocol("max sessions reached".to_string()));
                }
            }
            // P1-1：会话 cwd 优先取调用方显式绑定（平台路由 = 绑定 agent 的 cwd，
            // 可能 ≠ GUI active agent）；无则回退 active agent cwd。
            let session_cwd = cwd.map(str::to_string).unwrap_or_else(|| state.agent_cwd());
            let generation = state.current_generation(runtime);
            let response = match state
                .acp_rpc(
                    runtime,
                    acp::METHOD_SESSION_NEW,
                    acp::session_new_params(&session_cwd, requested_mcp_servers.clone())?,
                )
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
            let pid = AcpClient::session_id_from(&response)?;
            let mut session = SessionInfo::new(
                pid.clone(),
                persona.to_string(),
                session_cwd,
                false,
                generation,
            );
            session.apply_session_response(&response);
            runtime
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .insert(source.to_string(), session);
            (pid, true)
        }
    };

    let attachment_paths = attachments.unwrap_or_default();
    let prompt_generation = state.current_generation(runtime);

    let effective_persona = session_prompt
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(persona);

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
                log::warn!("Prism inject failed: {error}");
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
    #[allow(clippy::needless_borrow)]
    let prompt_blocks = AcpClient::prompt_blocks(prompt_text, &attachment_paths)?;

    state
        .pet
        .lock()
        .map(|mut p| crate::pet::on_user_sent(&mut p))
        .ok();
    if let Some(window) = window {
        let mut user_payload = serde_json::json!({ "source": source, "content": content });
        if !inject_activated.is_empty() {
            user_payload["injectActivated"] = serde_json::Value::Array(
                inject_activated
                    .iter()
                    .map(|item| serde_json::Value::String(item.clone()))
                    .collect(),
            );
        }
        emit_event(window, "peri:user", user_payload);
    }
    let rpc = {
        let acp = runtime.acp.lock().await;
        acp.prepare_prompt(&peri_id, prompt_blocks)?
    };
    // 取消/连接关闭分支清理 pending 仍需 request_id（send_keep_rx 会消费 rpc）。
    let request_id = rpc.id;
    // B11：回合推进——该 session 用户回合 +1（注入/持久化共用同一 round）；
    // 清空上一回合回复文本（本轮回复由 dispatcher 重新收集）。
    // P2-8：必须在发送（send_keep_rx）之前完成——发送成功后清空会与
    // dispatcher 的并行追加竞态：agent 极快响应时本轮回复文本会被清掉。
    if let Ok(mut sessions) = runtime.sessions.lock() {
        if let Some(session) = sessions.get_mut(source) {
            session.inject_round = session.inject_round.saturating_add(1);
            // B11.2：先标记收集回合（dispatcher 据此绑定流式收集），再清空文本。
            session.last_response_round = session.inject_round;
            session.last_response_text.clear();
        }
    }
    // R3：send_keep_rx 统一 10s 写超时（对齐 complete 路径；原裸 write_tx.send 在
    // writer 阻塞 + 队列满时会无限挂起），失败已清理 pending，只收敛会话映射。
    let mut rx = match rpc.send_keep_rx().await {
        Ok(rx) => rx,
        Err(error) => {
            let _ = state.remove_session_if_matches(runtime, source, &peri_id, prompt_generation);
            return Err(PylonError::from(error));
        }
    };
    let acp_for_cancel = runtime.acp.clone();
    let peri_id_for_cancel = peri_id.clone();
    let result = acp::wait_prompt_with_cancel(
        &mut rx,
        Duration::from_secs(acp::PROMPT_TIMEOUT_SECS),
        Duration::from_secs(acp::CANCEL_SETTLE_TIMEOUT_SECS),
        move || async move {
            // R6e：cancel 闭包契约是 Result<(), String>（wait_prompt_with_cancel 泛型边界）
            acp_for_cancel
                .lock()
                .await
                .cancel_session(&peri_id_for_cancel)
                .await
                .map_err(|e| e.to_string())
        },
    )
    .await;

    match result {
        PromptWaitOutcome::Response(raw) => {
            state.ensure_generation(runtime, prompt_generation)?;
            if !state.session_matches(runtime, source, &peri_id, prompt_generation)? {
                return Err(PylonError::Protocol(format!(
                    "stale session mapping for source: {source}"
                )));
            }
            if let Some(error) = raw.error {
                let error = error.to_string();
                if let Some(window) = window {
                    emit_event_all(
                        window,
                        gateway,
                        source,
                        "peri:error",
                        serde_json::json!({"source": source, "error": error}),
                    );
                }
                let _ = state.pet.lock().map(|mut p| crate::pet::on_error(&mut p));
                Err(PylonError::Protocol(error))
            } else {
                let data = raw.result.unwrap_or(serde_json::Value::Null);
                AcpClient::prompt_stop_reason(&data).map_err(|error| {
                    let error = error.to_string();
                    if let Some(window) = window {
                        emit_event_all(
                            window,
                            gateway,
                            source,
                            "peri:error",
                            serde_json::json!({"source": source, "error": error}),
                        );
                    }
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
                    let _ = state.remove_session_if_matches(
                        runtime,
                        source,
                        &peri_id,
                        prompt_generation,
                    );
                    if let Some(window) = window {
                        emit_event_all(
                            window,
                            gateway,
                            source,
                            "peri:error",
                            serde_json::json!({"source": source, "error": error}),
                        );
                    }
                    return Err(error.into());
                }
                if is_first {
                    state.mark_first_prompt_if_matches(
                        runtime,
                        source,
                        &peri_id,
                        prompt_generation,
                    )?;
                }
                if let Some(window) = window {
                    emit_event_all(
                        window,
                        gateway,
                        source,
                        "peri:done",
                        serde_json::json!({"source": source, "data": data}),
                    );
                }
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
                                    log::warn!("Prism persist 返回失败: {value}");
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
                                log::warn!("Prism persist failed: {error}");
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
                Ok(peri_id)
            }
        }
        PromptWaitOutcome::ConnectionClosed => {
            runtime.acp.lock().await.remove_pending(request_id);
            let _ = state.remove_session_if_matches(runtime, source, &peri_id, prompt_generation);
            state.log_runtime_summary(
                "error",
                "prompt",
                Some(source.to_string()),
                "Prompt connection closed",
                serde_json::Map::new(),
            );
            Err(PylonError::Protocol("ACP connection closed".to_string()))
        }
        PromptWaitOutcome::CancelledAfterTimeout {
            response,
            cancel_error,
        } => {
            runtime.acp.lock().await.remove_pending(request_id);
            if let Some(cancel_error) = cancel_error {
                log::warn!("cancel timed-out prompt {}: {}", peri_id, cancel_error);
            }
            // B9：cancel 后应答该 session 挂起的权限请求为 Cancelled
            crate::permission::respond_pending_permissions_cancelled(runtime, &peri_id).await;
            if response.is_none() {
                match state.remove_session_if_matches(runtime, source, &peri_id, prompt_generation)
                {
                    Ok(true) => {
                        log::error!(
                            "cancelled prompt {} did not settle within {}s; removed local session mapping",
                            peri_id,
                            acp::CANCEL_SETTLE_TIMEOUT_SECS
                        );
                        if let Ok(close_params) = acp::session_close_params(&peri_id) {
                            if let Err(close_error) = state
                                .acp_rpc(runtime, acp::METHOD_SESSION_CLOSE, close_params)
                                .await
                            {
                                log::warn!(
                                    "close unsettled prompt session {}: {}",
                                    peri_id,
                                    close_error
                                );
                            }
                        }
                    }
                    Ok(false) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            let error = "timed out after 300s";
            if let Some(window) = window {
                emit_event_all(
                    window,
                    gateway,
                    source,
                    "peri:error",
                    serde_json::json!({"source": source, "error": error}),
                );
            }
            // M5 感知：超时 → 发呆（区别于普通失败）
            let _ = state.pet.lock().map(|mut p| crate::pet::on_timeout(&mut p));
            state.log_runtime_summary(
                "error",
                "prompt",
                Some(source.to_string()),
                "Prompt timed out",
                serde_json::Map::from_iter([(
                    "result".to_string(),
                    serde_json::Value::String("timeout".to_string()),
                )]),
            );
            Err(PylonError::Protocol(error.to_string()))
        }
    }
}

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
    // 差异适配：Hermes 切 model 必须走 session/set_model（set_config_option 只认
    // edit_approval_policy，其余存 config_options 不生效）；Peri 走平铺 set_config_option。
    let use_set_model = key == "model" && state.inner().uses_set_model_api();
    let response = if use_set_model {
        state
            .inner()
            .acp_rpc(
                &runtime,
                acp::METHOD_SESSION_SET_MODEL,
                acp::session_set_model_params(&peri_id, &value)?,
            )
            .await?
    } else {
        state
            .inner()
            .acp_rpc(
                &runtime,
                acp::METHOD_SESSION_SET_CONFIG_OPTION,
                acp::session_set_config_option_params(&peri_id, &key, &value)?,
            )
            .await?
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
    {
        let acp = runtime.acp.lock().await;
        let _ = acp.cancel_session(&peri_id).await;
    }
    // Hermes 未实现 session/close（-32601）——降级为本地清理（映射已删，见下）
    if let Err(error) = state
        .inner()
        .acp_rpc(
            &runtime,
            acp::METHOD_SESSION_CLOSE,
            acp::session_close_params(&peri_id)?,
        )
        .await
    {
        let message = error.to_string();
        if message.contains("-32601") || message.contains("Method not found") {
            log::warn!("agent does not support session/close ({message}); local cleanup only");
        } else {
            return Err(error.into());
        }
    }
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
    runtime.acp.lock().await.cancel_session(&peri_id).await?;
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

#[tauri::command]
pub(crate) async fn load_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.iter().map(|(source, info)| {
        serde_json::json!({"source": source, "periId": info.peri_id, "persona": info.persona, "cwd": info.cwd,
            "title": info.title, "mode": info.mode, "configOptions": info.config_options, "model": info.model, "tokensIn": info.tokens_in, "tokensOut": info.tokens_out,
            "tokensTotal": info.tokens_total, "contextSize": info.context_size})
    }).collect())
}

/// B2 Inspector 完整版：全量（所有 runtime）聚合 + per-agent runtimes 增量 +
/// workspace 增量。v1 顶层契约（agent/summary/sessions）保持形状，语义升级为全局：
/// - summary/sessions 合并所有 runtime（session 行新增 agentId 区分来源）
/// - runtimes[]：每个 agent 的运行时状态与聚合数
/// - workspace{}：source → {path, exists, readable}（复用 workspace::workspace_root）
pub(crate) fn build_full_inspector_payload(
    entries: &[(String, HashMap<String, SessionInfo>, AgentRuntimeState)],
    active_id: &str,
) -> serde_json::Value {
    let mut all_sessions: Vec<(String, String, &SessionInfo)> = Vec::new();
    let mut total_tokens: u64 = 0;
    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;
    let mut active_count: usize = 0;
    let mut workspace = serde_json::Map::new();
    // O29：cwd → workspace_root 结果缓存，同一 cwd 只计算一次（跨 runtime/source 去重）。
    let mut workspace_cache: HashMap<String, serde_json::Value> = HashMap::new();
    let mut runtimes: Vec<serde_json::Value> = Vec::new();

    for (agent_id, sessions, runtime_state) in entries {
        let mut session_count = 0usize;
        let mut runtime_tokens: u64 = 0;
        let mut runtime_active: usize = 0;
        for (source, session) in sessions {
            session_count += 1;
            runtime_tokens += session.tokens_total;
            total_tokens += session.tokens_total;
            total_in += session.tokens_in;
            total_out += session.tokens_out;
            if session.has_first_prompt {
                runtime_active += 1;
                active_count += 1;
            }
            all_sessions.push((agent_id.clone(), source.clone(), session));
            // O29：同一 cwd 只计算一次 workspace_root；按 source 逐项写入（值相同）。
            let value = workspace_cache
                .entry(session.cwd.clone())
                .or_insert_with(|| {
                    let root = workspace::workspace_root(
                        source.clone(),
                        std::path::Path::new(&session.cwd),
                    );
                    serde_json::to_value(root).unwrap_or(serde_json::Value::Null)
                })
                .clone();
            workspace.insert(source.clone(), value);
        }
        runtimes.push(serde_json::json!({
            "agentId": agent_id,
            "status": runtime_state.status.as_str(),
            "lastError": runtime_state.last_error,
            "lastConnectedAt": runtime_state.last_connected_at,
            "sessionCount": session_count,
            "activeCount": runtime_active,
            "tokensTotal": runtime_tokens,
        }));
    }

    let session_rows: Vec<serde_json::Value> = all_sessions
        .iter()
        .map(|(agent_id, source, s)| {
            serde_json::json!({
                "agentId": agent_id,
                "source": source,
                "periId": s.peri_id,
                "title": s.title,
                "model": s.model,
                "mode": s.mode,
                "tokensIn": s.tokens_in,
                "tokensOut": s.tokens_out,
                "tokensTotal": s.tokens_total,
                "contextSize": s.context_size,
                "cwd": s.cwd,
            })
        })
        .collect();

    serde_json::json!({
        "agent": {
            "id": active_id,
            "status": entries.iter().find(|(id, _, _)| id == active_id)
                .map(|(_, _, rs)| rs.status.as_str())
                .unwrap_or("disconnected"),
            "lastError": entries.iter().find(|(id, _, _)| id == active_id)
                .and_then(|(_, _, rs)| rs.last_error.clone()),
            "lastConnectedAt": entries.iter().find(|(id, _, _)| id == active_id)
                .and_then(|(_, _, rs)| rs.last_connected_at),
        },
        "summary": {
            "sessionCount": all_sessions.len(),
            "activeCount": active_count,
            "tokensTotal": total_tokens,
            "tokensIn": total_in,
            "tokensOut": total_out,
        },
        "sessions": session_rows,
        "workspace": serde_json::Value::Object(workspace),
        "runtimes": runtimes,
    })
}

#[tauri::command]
pub(crate) async fn session_inspector(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    // B2 完整版：遍历所有 runtime（含无会话的），全局聚合 + workspace/runtimes 增量。
    let entries: Vec<(String, HashMap<String, SessionInfo>, AgentRuntimeState)> = state
        .inner()
        .runtimes
        .all_with_ids()
        .into_iter()
        .map(|(agent_id, runtime)| {
            let sessions = runtime
                .sessions
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default();
            let runtime_state = runtime
                .agent_runtime
                .lock()
                .map(|v| v.clone())
                .unwrap_or_default();
            (agent_id, sessions, runtime_state)
        })
        .collect();
    let active_id = state
        .active_agent
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    Ok(build_full_inspector_payload(&entries, &active_id))
}
#[tauri::command]
pub(crate) async fn load_persisted_session(
    state: tauri::State<'_, AppState>,
    source: String,
    peri_id: String,
    cwd: Option<String>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _creation_guard = runtime.session_creation.lock().await;
    let generation = state.current_generation(&runtime);
    let cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    // mcp_servers 必须随 session/load 发送：ACP schema 1.4 该字段无 default，
    // Hermes（Pydantic）缺失即拒绝；Peri 容忍。无配置时 validate 产出空数组。
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    {
        // 与 new_session / send_message 自动创建一致，恢复历史会话也受上限约束；
        // 同 source 重载（替换）不占新名额。
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if !sessions.contains_key(&source) && sessions.len() >= MAX_SESSIONS {
            return Err(PylonError::Protocol("max sessions reached".to_string()));
        }
    }
    let previous = runtime.sessions.lock().map_err(|e| e.to_string())?.insert(
        source.clone(),
        SessionInfo::new(
            peri_id.clone(),
            String::new(),
            cwd.clone(),
            true,
            generation,
        ),
    );
    let acp = runtime.acp.lock().await;
    let load_result = acp
        .load_session_with_replay(&peri_id, &cwd, mcp_servers)
        .await;
    drop(acp);
    match load_result {
        Ok((response, _replay)) => {
            if let Err(error) = state.ensure_generation(&runtime, generation) {
                let mut sessions = runtime
                    .sessions
                    .lock()
                    .map_err(|lock_error| lock_error.to_string())?;
                if sessions.get(&source).map(|session| {
                    session_mapping_matches(
                        &session.peri_id,
                        session.generation,
                        &peri_id,
                        generation,
                    )
                }) == Some(true)
                {
                    if let Some(previous) = previous {
                        sessions.insert(source.clone(), previous);
                    } else {
                        sessions.remove(&source);
                    }
                }
                return Err(error.into());
            }
            state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
                session.apply_session_response(&response);
            })?;
            Ok(response)
        }
        Err(error) => {
            let mut sessions = runtime
                .sessions
                .lock()
                .map_err(|lock_error| lock_error.to_string())?;
            if sessions.get(&source).map(|session| {
                session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
            }) == Some(true)
            {
                if let Some(previous) = previous {
                    sessions.insert(source.clone(), previous);
                } else {
                    sessions.remove(&source);
                }
            }
            Err(PylonError::from(error))
        }
    }
}

#[tauri::command]
pub(crate) async fn list_persisted_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let cwd = state.get_active_agent().ok().and_then(|a| a.cwd);
    let mut params = serde_json::json!({});
    if let Some(c) = cwd {
        params["cwd"] = serde_json::Value::String(c);
    }
    let response = state
        .inner()
        .acp_rpc(&runtime, acp::METHOD_SESSION_LIST, params)
        .await?;
    state.ensure_generation(&runtime, generation)?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A10：无 active agent 的裸状态（active_agent 指向不存在的 runtime）。
    fn state_without_active_runtime() -> AppState {
        AppState {
            runtimes: Arc::new(crate::runtime::AgentRuntimeManager::new()),
            agents: Arc::new(Mutex::new(HashMap::new())),
            active_agent: Arc::new(Mutex::new("ghost-agent".to_string())),
            pet: Arc::new(Mutex::new(crate::pet::PetState::default())),
            runtime_logs: crate::runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism: crate::prism::PrismClient::unavailable("test".to_string()),
            gateway: Arc::new(GatewayCore::new()),
            approval_mode: Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: std::sync::atomic::AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
        }
    }

    #[test]
    fn require_runtime_without_active_agent_returns_no_active_agent() {
        // A10：require_runtime 无 active agent 时返回专用错误码（不折叠成 protocol_error）。
        let state = state_without_active_runtime();
        match state.require_runtime() {
            Ok(_) => panic!("require_runtime must fail without an active runtime"),
            Err(error) => {
                assert_eq!(error.code(), "no_active_agent");
                assert_eq!(error.to_string(), "no active agent configured");
            }
        }
    }

    /// B1：GUI source 冒名平台源（qq:* 无 binding）必须在 send_prompt_core 入口被拒绝，
    /// 不得建立会话（与 deliver_all 出站白名单构成双防线）。
    #[tokio::test]
    async fn send_prompt_core_rejects_unbound_qq_gui_source() {
        let state = state_without_active_runtime();
        let runtime = AgentRuntime::new_disconnected();
        // gateway 只绑定 qq:group:123；qq:group:999 无 binding（GUI 冒名）
        let gateway = GatewayCore::from_config(
            crate::gateway::route::parse_config(
                r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
            )
            .expect("合法配置"),
        );
        let error = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &gateway,
            "qq:group:999",
            "你好",
            "",
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("无 binding 的 qq:* source 必须被拒绝");
        assert_eq!(error.code(), "protocol_error");
        assert!(
            error
                .to_string()
                .contains("invalid GUI source: qq:group:999"),
            "错误信息必须指明非法 GUI source，实际: {error}"
        );
        // 正对照：绑定命中的 qq:* source 放行（后续失败来自未连接 ACP，而非 source 校验）
        let bound_error = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &gateway,
            "qq:group:123",
            "你好",
            "",
            None,
            None,
            None,
            None,
        )
        .await
        .expect_err("绑定命中应放行 source 校验，继续管线直到连接层失败");
        assert!(
            !bound_error.to_string().contains("invalid GUI source"),
            "绑定命中的 qq:* source 不得被 source 校验拒绝，实际: {bound_error}"
        );
    }

    /// A3：Round N 迟到 chunk 在 Round N+1 推进（clear）之后才被 dispatcher 追加
    /// → 必须被丢弃，不得污染 Round N+1 的 last_response_text（persist 落库依据）。
    #[test]
    fn stale_round_chunk_is_dropped_after_round_advance() {
        let mut session = SessionInfo::new(
            "peri-1".to_string(),
            "persona".to_string(),
            "cwd".to_string(),
            false,
            1,
        );
        // Round N 推进（send_message 内路径）：回合 +1、标记收集回合、清空文本。
        session.inject_round = session.inject_round.saturating_add(1);
        session.last_response_round = session.inject_round;
        // dispatcher 于 Round N 接收并收集 chunk（received_round = 1）。
        session.collect_response_chunk("回合N文本", 1);
        assert_eq!(session.last_response_text, "回合N文本");
        // Round N+1 推进：回合 +1、标记收集回合、清空文本。
        session.inject_round = session.inject_round.saturating_add(1);
        session.last_response_round = session.inject_round;
        session.last_response_text.clear();
        // Round N 迟到 chunk：接收于 Round N（received_round = 1），Round N+1
        // 推进之后才被 dispatcher 追加 → 丢弃，不污染 Round N+1 文本。
        session.collect_response_chunk("迟到文本", 1);
        assert!(
            !session.last_response_text.contains("迟到文本"),
            "Round N 迟到 chunk 不得混入 Round N+1 的回复文本"
        );
        // Round N+1 自身 chunk 正常收集。
        session.collect_response_chunk("回合N+1文本", 2);
        assert_eq!(session.last_response_text, "回合N+1文本");
    }
}
