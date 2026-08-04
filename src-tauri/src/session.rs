//! 会话域：SessionInfo / AppState helpers / 会话命令 / 过期生命周期。
//! R1 拆分自 lib.rs（行为零变化）。

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::acp::{self, PromptWaitOutcome};
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

    /// 按 runtime 实例解析归属 agent 的 AgentDef（per-agent 协议参数消费：
    /// 附件限制 / close_via_rpc / 超时 / mcp mode 等）。
    /// runtime 注册表按 agent id 键控；平台 ingest 的绑定 agent ≠ GUI active agent，
    /// 故不能取 active agent 的配置。未注册（测试直构形态）/agent 已移除时返回
    /// None——调用方按"缺省 = 现状常量值"处理（G2-03/05/06/07 参数化默认值）。
    pub(crate) fn agent_for_runtime(&self, runtime: &Arc<AgentRuntime>) -> Option<AgentDef> {
        let agent_id = self
            .runtimes
            .all_with_ids()
            .into_iter()
            .find(|(_, registered)| Arc::ptr_eq(registered, runtime))
            .map(|(id, _)| id)?;
        self.agents.lock().ok()?.get(&agent_id).cloned()
    }

    /// 按 runtime 解析协议配置（缺省实例 = 全部默认值 = 重构前全局常量行为）。
    pub(crate) fn protocol_for_runtime(
        &self,
        runtime: &Arc<AgentRuntime>,
    ) -> crate::agent_config::AcpProtocolConfig {
        self.agent_for_runtime(runtime)
            .map(|agent| agent.protocol().clone())
            .unwrap_or_default()
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

    /// P1（E10）：读 MCP wire 缓存（send_prompt_core None 路径）——命中直接返回
    /// （零重算零校验）；miss（None，如启动恢复路径直写 runtime_mcp 后首次读取）
    /// 回退全量重算（校验 + 序列化，语义 = 现状 validate_and_serialize）并回填
    /// （E3 自愈）。写入侧 = lifecycle::set_mcp_servers（同 mcp_write_lock）。
    pub(crate) fn wire_mcp_servers(&self) -> Result<Vec<serde_json::Value>, String> {
        if let Some(cached) = self.mcp_wire.lock().map_err(|e| e.to_string())?.clone() {
            return Ok(cached);
        }
        let servers = self.current_mcp_servers().unwrap_or_default();
        let values = crate::mcp::serialize_for_session(&servers)?;
        if let Ok(mut slot) = self.mcp_wire.lock() {
            *slot = Some(values.clone());
        }
        Ok(values)
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
        let removed = {
            let mut sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
            if sessions.get(source).map(|session| {
                session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
            }) == Some(true)
            {
                sessions.remove(source).is_some()
            } else {
                false
            }
        };
        if removed {
            // O1：映射删除 = 该 source 生命周期结束 → 锁表同步收敛（锁序单向，不嵌套）。
            runtime.remove_prompt_lock(source);
        }
        Ok(removed)
    }

    pub(crate) fn start_runtime_log_dispatcher(&self, window: tauri::WebviewWindow) {
        let mut events = self.runtime_logs.subscribe();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(entry) => match serde_json::to_value(entry) {
                        Ok(payload) => {
                            emit_event(&window, crate::event_names::RUNTIME_LOG, payload)
                        }
                        Err(error) => tracing::warn!("serialize runtime log event failed: {error}"),
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        tracing::warn!("runtime log event dispatcher lagged by {count} entries");
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
    // G4 §3-9（C1）：统一入口 is_platform_source（注册适配器前缀命中 OR 绑定命中，
    // E14 语义与 deliver_all 出站白名单前置条件等价——原 adapter_keys 前缀闭包删除）。
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
            if !state.gateway.is_platform_source(&source) {
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
            tracing::info!("会话过期 ({source}): {reason}");
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
            if removed {
                // O1：映射删除 = 该 source 生命周期结束 → 锁表同步收敛
                runtime.remove_prompt_lock(&source);
            }
            if !removed {
                // 映射已变更（新会话已接管 source）——不 close、不通知
                continue;
            }
            // close ACP session（失败不阻断本地清理；旧 peri_id 独立于映射）。
            // G2-03：D3 消费——close_via_rpc()=false 时跳过 RPC（本地清理语义不变）。
            if state.protocol_for_runtime(&runtime).close_via_rpc() {
                if let Ok(close_params) = acp::session_close_params(&peri_id) {
                    if let Err(error) = state
                        .acp_rpc(&runtime, acp::METHOD_SESSION_CLOSE, close_params)
                        .await
                    {
                        tracing::warn!("close expired session {peri_id}: {error}");
                    }
                }
            }
            // 审查修复：应答该 session 挂起的权限请求为 Cancelled（协议要求）
            crate::permission::respond_pending_permissions_cancelled(&runtime, &peri_id).await;
            // 平台通知（用户可见重置原因）：投递给 source 归属的适配器。
            // G4 §3-9（C2）：统一入口 adapter_for_source（None 跳过——空 key 与
            // 未注册适配器同语义，替代 split(':') + adapter(key) 样板）。
            if let Some(adapter) = state.gateway.adapter_for_source(&source) {
                let _ = adapter.deliver_text(&source, &format!("[会话已重置] {reason}"));
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
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|error| PylonError::Protocol(error.to_string()))?;
    if sessions.len() >= max_sessions
        && !(allow_same_source_replace && sessions.contains_key(source))
    {
        return Err(PylonError::Protocol("max sessions reached".to_string()));
    }
    let replaced = sessions.insert(source.to_string(), session);
    drop(sessions);
    // R6：映射就绪事件化（吸收 O5）——insert 成功后通知 dispatcher（未知 periId
    // 等待由 20×5ms 轮询改为事件驱动）。new_session / load_persisted_session
    // 共用本槽位辅助，两条链路均在此通知。
    runtime.mapping_ready.notify_waiters();
    Ok(replaced)
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
    persona: &str,
    session_cwd: &str,
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
    let response = match state
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
    session.apply_session_response(&response);
    let replaced = replace_session_slot(
        runtime,
        source,
        session,
        false,
        crate::agent_runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    if close_replaced {
        if let Some(old) = replaced {
            // G2-03：D3 消费——close_via_rpc()=false 时跳过 RPC（本地清理语义不变）
            if state.protocol_for_runtime(runtime).close_via_rpc() {
                if let Ok(close_params) = acp::session_close_params(&old.peri_id) {
                    if let Err(error) = state
                        .acp_rpc(runtime, acp::METHOD_SESSION_CLOSE, close_params)
                        .await
                    {
                        tracing::warn!("close replaced session: {}", error);
                    }
                }
            }
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
    persona: &str,
    session_cwd: &str,
    wire_mcp_servers: &[serde_json::Value],
) -> Result<SessionMapping, PylonError> {
    let _creation_guard = runtime.session_creation.lock().await;
    // G2-08 锁合并：消息到达即活动（B10.3b 会话超时判定）——updated_at 刷新与
    // 存在性读取合并为 guard 内一次 sessions.lock()（每消息 7 处 sessions 锁降为
    // 6 处）。行为差异（E10 已拍板）：crashed 早退路径不再刷新 updated_at。
    let existing = {
        let mut sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get_mut(source) {
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
        persona,
        session_cwd,
        wire_mcp_servers,
        true,
    )
    .await
}

/// G2-02：load_persisted_session 失败恢复去重——锁 sessions → 复核映射
/// （(peri_id, generation) 匹配）→ 有 previous 则 insert 否则 remove。
/// 调用方不得持有 sessions 锁（E5 锁序纪律：sessions → prompt_locks 单向）。
/// 错误传播：锁错误经 String → PylonError::Protocol（与调用方原样语义一致）。
fn restore_previous_slot(
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
    source: String,
    persona: String,
    cwd: Option<String>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
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
    let session_cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    // G2-04：会话建立收敛——守卫/上限/RPC/构造/插入（notify 唯一出口）/
    // close 旧会话全部收敛进 create_session_slot（close_replaced=true，new_session 语义）。
    let mapping = create_session_slot(
        state.inner(),
        &runtime,
        &source,
        &persona,
        &session_cwd,
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
    // G2-05：PromptContext 内联构造（IPC 签名锁定；字段全部 move，零 clone）。
    let ctx = PromptContext {
        source,
        content,
        persona,
        session_prompt,
        attachments,
        mcp_servers,
        cwd: None,
    };
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
        if let Some(window) = window {
            emit_event_all(
                window,
                gateway,
                source,
                crate::event_names::SESSION_ERROR,
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
        let _ = state.remove_session_if_matches(runtime, source, peri_id, prompt_generation);
        if let Some(window) = window {
            emit_event_all(
                window,
                gateway,
                source,
                crate::event_names::SESSION_ERROR,
                serde_json::json!({"source": source, "error": error}),
            );
        }
        return Err(error.into());
    }
    if is_first {
        state.mark_first_prompt_if_matches(runtime, source, peri_id, prompt_generation)?;
    }
    if let Some(window) = window {
        emit_event_all(
            window,
            gateway,
            source,
            crate::event_names::SESSION_DONE,
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
/// "session not found" 类 RPC 错误。对 error 的 JSON 序列化串做小写化宽松子串匹配：
/// - 含 "not found"（排除 "method not found"——-32601 方法不支持，非会话缺失，
///   与 close_session 的 -32601 降级语义一致）
/// - 或含 "not exist"
/// - 或同时含 "session" 与 ("invalid" | "unknown" | "missing")
///   网络/临时错误（连接关闭/写超时/拒绝/取消等）不命中，不触发映射清理。
pub(crate) fn prompt_error_indicates_missing_session(error: &str) -> bool {
    let lower = error.to_lowercase();
    if lower.contains("method not found") {
        return false;
    }
    lower.contains("not found")
        || lower.contains("not exist")
        || (lower.contains("session")
            && (lower.contains("invalid")
                || lower.contains("unknown")
                || lower.contains("missing")))
}

/// S3：Response 错误分支的幽灵映射清理——错误含"会话不存在"语义时，按
/// (peri_id, generation) 复核删除本地映射（O1：锁表同步收敛）；下一条消息
/// 自动走会话重建路径。返回是否删除了映射。事件（pylon:error）与 pet 感知
/// 由调用方保持原顺序，本函数只负责映射收敛与日志。
pub(crate) fn cleanup_ghost_session_mapping(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    peri_id: &str,
    prompt_generation: u64,
    error: &str,
) -> bool {
    if !prompt_error_indicates_missing_session(error) {
        return false;
    }
    match state.remove_session_if_matches(runtime, source, peri_id, prompt_generation) {
        Ok(true) => {
            state.log_runtime_summary(
                "warn",
                "session",
                Some(source.to_string()),
                &format!("Agent session {peri_id} missing ({error}); removed stale mapping — next prompt will rebuild"),
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
    // 解构 ctx 业务参数（引用形态，管线内只读；session_prompt 由 prepare_prompt_blocks
    // 经 flow.ctx 直接读取，不在本函数体内消费）。
    let PromptContext {
        source,
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
        if let Some(window) = window {
            emit_event_all(
                window,
                gateway,
                source,
                crate::event_names::SESSION_ERROR,
                serde_json::json!({"source": source, "error": PylonError::AgentCrashed.to_string()}),
            );
        }
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
        let mapping = ensure_session_mapping(
            state,
            runtime,
            source,
            persona,
            &session_cwd,
            &requested_mcp_servers,
        )
        .await?;
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

    // R33a：content 构造 + persona 拼接 + B11.1 注入 + attachments 块构建。
    prepare_prompt_blocks(&mut flow).await?;

    state
        .pet
        .lock()
        .map(|mut p| crate::pet::on_user_sent(&mut p))
        .ok();
    if let Some(window) = window {
        let mut user_payload = serde_json::json!({ "source": source, "content": content });
        if !flow.inject_activated.is_empty() {
            user_payload["injectActivated"] = serde_json::Value::Array(
                flow.inject_activated
                    .iter()
                    .map(|item| serde_json::Value::String(item.clone()))
                    .collect(),
            );
        }
        emit_event(window, crate::event_names::USER_ECHO, user_payload);
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
    let result = acp::wait_prompt_with_cancel(
        &mut rx,
        Duration::from_secs(prompt_timeout_secs),
        Duration::from_secs(cancel_settle_timeout_secs),
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
            state.ensure_generation(runtime, flow.generation)?;
            if !state.session_matches(runtime, source, &flow.peri_id, flow.generation)? {
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
                        crate::event_names::SESSION_ERROR,
                        serde_json::json!({"source": source, "error": error}),
                    );
                }
                let _ = state.pet.lock().map(|mut p| crate::pet::on_error(&mut p));
                // S3：幽灵映射自动重建——agent 侧会话已不存在（重启/回收后映射滞留）
                // 时清理本地映射，下一条消息自动走会话重建路径；网络/临时错误不清理。
                cleanup_ghost_session_mapping(
                    state,
                    runtime,
                    source,
                    &flow.peri_id,
                    flow.generation,
                    &error,
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
            // A14：崩溃不删会话映射——自动重连（keep_sessions=true）会迁移
            // generation 并恢复事件路由；此处删除映射会让重连后的活跃会话
            // 丢失绑定（与 keep_sessions 语义相悖）。已知限制：若重连后
            // 事件无匹配（幽灵映射），session_matches 复核会拒绝陈旧消息。
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
                        if let Ok(close_params) = acp::session_close_params(&flow.peri_id) {
                            // G2-03：D3 消费——close_via_rpc()=false 时跳过 RPC
                            if state.protocol_for_runtime(runtime).close_via_rpc() {
                                if let Err(close_error) = state
                                    .acp_rpc(runtime, acp::METHOD_SESSION_CLOSE, close_params)
                                    .await
                                {
                                    tracing::warn!(
                                        "close unsettled prompt session {}: {}",
                                        flow.peri_id,
                                        close_error
                                    );
                                }
                            }
                        }
                    }
                    Ok(false) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            // G2-06：超时文案参数化（缺省 300 时与旧文案逐字一致——session.rs:2108
            // 负例表 "timed out after 300s" 依赖此不变量）。
            let error = format!("timed out after {prompt_timeout_secs}s");
            if let Some(window) = window {
                emit_event_all(
                    window,
                    gateway,
                    source,
                    crate::event_names::SESSION_ERROR,
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
            Err(PylonError::Protocol(error))
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
    // G2-03：D2 路由收敛——set_model_api 枚举三路（ConfigOption 默认 / SetModel /
    // Disabled）；route() 收编了 key=="model" 特判（G1 交付，agent_config.rs）。
    let target = state
        .get_active_agent()?
        .protocol()
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
    // G2-03：D3 类型化——close_via_rpc()=false（声明式配置）时跳过 RPC 直接本地
    // 清理；-32601 / "Method not found" 经 is_method_not_found() 类型化降级（不再
    // 裸字符串 contains，G1-06 交付）。
    if state.protocol_for_runtime(&runtime).close_via_rpc() {
        if let Err(error) = state
            .inner()
            .acp_rpc(
                &runtime,
                acp::METHOD_SESSION_CLOSE,
                acp::session_close_params(&peri_id)?,
            )
            .await
        {
            if error.is_method_not_found() {
                tracing::warn!(
                    "agent does not support session/close ({error}); local cleanup only"
                );
            } else {
                return Err(error.into());
            }
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
    // 与 new_session / send_message 自动创建一致，恢复历史会话也受上限约束；
    // 同 source 重载（替换）不占新名额（R32：检查与插入统一在槽位辅助内）。
    let previous = replace_session_slot(
        &runtime,
        &source,
        SessionInfo::new(
            peri_id.clone(),
            String::new(),
            cwd.clone(),
            true,
            generation,
        ),
        true,
        crate::agent_runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    // O3：锁内仅提取回放句柄，等待在锁外进行——回放最长 30s，不阻塞其他命令。
    let handles = runtime.acp.lock().await.replay_handles();
    let load_result = crate::acp::load_session_with_replay(
        handles,
        &peri_id,
        &cwd,
        mcp_servers,
        state.protocol_for_runtime(&runtime).mcp_servers,
    )
    .await;
    match load_result {
        Ok((response, _replay)) => {
            if let Err(error) = state.ensure_generation(&runtime, generation) {
                restore_previous_slot(&runtime, &source, &peri_id, generation, previous)?;
                return Err(error.into());
            }
            state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
                session.apply_session_response(&response);
            })?;
            Ok(response)
        }
        Err(error) => {
            restore_previous_slot(&runtime, &source, &peri_id, generation, previous)?;
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

    /// 测试桩适配器（G4 §3-9 适配）：platform_key="qq"——注册后 is_platform_source
    /// 对 qq:* 前缀命中（C3/C4 拒绝语义依赖注册态；E14 放行语义依赖未注册态）。
    struct QqFakeAdapter;

    impl crate::gateway::PlatformAdapter for QqFakeAdapter {
        fn platform_key(&self) -> &str {
            "qq"
        }
        fn max_message_len(&self) -> usize {
            4000
        }
        fn deliver_text(&self, _source: &str, _text: &str) -> Result<(), String> {
            Ok(())
        }
        fn deliver_event(
            &self,
            _source: &str,
            _event: &str,
            _payload: &serde_json::Value,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    /// A10：无 active agent 的裸状态（active_agent 指向不存在的 runtime）。
    /// E-9（G5-3 遗留）：字面量收敛为 TestStateBuilder::bare()——默认值逐字段 =
    /// run() 现值（active_agent="ghost-agent" 等，E18 纪律见 test_utils.rs doc）。
    fn state_without_active_runtime() -> AppState {
        crate::test_utils::TestStateBuilder::bare().build()
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
    /// G4 §3-9（C4）适配：判定改走 is_platform_source（注册适配器前缀 OR 绑定命中）——
    /// 测试注册 FakeAdapter("qq") 保持拒绝语义；E14 安全等价（无适配器注册时放行）
    /// 由本测试第三段单独钉住。
    #[tokio::test]
    async fn send_prompt_core_rejects_unbound_qq_gui_source() {
        let state = state_without_active_runtime();
        let runtime = AgentRuntime::new_disconnected();
        // gateway 只绑定 qq:group:123；qq:group:999 无 binding（GUI 冒名）。
        // C4 后需"注册适配器 OR 绑定"命中才判定平台源——注册 FakeAdapter("qq")。
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
        gateway
            .register(Arc::new(QqFakeAdapter))
            .expect("register fake qq adapter");
        let error = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &gateway,
            &PromptContext {
                source: "qq:group:999".to_string(),
                content: "你好".to_string(),
                ..Default::default()
            },
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
            &PromptContext {
                source: "qq:group:123".to_string(),
                content: "你好".to_string(),
                ..Default::default()
            },
        )
        .await
        .expect_err("绑定命中应放行 source 校验，继续管线直到连接层失败");
        assert!(
            !bound_error.to_string().contains("invalid GUI source"),
            "绑定命中的 qq:* source 不得被 source 校验拒绝，实际: {bound_error}"
        );
        // E14 语义钉住：无适配器注册 + 无 binding 的 qq:* GUI source 放行入口校验
        // （安全等价：无注册适配器 = 无 deliver_all 投递路径，gateway/mod.rs doc）。
        let bare_gateway = GatewayCore::from_config(
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
        let pass_error = send_prompt_core::<tauri::test::MockRuntime>(
            &state,
            &runtime,
            None,
            &bare_gateway,
            &PromptContext {
                source: "qq:group:999".to_string(),
                content: "你好".to_string(),
                ..Default::default()
            },
        )
        .await
        .expect_err("无适配器注册时 qq:* 应放行入口校验，继续管线直到连接层失败");
        assert!(
            !pass_error.to_string().contains("invalid GUI source"),
            "无适配器注册的 qq:* source 不得被入口校验拒绝（E14），实际: {pass_error}"
        );
    }

    /// P1（E10）：缓存未初始化（None，启动恢复路径形态）→ 回退全量重算
    /// （校验 + 序列化）并回填；行为与现状 validate_and_serialize(current_mcp_servers)
    /// 逐字一致（E3 自愈：首次读取即回填）。
    #[test]
    fn mcp_wire_cache_uninitialized_falls_back_and_backfills() {
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let values = state.wire_mcp_servers().expect("miss 回退必须成功");
        assert!(values.is_empty(), "空配置 → 空 wire 数组（现状语义）");
        assert_eq!(
            state.mcp_wire.lock().unwrap().as_ref().map(Vec::len),
            Some(0),
            "miss 后必须回填缓存"
        );
    }

    /// P1（E10）：缓存命中直接返回 wire 形态（零重算零校验）——runtime_mcp 即使
    /// 被置入非法数据（超限 server）也不触发校验，证明读路径短路。
    #[test]
    fn mcp_wire_cache_hit_short_circuits_recompute() {
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let cached = vec![serde_json::json!({"name": "cached-mcp"})];
        *state.mcp_wire.lock().unwrap() = Some(cached.clone());
        // 非法 runtime_mcp：33 个 server（> MAX_SERVERS=32，validate 必失败）
        let mut bad = Vec::new();
        for i in 0..(crate::mcp::MAX_SERVERS + 1) {
            bad.push(crate::mcp::McpServerConfig {
                id: Some(format!("s{i}")),
                name: None,
                transport: "stdio".into(),
                enabled: true,
                command: Some("cmd".into()),
                args: Vec::new(),
                env: HashMap::new(),
                url: None,
                headers: HashMap::new(),
                oauth: None,
                disabled: false,
            });
        }
        *state.runtime_mcp.lock().unwrap() = Some(bad);
        let values = state.wire_mcp_servers().expect("缓存命中不得触发校验");
        assert_eq!(values, cached, "命中必须返回缓存 wire 形态");
    }

    /// E-11：附件限制按 runtime 归属 agent 协议配置解析（非 active agent）——
    /// active agent 上限 1、runtime 归属 agent 上限 8 时，3 个附件必须放行
    /// （若仍按 active agent 解析会报 too many attachments: maximum is 1）。
    #[tokio::test]
    async fn attachment_limits_follow_runtime_agent_not_active_agent() {
        const FAKE_SCRIPT: &str = r#"import json,sys
for line in sys.stdin:
    request = json.loads(line)
    response = {'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    method = request.get('method')
    if method == 'session/new':
        response['result'] = {'sessionId':'e11-session'}
    elif method == 'session/prompt':
        response['result'] = {'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
"#;
        // active agent：max_attachments=1（若按 active agent 解析，3 附件必拒）
        let mut active_def = crate::test_utils::fake_acp_agent("active-a", FAKE_SCRIPT);
        active_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            max_attachments: Some(1),
            ..Default::default()
        });
        // runtime 归属 agent：max_attachments=8
        let mut runtime_def = crate::test_utils::fake_acp_agent("runtime-b", FAKE_SCRIPT);
        runtime_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            max_attachments: Some(8),
            ..Default::default()
        });
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = crate::acp::AcpClient::connect_with_logs(&runtime_def, None)
            .await
            .expect("fake ACP must initialize");
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("active-a")
            .with_agent(active_def)
            .with_agent(runtime_def)
            .with_runtime("runtime-b", runtime.clone())
            .build();
        let gateway = Arc::new(GatewayCore::new());
        // 3 个真实临时附件文件（prompt_blocks 校验 metadata）
        let dir = std::env::temp_dir().join(format!("pylon-e11-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let attachments: Vec<String> = (0..3)
            .map(|i| {
                let path = dir.join(format!("att-{i}.txt"));
                std::fs::write(&path, b"x").unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect();
        let ctx = PromptContext {
            source: "gui-e11".to_string(),
            content: "你好".to_string(),
            persona: String::new(),
            session_prompt: None,
            attachments: Some(attachments),
            mcp_servers: None,
            cwd: None,
        };
        let result =
            send_prompt_core::<tauri::test::MockRuntime>(&state, &runtime, None, &gateway, &ctx)
                .await;
        std::fs::remove_dir_all(&dir).ok();
        result
            .expect("3 附件必须按 runtime 归属 agent 的 8 上限放行（active agent 上限 1 被忽略）");
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

    /// O1：会话映射删除时 prompt 锁表条目必须同步收敛（映射删除 = 生命周期结束，
    /// 锁表不得无界增长）；映射不匹配时不删除也不清理。
    #[tokio::test]
    async fn remove_session_if_matches_drops_prompt_lock_entry() {
        let runtime = AgentRuntime::new_disconnected();
        let state = state_without_active_runtime();
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "source-a".to_string(),
                SessionInfo::new("peri-1".into(), String::new(), ".".into(), false, 1),
            );
        }
        prompt_lock_for(&runtime.prompt_locks, "source-a");
        assert_eq!(runtime.prompt_locks.lock().unwrap().len(), 1);
        let removed = state
            .remove_session_if_matches(&runtime, "source-a", "peri-1", 1)
            .unwrap();
        assert!(removed, "匹配映射必须被删除");
        assert!(
            runtime.prompt_locks.lock().unwrap().is_empty(),
            "锁表条目必须随映射删除收敛"
        );
        // 不匹配（peri_id 已更换）：不删除映射，也不清理锁表（新会话仍在使用）。
        prompt_lock_for(&runtime.prompt_locks, "source-b");
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "source-b".to_string(),
                SessionInfo::new("peri-2".into(), String::new(), ".".into(), false, 1),
            );
        }
        let removed = state
            .remove_session_if_matches(&runtime, "source-b", "peri-other", 1)
            .unwrap();
        assert!(!removed, "不匹配映射不得删除");
        assert_eq!(
            runtime.prompt_locks.lock().unwrap().len(),
            1,
            "映射未删除时锁表条目保留（生成中豁免仍依赖该条目）"
        );
    }

    /// G2-02：restore_previous_slot 失败恢复语义——映射匹配时恢复 previous 槽位
    /// （有 previous 则 insert 否则 remove）；映射不匹配（已被新会话接管）不动。
    #[tokio::test]
    async fn restore_previous_slot_restores_or_removes_on_match() {
        let runtime = AgentRuntime::new_disconnected();
        let insert = |runtime: &Arc<AgentRuntime>| {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "source-a".to_string(),
                SessionInfo::new("peri-1".into(), String::new(), ".".into(), false, 1),
            );
        };
        // 映射匹配 + previous → 恢复 previous 槽位（回滚到旧会话）
        insert(&runtime);
        let previous = SessionInfo::new("old-peri".into(), String::new(), "/old".into(), true, 1);
        restore_previous_slot(&runtime, "source-a", "peri-1", 1, Some(previous.clone()))
            .expect("restore must succeed");
        let sessions = runtime.sessions.lock().unwrap();
        assert_eq!(
            sessions.get("source-a").map(|s| s.peri_id.as_str()),
            Some("old-peri"),
            "previous 槽位必须恢复"
        );
        assert_eq!(
            sessions.get("source-a").map(|s| s.cwd.as_str()),
            Some("/old"),
            "previous 会话内容必须完整恢复"
        );
        drop(sessions);
        // 映射匹配 + 无 previous → remove（新建的临时槽位回滚删除）
        restore_previous_slot(&runtime, "source-a", "old-peri", 1, None)
            .expect("remove must succeed");
        assert!(
            runtime.sessions.lock().unwrap().is_empty(),
            "无 previous 时必须 remove 临时槽位"
        );
        // 映射不匹配（peri_id 已被新会话替换）→ 不恢复也不删除
        insert(&runtime);
        restore_previous_slot(&runtime, "source-a", "peri-dead", 1, Some(previous))
            .expect("mismatch must be a no-op");
        let sessions = runtime.sessions.lock().unwrap();
        assert_eq!(sessions.len(), 1, "不匹配时不得改动映射");
        assert_eq!(
            sessions.get("source-a").map(|s| s.peri_id.as_str()),
            Some("peri-1"),
            "不匹配时新映射必须原样保留"
        );
    }

    /// S3：prompt 错误"会话不存在"语义匹配——宽松子串匹配覆盖 agent 实际错误形态
    /// （JSON-RPC 错误对象序列化串 / 纯字符串），网络与临时/方法级错误不命中。
    #[test]
    fn prompt_error_indicates_missing_session_matching() {
        let missing = [
            "session not found: session-42",
            "Session not found",
            r#"{"code":-32602,"message":"session not found: session-42"}"#,
            "unknown session: session-42",
            r#"{"code":-32602,"message":"Invalid params: unknown session: session-42"}"#,
            "invalid session: session-42",
            "session does not exist",
            r#"{"code":-32000,"message":"session missing"}"#,
            "missing sessionId",
        ];
        for error in missing {
            assert!(
                prompt_error_indicates_missing_session(error),
                "必须命中会话不存在语义: {error}"
            );
        }
        let transient = [
            "connection closed",
            "ACP connection closed",
            "write timeout: connection presumed dead",
            "prompt cancelled",
            "prompt refused by agent",
            "timed out after 300s",
            "method not found",
            r#"{"code":-32601,"message":"Method not found"}"#,
            r#"{"code":-32602,"message":"invalid params: missing content"}"#,
            "rate limited",
            "internal error",
        ];
        for error in transient {
            assert!(
                !prompt_error_indicates_missing_session(error),
                "不得误伤网络/临时/方法级错误: {error}"
            );
        }
    }

    /// S3：幽灵映射自动重建——"会话不存在"语义的 prompt 错误清理本地映射（下次
    /// send 自动重建会话）；网络/临时错误与不匹配映射（已被新会话替换）不清理。
    #[tokio::test]
    async fn ghost_session_mapping_is_removed_on_missing_session_error() {
        let runtime = AgentRuntime::new_disconnected();
        let state = state_without_active_runtime();
        let insert = |runtime: &Arc<AgentRuntime>| {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "source-a".to_string(),
                SessionInfo::new("peri-1".into(), String::new(), ".".into(), false, 1),
            );
        };
        // "会话不存在"语义：清理映射（返回 true），且 O1 锁表同步收敛。
        insert(&runtime);
        prompt_lock_for(&runtime.prompt_locks, "source-a");
        let removed = cleanup_ghost_session_mapping(
            &state,
            &runtime,
            "source-a",
            "peri-1",
            1,
            r#"{"code":-32602,"message":"session not found: peri-1"}"#,
        );
        assert!(removed, "会话不存在错误必须清理幽灵映射");
        assert!(
            runtime.sessions.lock().unwrap().is_empty(),
            "幽灵映射必须被删除"
        );
        assert!(
            runtime.prompt_locks.lock().unwrap().is_empty(),
            "O1：锁表条目必须随映射删除收敛"
        );
        // 网络/临时错误：不清理映射。
        insert(&runtime);
        let removed = cleanup_ghost_session_mapping(
            &state,
            &runtime,
            "source-a",
            "peri-1",
            1,
            "write timeout: connection presumed dead",
        );
        assert!(!removed, "临时错误不得清理映射");
        assert_eq!(runtime.sessions.lock().unwrap().len(), 1);
        // 映射不匹配（peri_id 已被新会话替换）：错误含会话不存在语义也不得误删新映射。
        let removed = cleanup_ghost_session_mapping(
            &state,
            &runtime,
            "source-a",
            "peri-dead",
            1,
            "session not found: peri-dead",
        );
        assert!(!removed, "peri_id 不匹配不得误删新会话映射");
        assert_eq!(runtime.sessions.lock().unwrap().len(), 1);
    }
}
