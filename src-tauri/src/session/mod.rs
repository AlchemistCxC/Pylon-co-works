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

// 方案 11：模型层（SessionInfo/DTO/config option 纯函数）搬移至子模块。
mod model;
pub(crate) use model::*;
// 方案 11：inspector/会话清单域搬移至子模块。
mod inspector;
pub(crate) use inspector::*;
// 方案 11：会话创建域搬移至子模块。
mod create;
pub(crate) use create::*;
// 方案 11：prompt 域搬移至子模块。
mod prompt;
pub(crate) use prompt::*;

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
/// 生产路径已委托 SessionStore::migrate_or_clear；本纯函数保留供测试锁定语义。
#[cfg(test)]
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

    /// 方案 5：generation-bound 控制 RPC——锁内 prepare 前断言 generation，
    /// stale（客户端已替换）时**不发送**直接返回错误。防止旧 periId 的
    /// session/close、session/cancel 等控制请求写入新 ACP（发送后复核只能
    /// "检测到"竞态，不能"隔离"竞态）。调用方在发送后仍需 ensure_generation
    /// 复核本地状态修改。正常路径（generation 匹配）行为与 acp_rpc 一致。
    pub(crate) async fn acp_rpc_generation_checked(
        &self,
        runtime: &AgentRuntime,
        method: &str,
        params: serde_json::Value,
        expected_generation: u64,
    ) -> Result<serde_json::Value, crate::acp::AcpError> {
        let rpc = {
            let acp = runtime.acp.lock().await;
            if self.current_generation(runtime) != expected_generation {
                return Err(crate::acp::AcpError::Rpc(format!(
                    "stale ACP client generation: expected {expected_generation}"
                )));
            }
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
        // 方案 8：委托 SessionStore（(peri_id, generation) 匹配 + 锁序纪律）。
        crate::session_store::update_if_current(runtime, source, peri_id, generation, update)
            .map_err(|e| e.to_string())
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
        // 方案 8：委托 SessionStore（匹配删除 + 锁外 prompt 锁收敛）。
        crate::session_store::remove_if_current(runtime, source, peri_id, generation)
            .map_err(|e| e.to_string())
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
            // generation 提到循环体（close_session_rpc 复用；块内删除复核同值）。
            let generation = runtime.client_generation.load(Ordering::Acquire);
            let removed = {
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
            // 方案 6：统一 close RPC 入口（LocalFirstBestEffort，吞错误）。
            let _ = close_session_rpc(&state, &runtime, &peri_id, generation, false).await;
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
    use tauri::Manager;

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

    /// 方案 6：close_session_rpc 统一入口矩阵——close_via_rpc=false 不发 RPC、
    /// method-not-found 降级不报错、普通 RPC 错误按 strict 决定上抛/吞掉。
    #[tokio::test]
    async fn close_session_rpc_respects_policy_and_method_not_found() {
        const FAKE_SCRIPT: &str = r#"import json,sys
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'session/close':
        response = {'jsonrpc':'2.0','id':request.get('id'),'error':{'code':-32601,'message':'Method not found'}}
    else:
        response = {'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("p6-agent", FAKE_SCRIPT);
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        // close_via_rpc=false：跳过 RPC，返回 Ok(false)
        let mut no_rpc_def = agent.clone();
        no_rpc_def.name = "p6-no-rpc".to_string();
        no_rpc_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            session_close: Some(false),
            ..Default::default()
        });
        let no_rpc_runtime = AgentRuntime::new_disconnected();
        *no_rpc_runtime.acp.lock().await =
            crate::acp::AcpClient::connect_with_logs(&no_rpc_def, None)
                .await
                .expect("fake ACP must initialize");
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("p6-agent")
            .with_agent(agent)
            .with_agent(no_rpc_def)
            .with_runtime("p6-agent", runtime.clone())
            .with_runtime("p6-no-rpc", no_rpc_runtime.clone())
            .build();
        // method-not-found：降级 Ok(true)，不报错（RemoteFirst 与 best-effort 同）。
        let attempted = close_session_rpc(&state, &runtime, "peri-1", 0, true)
            .await
            .expect("-32601 必须降级而非报错");
        assert!(attempted, "close_via_rpc=true 必须尝试 RPC");
        // close_via_rpc=false：跳过 RPC 仅本地清理。
        let attempted = close_session_rpc(&state, &no_rpc_runtime, "peri-1", 0, true)
            .await
            .expect("close_via_rpc=false 必须 Ok");
        assert!(!attempted, "close_via_rpc=false 不得尝试 RPC");
    }

    /// 方案 5：acp_rpc_generation_checked 在 generation 不匹配（客户端已替换）
    /// 时锁内拦截，不发送——旧 periId 的控制请求不进入新 ACP。
    #[tokio::test]
    async fn generation_checked_rpc_blocks_stale_control_request() {
        const FAKE_SCRIPT: &str = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request = json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let trace_path = std::env::temp_dir()
            .join(format!("pylon-p5-{}.jsonl", std::process::id()));
        let agent = crate::test_utils::fake_acp_agent_with(
            "p5-agent",
            FAKE_SCRIPT,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("p5-agent")
            .with_agent(agent)
            .with_runtime("p5-agent", runtime.clone())
            .build();
        // 模拟客户端替换：generation 前进（旧 periId 的控制请求必须被拦截）。
        runtime.client_generation.fetch_add(1, Ordering::AcqRel);
        let result = state
            .acp_rpc_generation_checked(
                &runtime,
                acp::METHOD_SESSION_CLOSE,
                acp::session_close_params("old-peri").expect("params"),
                0,
            )
            .await;
        assert!(
            result.is_err(),
            "generation 不匹配时必须拒绝（不发送）"
        );
        // 短暂等待 writer 排空，确认 trace 无 session/close。
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        assert!(
            !trace.contains("session/close"),
            "stale 控制请求不得发送到 ACP: {trace}"
        );
    }

    /// 方案 4：set_config_option 的 RPC 路由必须按 target runtime 归属 agent 的
    /// protocol（protocol_for_runtime）决定，而非 get_active_agent() 的协议——
    /// 修复前按 active agent 读取，在 agents 表与 runtimes 注册不同步/多 runtime
    /// 场景会错发 RPC。此处验证：runtime 归属 agent 声明 ConfigOption 时走
    /// session/set_config_option，绝不走 session/set_model。
    #[tokio::test]
    async fn set_config_option_uses_runtime_agent_protocol_not_active_agent() {
        const FAKE_SCRIPT: &str = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request = json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    method = request.get('method')
    if method == 'session/new':
        response = {'jsonrpc':'2.0','id':request.get('id'),'result':{'sessionId':'p4-session'}}
    elif method == 'session/set_config_option':
        response = {'jsonrpc':'2.0','id':request.get('id'),'result':{'configOptions':[{'key':'model','value':'gpt-4'}]}}
    else:
        response = {'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    print(json.dumps(response), flush=True)
"#;
        let trace_path = std::env::temp_dir()
            .join(format!("pylon-p4-{}.jsonl", std::process::id()));
        // active agent A：set_model_api = SetModel（若误用其协议 → 走 session/set_model）
        let mut active_def =
            crate::test_utils::fake_acp_agent_with("active-a", FAKE_SCRIPT, vec![], HashMap::new());
        active_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            set_model_api: Some(crate::agent_config::SetModelApi::SetModel),
            ..Default::default()
        });
        // runtime 归属 agent B：set_model_api = ConfigOption（正确应走 set_config_option）
        let mut runtime_def = crate::test_utils::fake_acp_agent_with(
            "runtime-b",
            FAKE_SCRIPT,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        runtime_def.acp = Some(crate::agent_config::AcpProtocolConfig {
            set_model_api: Some(crate::agent_config::SetModelApi::ConfigOption),
            ..Default::default()
        });
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = crate::acp::AcpClient::connect_with_logs(&runtime_def, None)
            .await
            .expect("fake ACP must initialize");
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("runtime-b")
            .with_agent(active_def)
            .with_agent(runtime_def)
            .with_runtime("runtime-b", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let state = app.state::<AppState>();
        // 预置会话映射（set_config_option 经 get_peri_id 查表；绕过 session/new
        // command 的完整注册流程，聚焦本测试的协议路由断言）。
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            sessions.insert(
                "p4-session".to_string(),
                SessionInfo::new("p4-peri".to_string(), String::new(), ".".to_string(), false, 0),
            );
        }
        let result = set_config_option(
            state,
            "p4-session".to_string(),
            "model".to_string(),
            "gpt-4".to_string(),
        )
        .await
        .expect("set_config_option 必须成功");
        assert_eq!(
            result["configOptions"][0]["value"], "gpt-4",
            "响应应含 configOptions"
        );
        // 回读 trace：必须出现 session/set_config_option，不得出现 session/set_model
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let methods: Vec<String> = trace
            .lines()
            .map(|line| {
                let value: serde_json::Value = serde_json::from_str(line).unwrap();
                value
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        assert!(
            methods.iter().any(|m| m == "session/set_config_option"),
            "必须按 runtime 归属 agent 走 set_config_option: {methods:?}"
        );
        assert!(
            !methods.iter().any(|m| m == "session/set_model"),
            "不得按 active agent 走 set_model: {methods:?}"
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
