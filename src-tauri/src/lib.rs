mod acp;
mod agent_config;
mod agent_runtime;
#[cfg(test)]
mod auto_reconnect_integration_tests;
#[cfg(test)]
mod b10_gateway_integration_tests;
#[cfg(test)]
mod b11_inject_integration_tests;
mod dispatcher;
mod error;
mod event_names;
mod export;
mod gateway;
mod gateway_cmds;
mod git;
mod lifecycle;
mod logs_cmds;
mod mcp;
#[cfg(test)]
mod mcp_persist_tests;
mod permission;
mod pet;
mod pet_cmds;
mod prism;
mod prism_cmds;
mod runtime;
mod runtime_log;
#[cfg(test)]
mod real_acp_smoke;
mod sanitize;
mod session;
mod startup;
#[cfg(test)]
mod session_expiry_platform_tests;
#[cfg(test)]
mod session_info_tests;
#[cfg(test)]
mod test_utils;
mod time;
mod workspace;
mod workspace_cmds;

use acp::AcpClient;
use agent_config::AgentDef;
use agent_runtime::AgentLifecycleStatus;
use gateway::GatewayCore;
use prism::PrismClient;
use runtime::{AgentRuntime, AgentRuntimeManager};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime};

#[cfg(test)]
use crate::time::Timestamp;

#[cfg(test)]
use agent_runtime::AgentRuntimeState;
#[cfg(test)]
use session::SessionInfo;

// R1 拆分：子模块函数桥接。生产代码（setup/watcher/replace）裸引用；
// 测试模块经 `use super::*` 引入命令/工具函数（R5a：清理 R1 遗留的冗余
// cfg(test) 显式导入——测试模块实际引用集中在下列被保留的名字上）。
use crate::dispatcher::start_notification_dispatcher;
use crate::lifecycle::{load_mcp_persisted, mcp_persist_path};
use crate::permission::check_pending_permission_timeouts;
use crate::pet_cmds::{persist_pet_if_possible, pet_persist_path};
use crate::session::{apply_client_replacement_sessions, check_session_expiry, send_prompt_core};

#[cfg(test)]
use crate::export::{is_export_sensitive_key, sanitize_export_messages, write_export_atomically};
#[cfg(test)]
use crate::lifecycle::{do_connect_and_replace, set_mcp_servers};
#[cfg(test)]
use crate::permission::{
    parse_permission_request, permission_response, permission_response_cancelled,
    resolve_permission,
};
#[cfg(test)]
use crate::session::{
    build_full_inspector_payload, compose_inject_prompt, config_option_current_value,
    extract_tool_file_name, inject_applies_to, send_message, session_expired,
};

fn emit_event<R, W>(window: &W, event: &str, payload: serde_json::Value)
where
    R: Runtime,
    W: Emitter<R>,
{
    if let Err(error) = window.emit(event, payload) {
        tracing::warn!("emit {event} failed: {error}");
    }
}

/// 事件广播（B10.1）：WebView 始终接收；平台 source 同时经 gateway 投递平台适配器。
/// pylon:user 回显/agent-status/runtime-log 不投平台（仅 update/done/error）。
pub(crate) fn emit_event_all<R, W>(
    window: &W,
    gateway: &GatewayCore,
    source: &str,
    event: &str,
    payload: serde_json::Value,
) where
    R: Runtime,
    W: Emitter<R>,
{
    emit_event(window, event, payload.clone());
    gateway.deliver_all(source, event, &payload);
}

/// AppState：全局状态 = 全局配置 + per-agent 隔离运行时（B7a-2）+ gateway（B10.1）。
/// per-agent 字段（acp/notification_task/session_creation/agent_lifecycle/
/// client_generation/prompt_locks/sessions/agent_runtime/auto_reconnect_active）
/// 全部收进 AgentRuntimeManager（runtime.rs），命令层按 active_agent 解析 runtime。
/// R1 拆分：字段 pub(crate) 供子模块（session/dispatcher/lifecycle 等）访问。
pub(crate) struct AppState {
    pub(crate) runtimes: Arc<AgentRuntimeManager>,
    pub(crate) agents: Arc<Mutex<HashMap<String, AgentDef>>>,
    pub(crate) active_agent: Arc<Mutex<String>>,
    pub(crate) pet: Arc<Mutex<pet::PetState>>,
    pub(crate) runtime_logs: Arc<runtime_log::RuntimeLogHub>,
    pub(crate) runtime_mcp: Mutex<Option<Vec<mcp::McpServerConfig>>>,
    pub(crate) prism: PrismClient,
    pub(crate) gateway: Arc<GatewayCore>,
    /// R5（P1-3）：启动诊断快照（只读，run() 构建一次）。
    pub(crate) startup: Arc<crate::startup::StartupDiagnostics>,
    /// 权限审批模式（B9.3）：bypass/auto 自动批准；edit/default 挂起询问。
    pub(crate) approval_mode: Arc<Mutex<String>>,
    /// R6a：宠物落盘写序锁（tokio Mutex）——序列化在临界区内执行，保证
    /// 后写状态 ≥ 先写状态（无乱序覆盖）；fs 写经 spawn_blocking 移出 async 运行时。
    pub(crate) pet_write_lock: tokio::sync::Mutex<()>,
    /// C7：switch/reconnect 串行锁——并发 switch 不交叉杀进程（一个 switch
    /// 未完成前另一个 switch 不得 kill 同一批旧进程）。
    pub(crate) switch_lock: tokio::sync::Mutex<()>,
    /// C8：MCP 写序锁（tokio Mutex）——set_mcp_servers 写 runtime_mcp + 落盘
    /// 全程持锁，并发设置时磁盘必为最后一次设置（重启不回滚到旧配置）。
    pub(crate) mcp_write_lock: tokio::sync::Mutex<()>,
    /// P1（E10）：MCP wire 序列化缓存（Vec<Value>，session/new 的 mcpServers 载荷）。
    /// 每消息省一次全量 validate+serialize（≤32 server × 字段校验 + 一次 clone）。
    /// 写入 = set_mcp_servers 与 runtime_mcp 同 mcp_write_lock 下同步；读取
    /// （send_prompt_core None 路径）miss 时回退全量重算并回填（E3 自愈：启动
    /// 恢复路径直写 runtime_mcp 不经 set_mcp_servers，缓存为 None，首次读取即回填）。
    pub(crate) mcp_wire: Mutex<Option<Vec<serde_json::Value>>>,
    /// R8（P2-3）：前端日志限流窗口（每秒上限，超限丢弃）。
    pub(crate) frontend_log_throttle: Mutex<runtime_log::FrontendLogThrottle>,
}

/// 供 async 闭包/静态辅助持有的 AppState 字段子集。
/// Tauri manage 的 state 不能 move 进闭包，只能 clone 字段；
/// start_notification_dispatcher / do_connect_and_replace / 自动重连共用。
/// per-agent 状态经 [`Self::active_runtime`] / 参数传入的 runtime 访问。
/// R1 拆分：字段 pub(crate)（dispatcher/lifecycle 子模块访问）。
pub(crate) struct AppStateHandles {
    pub(crate) runtimes: Arc<AgentRuntimeManager>,
    pub(crate) agents: Arc<Mutex<HashMap<String, AgentDef>>>,
    pub(crate) active_agent: Arc<Mutex<String>>,
    pub(crate) pet: Arc<Mutex<pet::PetState>>,
    pub(crate) runtime_logs: Arc<runtime_log::RuntimeLogHub>,
    pub(crate) gateway: Arc<GatewayCore>,
    pub(crate) approval_mode: Arc<Mutex<String>>,
}

/// acp 已死判定（P2-3 语义：try_lock 失败视为未崩溃，读路径不等待）。
/// 收敛 detect_and_record_crashes 与 agent_status_payload 的双写点（G3 §2.2.4）。
fn acp_is_crashed(runtime: Option<&AgentRuntime>) -> bool {
    runtime
        .map(|runtime| {
            runtime
                .acp
                .try_lock()
                .ok()
                .map(|acp| acp.is_crashed())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// P3-12 后处理（纯函数）：只在 payload 未报告崩溃时覆盖——payload 内
/// status/crashed 必须一致；lastError/recentError/error 三别名同步覆写。
/// 逻辑保留自 emit_agent_status（行为契约：announce 的状态/错误必定上事件）。
fn apply_announce_override(
    payload: &mut serde_json::Value,
    status: AgentLifecycleStatus,
    last_error: Option<String>,
) {
    if let serde_json::Value::Object(ref mut map) = payload {
        let payload_crashed = map.get("status").and_then(|value| value.as_str())
            == Some(AgentLifecycleStatus::Crashed.as_str());
        if !payload_crashed {
            map.insert(
                "status".to_string(),
                serde_json::Value::String(status.as_str().to_string()),
            );
            if let Some(error) = last_error {
                let error = serde_json::Value::String(error);
                map.insert("lastError".to_string(), error.clone());
                map.insert("recentError".to_string(), error.clone());
                map.insert("error".to_string(), error);
            }
        }
    }
}

impl AppStateHandles {
    fn from_state(state: &AppState) -> Self {
        Self {
            runtimes: state.runtimes.clone(),
            agents: state.agents.clone(),
            active_agent: state.active_agent.clone(),
            pet: state.pet.clone(),
            runtime_logs: state.runtime_logs.clone(),
            gateway: state.gateway.clone(),
            approval_mode: state.approval_mode.clone(),
        }
    }

    /// 当前 active agent 的 runtime（无 active agent 时返回 None）。
    fn active_runtime(&self) -> Option<Arc<AgentRuntime>> {
        let id = self.active_agent.lock().ok()?.clone();
        self.runtimes.get(&id)
    }

    fn log_runtime_summary(
        &self,
        level: &str,
        source: &str,
        session: Option<String>,
        message: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) {
        self.runtime_logs.push(
            crate::time::Timestamp::now(),
            level,
            source,
            session,
            message,
            fields,
        );
    }

    fn set_agent_runtime_status(
        &self,
        runtime: &AgentRuntime,
        status: AgentLifecycleStatus,
        last_error: Option<String>,
    ) {
        if let Ok(mut runtime) = runtime.agent_runtime.lock() {
            runtime.status = status;
            runtime.last_error = last_error;
            if status == AgentLifecycleStatus::Connected {
                runtime.last_connected_at = Some(crate::time::Timestamp::now());
            }
        }
    }

    /// 崩溃检测 + 记录（P2-3）：只做"acp 已死 → status=Crashed + 注入 last_error"的
    /// 记录性写入，必须在纯查询路径（agent_status_payload）之外显式调用——
    /// getter 不再有副作用。try_lock 失败（acp 锁正被占用）视为未崩溃（读路径不等待）。
    fn detect_and_record_crashes(runtime: Option<&AgentRuntime>) {
        let Some(runtime) = runtime else { return };
        if acp_is_crashed(Some(runtime)) {
            if let Ok(mut state) = runtime.agent_runtime.lock() {
                state.status = AgentLifecycleStatus::Crashed;
                if state.last_error.is_none() {
                    state.last_error = Some("ACP child process stdout closed".to_string());
                }
            }
        }
    }

    fn agent_status_payload(&self, runtime: Option<&AgentRuntime>) -> serde_json::Value {
        let (status, last_error, last_connected_at) = runtime
            .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.clone()))
            .map(|state| (state.status, state.last_error, state.last_connected_at))
            .unwrap_or((AgentLifecycleStatus::Disconnected, None, None));
        let active_agent_id = self
            .active_agent
            .lock()
            .ok()
            .map(|value| value.clone())
            .unwrap_or_default();
        let agent = self
            .agents
            .lock()
            .ok()
            .and_then(|agents| agents.get(&active_agent_id).cloned());
        let crashed = matches!(status, AgentLifecycleStatus::Crashed) || acp_is_crashed(runtime);
        let status = if crashed {
            AgentLifecycleStatus::Crashed
        } else {
            status
        };
        let available = agent.is_some() && status == AgentLifecycleStatus::Connected;
        let generation = runtime
            .map(|runtime| runtime.client_generation.load(Ordering::Acquire))
            .unwrap_or(0);
        // P1（能力协商暴露）：agentCapabilities 原始 Value（try_lock 同步读 acp——
        // 与 acp_is_crashed 同模式；断开/未连接为 null）。前端能力驱动 UI 读此字段。
        let capabilities = runtime
            .and_then(|runtime| runtime.acp.try_lock().ok())
            .and_then(|acp| acp.agent_capabilities().cloned());
        // O2：三个别名（lastError/recentError/error）共用同一份引用（as_deref），
        // json! 序列化时各自转 Value——消除 3 次显式 clone（last_error 是
        // agent_runtime 锁内 state.clone() 的产物，自身 clone 是必须的）。
        let last_error_ref = last_error.as_deref();
        serde_json::json!({
            "agentId": active_agent_id,
            "agentName": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
            "agent": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
            "status": status.as_str(),
            "transport": agent.as_ref().map(|value| value.transport.clone()).unwrap_or_default(),
            "cwd": agent.as_ref().and_then(|value| value.cwd.clone()).unwrap_or_default(),
            "lastError": last_error_ref,
            "recentError": last_error_ref,
            "error": last_error_ref,
            "lastConnectedAt": last_connected_at,
            "generation": generation,
            "capabilities": capabilities,
            "active": agent.is_some(),
            "available": available,
            "crashed": crashed,
        })
    }

    fn emit_agent_status<R: tauri::Runtime, W: tauri::Emitter<R>>(
        &self,
        runtime: &AgentRuntime,
        window: &W,
        status: AgentLifecycleStatus,
        last_error: Option<String>,
    ) {
        self.set_agent_runtime_status(runtime, status, last_error.clone());
        // P2-3：崩溃检测在状态写入之后执行——acp 已死时崩溃状态优先于本次
        // announce 的状态（避免"status=reconnecting 但 crashed=true"的自我矛盾）。
        Self::detect_and_record_crashes(Some(runtime));
        let mut payload = self.agent_status_payload(Some(runtime));
        // P3-12：announce 后处理（payload 未报告崩溃时按 announce 覆写状态/错误）
        apply_announce_override(&mut payload, status, last_error);
        emit_event(window, event_names::AGENT_STATUS, payload);
    }

    async fn replace_agent_client<R: tauri::Runtime>(
        &self,
        runtime: &Arc<AgentRuntime>,
        agent_id: Option<String>,
        new_acp: AcpClient,
        window: tauri::WebviewWindow<R>,
        keep_sessions: bool,
    ) -> Result<(), String> {
        if new_acp.is_crashed() {
            return Err("new ACP client crashed before activation".to_string());
        }

        // 优化-1：keep=false（手动 switch/reconnect）映射清空后，旧 source 的 prompt
        // 锁条目必须同步收敛（O1 语义，与 remove_session_if_matches/check_session_expiry
        // 一致）——否则旧 source 条目随任意命名的 GUI source 无限累积。锁内先快照
        // 旧 source 键，映射清空后在锁外逐个清理（锁序单向：sessions → prompt_locks）。
        let mut stale_sources: Vec<String> = Vec::new();
        let mut old_acp = {
            let mut acp = runtime.acp.lock().await;
            let mut sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
            if !keep_sessions {
                stale_sources = sessions.keys().cloned().collect();
            }
            let old_acp = std::mem::replace(&mut *acp, new_acp);
            let new_generation = runtime.client_generation.fetch_add(1, Ordering::AcqRel) + 1;
            self.set_agent_runtime_status(runtime, AgentLifecycleStatus::Connected, None);
            if let Some(agent_id) = agent_id {
                if let Ok(mut active) = self.active_agent.lock() {
                    *active = agent_id;
                }
            }
            apply_client_replacement_sessions(&mut sessions, keep_sessions, new_generation);
            // 审查修复：客户端替换（switch/重连/自动重连）后旧进程的挂起权限请求
            // 全部失效——清空，避免 300s 超时把 reject 写到新进程（且可能撞新 id）。
            if let Ok(mut pending) = runtime.pending_permissions.lock() {
                let stale = pending.len();
                pending.clear();
                if stale > 0 {
                    tracing::warn!("客户端替换：清理 {stale} 个挂起的权限请求（旧进程已失效）");
                }
            }
            tracing::info!("ACP client activated; generation is now {}", new_generation);
            old_acp
        };
        // 优化-1：sessions 锁已释放——清理旧 source 的 prompt 锁条目。
        // G2-08：lib.rs 本地 drop_stale_prompt_locks 删除，收敛为 runtime 方法。
        runtime.drop_prompt_locks(&stale_sources);
        start_notification_dispatcher(self, runtime, window);
        if let Err(error) = old_acp.kill() {
            tracing::warn!("kill replaced agent: {}", error);
        }
        Ok(())
    }
}

/// per-source prompt 锁表（source → 锁）。clippy 2026-08-02：复杂类型提取别名。
pub(crate) type PromptLockTable = Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>;

pub(crate) fn prompt_lock_for(
    locks: &PromptLockTable,
    source: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(source.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

// ── B11 注入钩子集成测试 ──

// ── B4.2 MCP 配置持久化测试 ──

// ── 会话过期平台判定测试（核验修复） ──

// ── B10.4 平台链路集成测试（fake QQ 事件 → ingest → 注入 → fake ACP → deliver 回发） ──

/// R18：初始化 tracing subscriber——fmt（stderr，INFO 上限）+ RuntimeLogLayer
/// （tracing event → RuntimeLogHub 转发，level/source/message/fields 形状保持）。
/// main.rs 在 run() 之前调用；hub 本身由 run() 创建后经 register_hub 注册，
/// Layer 按事件惰性读取，注册前的 event 直接丢弃（此前 log 宏本就无 sink）。
pub fn init_tracing() {
    use tracing_subscriber::layer::Layer;
    let base = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_writer(std::io::stderr)
        .finish();
    let subscriber = runtime_log::RuntimeLogLayer::new().with_subscriber(base);
    let _ = tracing::subscriber::set_global_default(subscriber);
}

/// 会话过期判定（B10.3b，参考 Hermes reset policy）：返回过期原因，None = 未过期。
///
/// - reset="off"：永不过期
/// - reset="daily"：按 UTC 日历天比较（updated_at 与 now 不同天 → 过期）
/// - 其他（默认 idle）：`now - updated_at > idle_minutes` → 过期
///   updated_at 缺失（历史数据）视为未过期（保守，防误杀）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // R1-R3（P1-1）：启动配置统一装载——同一份 YAML 文本分域解析
    // （Agent/Gateway 部分成功，互不绑定成败）。
    let loaded = agent_config::load_app_config();
    let agents_error = loaded.agents.as_ref().err().map(ToString::to_string);
    let gateway_error = loaded.gateway.as_ref().err().map(ToString::to_string);
    let config_source = loaded.source.clone();
    let gateway_result = loaded.gateway;
    let agents = match loaded.agents {
        Ok(agents) => agents,
        Err(error) => {
            eprintln!("Pylon agent configuration error: {error}");
            HashMap::new()
        }
    };
    let default_agent_id = match agent_config::default_agent_id(&agents) {
        Ok(Some(id)) => id,
        Ok(None) => String::new(),
        Err(error) => {
            eprintln!("Pylon agent configuration error: {error}");
            String::new()
        }
    };
    let default_agent = agents.get(&default_agent_id).cloned();
    let agents_for_state = agents;
    // R5（P1-3）：prism 构造为纯同步，移出 async 块以便诊断快照一次构建。
    let prism = match PrismClient::from_env() {
        Ok(client) => client,
        Err(error) => {
            eprintln!("Pylon Prism client unavailable: {error}");
            PrismClient::unavailable(error)
        }
    };
    let startup = Arc::new(crate::startup::build_startup_diagnostics(
        config_source,
        agents_error,
        gateway_error,
        prism.has_valid_configuration(),
        (!default_agent_id.is_empty()).then(|| default_agent_id.clone()),
    ));

    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(error) => {
            eprintln!("Pylon runtime initialization failed: {error}");
            return;
        }
    };
    rt.block_on(async {
        let prism = prism;
        let runtime_logs = runtime_log::RuntimeLogHub::default();
        runtime_log::register_hub(runtime_logs.clone());
        // R3（P1-1）：Gateway 使用启动同源配置快照（不再各自 include_str 另一份）；
        // gateway 域失败 → 空配置 degraded 启动（诊断快照已记录原因）。
        let gateway = Arc::new(match gateway_result {
            Ok(config) => GatewayCore::from_config(config),
            Err(error) => {
                eprintln!("Pylon gateway configuration error: {error}");
                GatewayCore::from_config(crate::gateway::route::GatewayConfig::empty())
            }
        });
        // QQ 适配器（B10.2）：凭据存在时创建 auth + adapter + WS 循环并注册进 gateway。
        // PYLON_QQ_CLIENT_SECRET 为 secret：只读入 QqAuth，不进任何输出。
        if let (Ok(qq_app_id), Ok(qq_client_secret)) = (
            std::env::var("PYLON_QQ_APP_ID"),
            std::env::var("PYLON_QQ_CLIENT_SECRET"),
        ) {
            let qq_http = match reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
            {
                Ok(client) => client,
                Err(error) => {
                    eprintln!("Pylon QQ HTTP client unavailable: {error}");
                    reqwest::Client::new()
                }
            };
            let qq_auth = Arc::new(gateway::qq::auth::QqAuth::new(
                qq_http.clone(),
                qq_app_id,
                qq_client_secret,
            ));
            let qq_adapter = gateway::qq::QqAdapter::new(gateway.clone(), qq_http.clone(), qq_auth.clone());
            if let Err(error) = gateway.register(qq_adapter.clone()) {
                eprintln!("Pylon QQ adapter register failed: {error}");
            } else {
                tracing::info!("QQ 适配器已注册（PYLON_QQ_APP_ID）");
                tokio::spawn(gateway::qq::ws::run_ws_loop(qq_http, qq_auth, qq_adapter));
            }
        }
        let runtimes = Arc::new(AgentRuntimeManager::new());
        let default_runtime = AgentRuntime::new_disconnected();
        {
            // 默认 agent 初始连接：成功 → Connected；失败 → Error（保留错误信息）
            if let Some(agent) = &default_agent {
                match AcpClient::connect_with_logs(agent, Some(runtime_logs.clone())).await {
                    Ok(client) => {
                        let mut acp = default_runtime.acp.lock().await;
                        *acp = client;
                        drop(acp);
                        if let Ok(mut state) = default_runtime.agent_runtime.lock() {
                            state.status = AgentLifecycleStatus::Connected;
                            state.last_error = None;
                            state.last_connected_at = Some(crate::time::Timestamp::now());
                        }
                    }
                    Err(error) => {
                        eprintln!("Pylon ACP agent unavailable: {error}");
                        if let Ok(mut state) = default_runtime.agent_runtime.lock() {
                            state.status = AgentLifecycleStatus::Error;
                            state.last_error = Some(error.to_string());
                            state.last_connected_at = None;
                        }
                    }
                }
            } else {
                eprintln!("Pylon has no configured Agent; start in disconnected mode");
            }
        }
        if !default_agent_id.is_empty() {
            runtimes.insert(default_agent_id.clone(), default_runtime);
        }

        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .manage(AppState {
                runtimes,
                agents: Arc::new(Mutex::new(agents_for_state)),
                active_agent: Arc::new(Mutex::new(default_agent_id)),
                pet: Arc::new(Mutex::new(pet::PetState::default())),
                runtime_logs,
                runtime_mcp: Mutex::new(None),
                prism,
                gateway,
                startup,
                approval_mode: Arc::new(Mutex::new("default".to_string())),
                pet_write_lock: tokio::sync::Mutex::new(()),
            switch_lock: tokio::sync::Mutex::new(()),
            mcp_write_lock: tokio::sync::Mutex::new(()),
            // P1（E10）：wire 缓存初始 None——启动恢复路径（setup load_mcp_persisted
            // 直写 runtime_mcp）后首次读取 miss 回退全量重算并回填（E3 自愈）。
            mcp_wire: Mutex::new(None),
            frontend_log_throttle: Mutex::new(runtime_log::FrontendLogThrottle::default()),
            })
            .invoke_handler(tauri::generate_handler![
                crate::prism_cmds::prism_health, crate::prism_cmds::prism_status, crate::prism_cmds::prism_state, crate::prism_cmds::prism_scenarios, crate::prism_cmds::prism_sources, crate::prism_cmds::prism_aliases, crate::prism_cmds::prism_config,
                crate::prism_cmds::prism_logs, crate::prism_cmds::prism_chronicle, crate::prism_cmds::prism_history, crate::prism_cmds::prism_scenario, crate::prism_cmds::prism_blocks,
                crate::prism_cmds::prism_inject, crate::prism_cmds::prism_command, crate::prism_cmds::prism_create_scenario, crate::prism_cmds::prism_delete_scenario,
                crate::prism_cmds::prism_create_source, crate::prism_cmds::prism_delete_source, crate::prism_cmds::prism_source_detail, crate::prism_cmds::prism_source_files,
                crate::prism_cmds::prism_read_source_file, crate::prism_cmds::prism_write_source_file, crate::prism_cmds::prism_delete_source_file,
                crate::prism_cmds::prism_source_entries, crate::prism_cmds::prism_source_entry, crate::prism_cmds::prism_add_source_entry, crate::prism_cmds::prism_edit_source_entry,
                crate::prism_cmds::prism_delete_source_entry,
                crate::prism_cmds::prism_update_config, crate::prism_cmds::prism_update_scenario, crate::prism_cmds::prism_create_block, crate::prism_cmds::prism_update_block,
                crate::prism_cmds::prism_delete_block, crate::prism_cmds::prism_add_scenario_block, crate::prism_cmds::prism_edit_scenario_block,
                crate::prism_cmds::prism_delete_scenario_block, crate::prism_cmds::prism_reorder_scenario_blocks, crate::prism_cmds::prism_reload, crate::prism_cmds::prism_llm_test,
                crate::session::new_session, crate::session::send_message, crate::session::set_mode, crate::session::set_config_option, crate::session::close_session, crate::session::cancel_prompt, crate::session::load_sessions,
                crate::session::session_inspector, crate::lifecycle::list_agents, crate::lifecycle::switch_agent, crate::lifecycle::reconnect_agent, crate::lifecycle::agent_status, crate::lifecycle::reload_agents, crate::lifecycle::set_mcp_servers,
                crate::lifecycle::validate_agents,
                crate::permission::approve_tool_call, crate::permission::set_approval_mode,
                crate::pet_cmds::get_pet, crate::pet_cmds::pet_action,
                crate::session::load_persisted_session, crate::session::list_persisted_sessions,
                crate::export::export_session,
                crate::logs_cmds::list_runtime_logs, crate::logs_cmds::clear_runtime_logs, crate::logs_cmds::push_frontend_log,
                crate::workspace_cmds::get_workspace_root, crate::workspace_cmds::list_workspace_entries, crate::workspace_cmds::read_workspace_text,
                crate::workspace_cmds::git_status, crate::workspace_cmds::git_diff, crate::workspace_cmds::git_history,
                crate::gateway_cmds::gateway_status, crate::gateway_cmds::reload_gateway,
                crate::startup::startup_diagnostics,
            ])
            .setup(|app| {
                let window = app.get_webview_window("main").ok_or("main window not found")?;
                if let Err(error) = window.set_title("Pylon") { tracing::warn!("set window title failed: {error}"); }
                // 宠物状态落盘加载：文件缺失/损坏时保持新宠物（静默降级）
                match pet_persist_path(app.handle()) {
                    Ok(path) => {
                        if let Some(saved) = pet::load_from_file(&path) {
                            let pet_arc = app.state::<AppState>().pet.clone();
                            if let Ok(mut pet) = pet_arc.lock() {
                                pet::restore(&mut pet, saved);
                            };
                        }
                    }
                    Err(error) => tracing::warn!("resolve pet persist path failed: {error}"),
                }
                // B4.2：MCP 配置落盘加载（重启不丢）。文件缺失/损坏/非法 → 保持空配置（静默降级）。
                match mcp_persist_path(app.handle()) {
                    Ok(path) => {
                        if let Some(servers) = load_mcp_persisted(&path) {
                            if let Ok(mut slot) = app.state::<AppState>().runtime_mcp.lock() {
                                *slot = Some(servers);
                                tracing::info!("MCP 配置已从 {} 恢复", path.display());
                            }
                        }
                    }
                    Err(error) => tracing::warn!("resolve MCP persist path failed: {error}"),
                }
                let handles = AppStateHandles::from_state(app.state::<AppState>().inner());
                if let Some(runtime) = handles.active_runtime() {
                    start_notification_dispatcher(&handles, &runtime, window.clone());
                }
                app.state::<AppState>().inner().start_runtime_log_dispatcher(window);
                // gateway ingest handler（B10.3）：平台消息 → 绑定/默认 agent runtime → 发送。
                // 平台消息路由不切换 GUI active agent；目标 agent 未连接时懒启动
                // （announce=false，不广播 GUI 状态）。
                {
                    let app_handle = app.handle().clone();
                    let main_webview = app.get_webview_window("main");
                    let main_window = main_webview.as_ref().map(|w| w.as_ref().window());
                    let state = app.state::<AppState>();
                    state.gateway.set_ingest_handler(Arc::new(move |resolved: &gateway::ResolvedIngest| {
                        let app = app_handle.clone();
                        let webview = main_webview.clone();
                        let window = main_window.clone();
                        let resolved = resolved.clone();
                        tokio::spawn(async move {
                            let state = app.state::<AppState>();
                            let agent_id = resolved.binding.as_ref().map(|b| b.agent_id.clone())
                                .unwrap_or_else(|| {
                                    state.inner().active_agent.lock().map(|v| v.clone()).unwrap_or_default()
                                });
                            if agent_id.is_empty() {
                                tracing::warn!("gateway ingest 无路由目标（未绑定且无 active agent）: {}", resolved.source);
                                return;
                            }
                            let runtime = state.inner().runtimes.get_or_create(&agent_id);
                            if let Some(webview) = webview.as_ref() {
                                if let Err(error) = state.inner().ensure_runtime_ready(&runtime, &agent_id, webview).await {
                                    tracing::warn!("gateway ingest 目标 agent 连接失败 ({agent_id}): {error}");
                                    return;
                                }
                            }
                            // P1-1：平台路由绑定 agent ≠ GUI active agent 时会话 cwd 必须用
                            // 绑定 agent 的 cwd（而非 active agent）；无绑定 agent 定义时回退 None。
                            let agent_cwd = state.inner().agents.lock().ok()
                                .and_then(|agents| agents.get(&agent_id).cloned())
                                .and_then(|agent| agent.cwd);
                            // G2-05：PromptContext 构造（source 需 clone——失败回滚仍用）
                            if let Err(error) = send_prompt_core(
                                state.inner(),
                                &runtime,
                                window.as_ref(),
                                &state.gateway,
                                &crate::session::PromptContext {
                                    source: resolved.source.clone(),
                                    content: resolved.content.clone(),
                                    persona: String::new(),
                                    session_prompt: None,
                                    attachments: None,
                                    mcp_servers: None,
                                    cwd: agent_cwd,
                                },
                            ).await {
                                tracing::warn!("gateway ingest 发送失败 ({}): {error}", resolved.source);
                                // C14：发送失败回滚去重 seen——故障期消息不占去重窗口，
                                // resume 重放可重新 ingest（防故障期消息永久丢失）。
                                // 经 PlatformAdapter::rollback_seen（trait 默认空实现，
                                // QQ 适配器覆盖为 dedup 回滚；未注册适配器时无操作）。
                                // G4 §3-9（C5）：统一入口 adapter_for_source（空 key 返回
                                // None，与旧 platform_key 判空等价；接入 wechat 等新平台
                                // 自动生效，未注册适配器无操作）。
                                if let Some(msg_id) = resolved.msg_id.as_deref() {
                                    if let Some(adapter) =
                                        state.gateway.adapter_for_source(&resolved.source)
                                    {
                                        adapter.rollback_seen(msg_id);
                                    }
                                }
                            }
                        });
                    }));
                }
                // 会话过期 watcher（B10.3b）：每 60s 检查所有 runtime 的平台会话，
                // 按绑定 reset 策略（idle/daily/off）过期并重置（close + 平台通知）。
                // 同循环检查挂起权限请求超时（B9.2：超时默认拒绝）。
                {
                    let app_for_watcher = app.handle().clone();
                    tokio::spawn(async move {
                        loop {
                            tokio::time::sleep(Duration::from_secs(60)).await;
                            let state = app_for_watcher.state::<AppState>();
                            check_session_expiry(state.inner()).await;
                            check_pending_permission_timeouts(state.inner()).await;
                        }
                    });
                }
                Ok(())
            })
            // 关窗时不在此处 block_on kill——run() 由 rt.block_on 驱动，窗口回调在
            // 同一 runtime 栈内执行，嵌套 block_on 必 panic ("Cannot start a runtime
            // from within a runtime")。子进程清理依赖 AppState drop 链：
            // AcpClient → ManagedChild::drop → kill_and_wait（同步 std 操作，不依赖 tokio）。
            .build(tauri::generate_context!())
            .expect("error while building tauri application")
            .run(|app_handle: &tauri::AppHandle, event: tauri::RunEvent| {
                if let tauri::RunEvent::Exit = event {
                    // R17：coalescing 有界 drain——清 dirty 防后台任务重复写盘，
                    // 随后直接同步落盘兜底（后台任务在途写盘不受影响，R6a 尽力语义）。
                    crate::pet_cmds::drain_pet_dirty();
                    // 退出兜底：最后持久化一次（get_pet 12s 轮询已覆盖大部分变更）
                    let pet_arc = app_handle.state::<AppState>().pet.clone();
                    if let Ok(pet) = pet_arc.try_lock() {
                        persist_pet_if_possible(app_handle, &pet);
                    };
                }
            });
    });
}
