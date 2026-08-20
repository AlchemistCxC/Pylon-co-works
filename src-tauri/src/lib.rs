mod acp;
pub use pylon_core::agent_catalog;
mod agent_config;
pub mod agent_detection;
mod agent_runtime;
#[cfg(test)]
mod auto_reconnect_integration_tests;
#[cfg(test)]
mod b10_gateway_integration_tests;
#[cfg(test)]
mod b11_inject_integration_tests;
mod browser;
mod browser_cmds;
mod correlation;
mod cwd;
mod dispatcher;
mod error;
mod event_names;
mod export;
mod gateway;
mod gateway_cmds;
mod git;
mod hermes;
mod lifecycle;
mod logs_cmds;
mod mcp;
#[cfg(test)]
mod mcp_persist_tests;
#[cfg(test)]
mod obs03_evidence_tests;
#[cfg(test)]
mod p1_wire_regression_tests;
mod paths;
mod permission;
mod pet;
mod pet_cmds;
mod plugin_cmds;
mod plugin_process;
mod prism;
mod prism_cmds;
mod protocol_adapter;
pub mod pylon_cli;
#[cfg(test)]
mod real_acp_smoke;
mod runtime;
mod runtime_log;
mod sanitize;
mod session;
#[cfg(test)]
mod session_expiry_platform_tests;
#[cfg(test)]
mod session_info_tests;
mod session_store;
mod startup;
#[cfg(test)]
mod test_utils;
mod time;
// CWD-04：工具/Git/workspace cwd 一致性验收（只读取证 + 诊断，不新增 wire/命令行为；
// 纯测试用途——按 real_acp_smoke / del01_schema_audit 等验收模块惯例 cfg(test) 门控）。
#[cfg(test)]
mod cwd04;
mod workspace;
mod workspace_cmds;
mod workspaces;

use acp::AcpClient;
use agent_config::AgentDef;
use agent_runtime::AgentLifecycleStatus;
use gateway::GatewayCore;
use prism::PrismClient;
use runtime::{AgentRuntime, AgentRuntimeManager};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
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
use crate::lifecycle::load_mcp_persisted;
use crate::permission::check_pending_permission_timeouts;
use crate::pet_cmds::persist_pet_if_possible;
use crate::session::{check_session_expiry, send_prompt_core};

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
    apply_client_replacement_sessions, build_full_inspector_payload, compose_inject_prompt,
    config_option_current_value, extract_tool_file_name, inject_applies_to, send_message,
    session_expired, InspectorSessionRow, SessionListRow,
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

/// 构建 Hermes profile 诊断视图（方案 G 演进）：探测可用 profiles + 记录配置的
/// `hermes_profile` 是否可解析。诊断只暴露 profile 名，不暴露 Hermes 根路径。
fn build_hermes_profile_view(
    agents: &HashMap<String, AgentDef>,
) -> Option<crate::startup::HermesProfileView> {
    let home = crate::hermes::detect_hermes_home();
    let profiles = home
        .as_deref()
        .map(crate::hermes::list_profiles)
        .unwrap_or_default();
    let configured = agents
        .values()
        .find_map(|agent| agent.hermes_profile.clone());
    let agent_with_profile = agents.values().find(|agent| agent.hermes_profile.is_some());
    // 有 Hermes 探测信息或配置了 profile 才进诊断（避免无关配置塞空视图）。
    if home.is_none() && configured.is_none() {
        return None;
    }
    let resolved = agent_with_profile
        .is_some_and(|agent| crate::hermes::resolve_profile_dir(agent, None).is_some());
    Some(crate::startup::HermesProfileView {
        profiles,
        configured,
        resolved,
    })
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
    /// R5（P1-3）：启动诊断快照（run() 构建主体，setup 解析 DataDirs 后补写 storage）。
    pub(crate) startup: Arc<RwLock<crate::startup::StartupDiagnostics>>,
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
    /// Phase 3：配置写序锁（tokio Mutex）——update_agents_config 读当前→生成候选→
    /// 校验→写盘→内存提交全程持锁，两个写请求不基于同一旧版本互相覆盖。
    pub(crate) config_write_lock: tokio::sync::Mutex<()>,
    /// Phase 4：浏览器会话管理（WebView 方案 §6.0；setup() 注入主窗口）。
    pub(crate) browser: Arc<browser::BrowserManager>,
    /// P1（E10）：MCP wire 序列化缓存（Vec<Value>，session/new 的 mcpServers 载荷）。
    /// 每消息省一次全量 validate+serialize（≤32 server × 字段校验 + 一次 clone）。
    /// 写入 = set_mcp_servers 与 runtime_mcp 同 mcp_write_lock 下同步；读取
    /// （send_prompt_core None 路径）miss 时回退全量重算并回填（E3 自愈：启动
    /// 恢复路径直写 runtime_mcp 不经 set_mcp_servers，缓存为 None，首次读取即回填）。
    pub(crate) mcp_wire: Mutex<Option<Vec<serde_json::Value>>>,
    /// R8（P2-3）：前端日志限流窗口（每秒上限，超限丢弃）。
    pub(crate) frontend_log_throttle: Mutex<runtime_log::FrontendLogThrottle>,
    /// I14-W1：消息仓库 service（SQLite，app_data_dir/pylon-data-v1.sqlite3）。
    /// setup() readiness barrier 内创建目录 → open/migrate → 填入本槽；生产 setup
    /// 返回后必为 Some，任一 service 失败会阻止半可用 Kernel 启动。None 仅用于
    /// 构造期/测试，命令层仍防御性返回 message_db_unavailable。
    pub(crate) message_service: Arc<Mutex<Option<Arc<crate::session::MessageService>>>>,
    /// I14-W5：用户数据仓库 service（与消息同库 user_data 表，versioned
    /// Profile/Session/activeProfileId）。与 message/event 作为同一 readiness unit
    /// 串行打开；生产 setup 返回后必为 Some。
    pub(crate) user_data_service: Arc<Mutex<Option<Arc<crate::session::UserDataService>>>>,
    /// M3 EVT-02：canonical 事件仓库 service（与消息同库 canonical_events 表 v6，
    /// 方案书 §5.10 append-only 事件流）。与 message/user-data 作为同一 readiness
    /// unit 串行打开；生产 setup 返回后必为 Some。
    pub(crate) event_service: Arc<Mutex<Option<Arc<crate::session::EventService>>>>,
    /// I12-W4：gateway 实例 registry 与状态机（W1 已建；setup 加载持久化配置、
    /// 注册 factory 与 route guard）。
    pub(crate) gateway_instances: crate::gateway::instance::GatewayInstanceService,
    /// I12-W4：实例配置持久化路径（app_data_dir/pylon-gateway-instances.json）；
    /// None（测试）→ 管理命令跳过持久化（内存态仍生效）。
    pub(crate) gateway_instance_store_path: Arc<Mutex<Option<std::path::PathBuf>>>,
    /// I12-W5：加密凭据存储（W3 已建；setup 打开，set_credentials 命令与 start 解析用）。
    /// None = 打开失败（blocked，命令报 credential_store_error）。
    pub(crate) gateway_credentials:
        Arc<Mutex<Option<Arc<crate::gateway::credentials::CredentialStore>>>>,
    /// CWD-03：Workspace 实体注册表（id → Workspace；跨 Agent 共享，owner 仅溯源）。
    pub(crate) workspaces: Arc<Mutex<HashMap<String, crate::workspaces::Workspace>>>,
    /// 施工文档 §2.3：本次启动的数据/配置目录（setup() 最前面解析一次）。
    /// 所有 SQLite/插件/MCP/gateway/pet 路径消费者必须经 `data_dirs()` 读取，
    /// 禁止在运行期重复 `resolve_data_dirs()`。
    pub(crate) data_dirs: Arc<OnceLock<crate::paths::DataDirs>>,
    /// Phase 8: plugin-owned subprocesses and JSON-RPC pending requests.
    pub(crate) plugin_processes: Arc<crate::plugin_process::PluginProcessSupervisor>,
    /// Stage 10: current-user local IPC bridge into the live Web Kernel.
    pub(crate) pylon_cli: Arc<crate::pylon_cli::PylonCliBridge>,
}

impl AppState {
    /// 读取本次启动解析一次的数据目录（未初始化 = 启动时序缺陷，显式报错）。
    pub(crate) fn data_dirs(&self) -> Result<&crate::paths::DataDirs, String> {
        self.data_dirs
            .get()
            .ok_or_else(|| "data dirs not initialized".to_string())
    }

    /// DataDirs 克隆（路径消费者需要 owned 值跨 spawn_blocking/async 闭包时）。
    pub(crate) fn data_dirs_cloned(&self) -> Result<crate::paths::DataDirs, String> {
        self.data_dirs().cloned()
    }
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
    /// Production setup readiness barrier 后必为 Some；Option 仅保留测试构造兼容与
    /// 防御性诊断。dispatcher 对有 durable owner 的事件必须先 append 再发布。
    pub(crate) event_service: Arc<Mutex<Option<Arc<crate::session::EventService>>>>,
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
            event_service: state.event_service.clone(),
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
        // 方案 8：sessions 迁移委托 SessionStore（migrate_or_clear 返回旧 source 键）。
        let (mut old_acp, stale_sources) = {
            let mut acp = runtime.acp.lock().await;
            let old_acp = std::mem::replace(&mut *acp, new_acp);
            let new_generation = runtime.client_generation.fetch_add(1, Ordering::AcqRel) + 1;
            self.set_agent_runtime_status(runtime, AgentLifecycleStatus::Connected, None);
            if let Some(agent_id) = agent_id {
                if let Ok(mut active) = self.active_agent.lock() {
                    *active = agent_id;
                }
            }
            let stale_sources =
                crate::session_store::migrate_or_clear(runtime, keep_sessions, new_generation)
                    .map_err(|error| error.to_string())?;
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
            (old_acp, stale_sources)
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
    // P0-3（R2-WI03）+ R2-WI06：注册协议适配器——Peri 与 Hermes 的审批 wire 逐字段
    // 一致（均走 ACP session/request_permission + RequestPermissionResponse，已源码实证），
    // 同一 request_permission 实现按 provider 注册；clarify/ask-user 无真实 wire 不注册。
    protocol_adapter::register_protocol_adapter(std::sync::Arc::new(
        protocol_adapter::RequestPermissionAdapter { provider: "peri" },
    ));
    protocol_adapter::register_protocol_adapter(std::sync::Arc::new(
        protocol_adapter::RequestPermissionAdapter { provider: "hermes" },
    ));
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
    // Hermes profile 探测（方案 G 演进）：agents 解析成功后，探测可用 profiles 并
    // 记录配置的 hermes_profile 是否可解析（诊断只暴露 profile 名，不暴露路径）。
    let hermes_profile = build_hermes_profile_view(&agents_for_state);
    let startup = Arc::new(crate::startup::build_startup_diagnostics(
        config_source,
        agents_error,
        gateway_error,
        prism.has_valid_configuration(),
        (!default_agent_id.is_empty()).then(|| default_agent_id.clone()),
        hermes_profile,
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
            .register_uri_scheme_protocol("pylon-plugin", |context, request| {
                crate::plugin_cmds::plugin_resource_response(context.app_handle(), request)
            })
            .manage(AppState {
                runtimes,
                agents: Arc::new(Mutex::new(agents_for_state)),
                active_agent: Arc::new(Mutex::new(default_agent_id)),
                pet: Arc::new(Mutex::new(pet::PetState::default())),
                runtime_logs,
                runtime_mcp: Mutex::new(None),
                prism,
                gateway,
                startup: Arc::new(RwLock::new((*startup).clone())),
                approval_mode: Arc::new(Mutex::new("default".to_string())),
                pet_write_lock: tokio::sync::Mutex::new(()),
            switch_lock: tokio::sync::Mutex::new(()),
            mcp_write_lock: tokio::sync::Mutex::new(()),
            config_write_lock: tokio::sync::Mutex::new(()),
            browser: Arc::new(browser::BrowserManager::new()),
            // P1（E10）：wire 缓存初始 None——启动恢复路径（setup load_mcp_persisted
            // 直写 runtime_mcp）后首次读取 miss 回退全量重算并回填（E3 自愈）。
            mcp_wire: Mutex::new(None),
            frontend_log_throttle: Mutex::new(runtime_log::FrontendLogThrottle::default()),
            // I14-W1：消息仓库槽位初始 None，setup() 启动时序填充（见 struct 注释）。
            message_service: Arc::new(Mutex::new(None)),
            // I14-W5：用户数据仓库槽位初始 None，setup() 启动时序填充（与消息同库）。
            user_data_service: Arc::new(Mutex::new(None)),
            // M3 EVT-02：canonical 事件仓库槽位初始 None，setup() 启动时序填充（同库）。
            event_service: Arc::new(Mutex::new(None)),
            // I12-W4：gateway 实例服务与持久化路径，setup() 启动时序填充。
            gateway_instances: crate::gateway::instance::GatewayInstanceService::new(),
            gateway_instance_store_path: Arc::new(Mutex::new(None)),
            // I12-W5：凭据存储槽位初始 None，setup() 打开填充。
            gateway_credentials: Arc::new(Mutex::new(None)),
            // CWD-03：Workspace 注册表初始空（测试经 TestStateBuilder 注入）。
            workspaces: Arc::new(Mutex::new(HashMap::new())),
            // 施工文档 §2.3：数据目录槽位初始空，setup() 最前面解析填入。
            data_dirs: Arc::new(OnceLock::new()),
            plugin_processes: Arc::new(crate::plugin_process::PluginProcessSupervisor::default()),
            pylon_cli: Arc::new(crate::pylon_cli::PylonCliBridge::default()),
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
                crate::session::session_inspector, crate::lifecycle::list_agents, crate::lifecycle::switch_agent, crate::lifecycle::reconnect_agent, crate::lifecycle::agent_status, crate::lifecycle::acp_wire_trace_snapshot, crate::lifecycle::reload_agents, crate::lifecycle::get_mcp_servers, crate::lifecycle::set_mcp_servers,
                crate::lifecycle::list_tool_dictionary,
                crate::lifecycle::set_session_state,
                crate::lifecycle::validate_agents,
                crate::lifecycle::update_agents_config,
                crate::lifecycle::agent_config_snapshot,
                crate::lifecycle::initialize_agents_config,
                crate::lifecycle::test_agent_connection,
                crate::lifecycle::test_agent_candidate,
                crate::agent_detection::detect_agent_runtimes,
                crate::permission::approve_tool_call, crate::permission::respond_interaction, crate::permission::set_approval_mode,
                crate::pet_cmds::get_pet, crate::pet_cmds::pet_action,
                crate::session::load_persisted_session, crate::session::list_persisted_sessions,
                crate::session::evt_append, crate::session::evt_revision, crate::session::evt_list, crate::session::evt_export_raw, crate::session::evt_search,
                crate::session::user_data_load, crate::session::user_data_save,
                crate::session::user_profile_delete, crate::session::user_session_delete,
                crate::session::user_session_delete_finalize,
                crate::session::retention_policy_get, crate::session::retention_policy_set,
                crate::session::retention_preview, crate::session::retention_prune,
                crate::export::export_session,
                crate::logs_cmds::list_runtime_logs, crate::logs_cmds::clear_runtime_logs, crate::logs_cmds::push_frontend_log,
                crate::workspace_cmds::get_workspace_root, crate::workspace_cmds::list_workspace_entries, crate::workspace_cmds::read_workspace_text,
                crate::workspace_cmds::write_workspace_text,
                crate::workspace_cmds::git_status, crate::workspace_cmds::git_status_with_branch,
                crate::workspace_cmds::git_diff, crate::workspace_cmds::git_history,
                crate::workspace_cmds::git_stage, crate::workspace_cmds::git_unstage,
                crate::workspace_cmds::git_commit, crate::workspace_cmds::git_create_branch,
                crate::workspace_cmds::git_switch_branch, crate::workspace_cmds::git_pull,
                crate::workspace_cmds::git_push,
                crate::workspace_cmds::workspace_search,
                crate::workspaces::workspace_create, crate::workspaces::workspace_list,
                crate::workspaces::workspace_restore,
                crate::workspaces::workspace_update, crate::workspaces::workspace_delete,
                crate::plugin_cmds::plugin_package_inspect,
                crate::plugin_cmds::plugin_package_install,
                crate::plugin_cmds::plugin_package_update,
                crate::plugin_cmds::plugin_package_stage,
                crate::plugin_cmds::plugin_package_stage_commit,
                crate::plugin_cmds::plugin_package_stage_abort,
                crate::plugin_cmds::plugin_package_versions,
                crate::plugin_cmds::plugin_package_list,
                crate::plugin_cmds::plugin_package_set_enabled,
                crate::plugin_cmds::plugin_package_rollback,
                crate::plugin_cmds::plugin_package_uninstall,
                crate::plugin_cmds::plugin_package_read_text,
                crate::plugin_cmds::plugin_package_resource_url,
                crate::plugin_cmds::plugin_runtime_create,
                crate::plugin_cmds::plugin_runtime_cleanup,
                crate::plugin_process::plugin_process_spawn,
                crate::plugin_process::plugin_process_list,
                crate::plugin_process::plugin_process_logs,
                crate::plugin_process::plugin_process_write,
                crate::plugin_process::plugin_process_request,
                crate::plugin_process::plugin_process_cancel,
                crate::plugin_process::plugin_process_terminate,
                crate::plugin_process::plugin_process_kill,
                crate::pylon_cli::pylon_cli_ready,
                crate::pylon_cli::pylon_cli_respond,
                crate::pylon_cli::pylon_window_capture,
                crate::gateway_cmds::gateway_status, crate::gateway_cmds::reload_gateway,
                crate::gateway_cmds::gateway_sessions,
                crate::gateway_cmds::gateway_catalog,
                crate::gateway_cmds::gateway_instances, crate::gateway_cmds::gateway_instance_create,
                crate::gateway_cmds::gateway_instance_update, crate::gateway_cmds::gateway_instance_remove,
                crate::gateway_cmds::gateway_instance_start, crate::gateway_cmds::gateway_instance_stop,
                crate::gateway_cmds::gateway_instance_restart,
                crate::gateway_cmds::gateway_instance_set_credentials,
                crate::browser_cmds::browser_start, crate::browser_cmds::browser_new_tab, crate::browser_cmds::browser_select_tab, crate::browser_cmds::browser_close_tab, crate::browser_cmds::browser_status, crate::browser_cmds::browser_navigate,
                crate::browser_cmds::browser_back, crate::browser_cmds::browser_forward, crate::browser_cmds::browser_reload,
                crate::browser_cmds::browser_set_bounds, crate::browser_cmds::browser_set_zoom, crate::browser_cmds::browser_close,
                crate::startup::startup_diagnostics,
                crate::paths::migrate_appdata_to_portable,
            ])
            .setup(|app| {
                let window = app.get_webview_window("main").ok_or("main window not found")?;
                if let Err(error) = window.set_title("Pylon") { tracing::warn!("set window title failed: {error}"); }
                // 施工文档 §2.3：任何插件/Pet/MCP/SQLite/Gateway 路径消费者运行前，
                // 用 app.handle() 解析一次 DataDirs 并写入 AppState 一次性槽位。
                // 失败 = 启动中止（blocked），禁止消费者各自回退不同目录。
                let data_dirs = crate::paths::resolve_data_dirs(app.handle())
                    .map_err(|error| format!("resolve data dirs failed: {error}"))?;
                app.state::<AppState>()
                    .data_dirs
                    .set(data_dirs)
                    .map_err(|_| "data dirs already initialized".to_string())?;
                // 后续 setup 路径消费者统一使用这份一次性解析结果；跨 async/spawn_blocking
                // 时按需 clone（PathBuf 拷贝成本可忽略）。
                let dirs = app.state::<AppState>().data_dirs_cloned()?;
                // portable 首次启动自动迁移（2026-08-19 修复）：
                // AppData 旧数据 → data/。必须在此处（hydrate_workspaces 之前、
                // message_service 初始化之前）——服务打开后迁移命令会被拒绝，
                // hydrate 在迁移前会读到空 workspaces 表。失败不中止启动：
                // AppData 数据未动，可后续手动处理（UI 横幅兜底）。
                {
                    let app_data_dir = app
                        .path()
                        .app_data_dir()
                        .map_err(|error| error.to_string())?;
                    let app_config_dir = app
                        .path()
                        .app_config_dir()
                        .map_err(|error| error.to_string())?;
                    if crate::paths::migration_available(&dirs, &app_data_dir, &app_config_dir) {
                        match crate::paths::migrate_appdata_to_portable_staged(
                            &app_data_dir,
                            &app_config_dir,
                            &dirs.data_root,
                        ) {
                            Ok(()) => tracing::info!(
                                "AppData 旧数据已自动迁移至 portable: {}",
                                dirs.data_root.display()
                            ),
                            Err(error) => tracing::error!(
                                "portable 自动迁移失败（AppData 数据未动，可后续手动处理）：{error}"
                            ),
                        }
                    }
                }
                // Workspace 注册表必须先于前端 hydrate 恢复；文件缺失即首次启动，返回空表。
                crate::workspaces::hydrate_workspaces(app.state::<AppState>().inner())
                    .map_err(|error| format!("load workspaces failed: {error}"))?;
                // 施工文档 §7.4：storage 诊断与路径同时确定（只暴露模式/脱敏原因）。
                {
                    let app_data_dir = app
                        .path()
                        .app_data_dir()
                        .map_err(|error| error.to_string())?;
                    let app_config_dir = app
                        .path()
                        .app_config_dir()
                        .map_err(|error| error.to_string())?;
                    let migration_available =
                        crate::paths::migration_available(&dirs, &app_data_dir, &app_config_dir);
                    let storage = crate::startup::StorageDiagnostics::from_dirs(&dirs)
                        .with_migration_available(migration_available);
                    let app_state = app.state::<AppState>();
                    let mut startup = app_state
                        .startup
                        .write()
                        .map_err(|_| "startup diagnostics lock poisoned".to_string())?;
                    startup.storage = Some(storage);
                }
                // Phase 4：浏览器管理器注入主窗口（子 WebView add_child 需要）。
                app.state::<AppState>().browser.register_host(
                    window.as_ref().window(),
                    app.handle().clone(),
                );
                // 插件基建 v2：启动即创建用户插件目录树（installed/staging），
                // 让用户无需先安装也能在文件管理器里看到插件目录。
                if let Err(error) = crate::plugin_cmds::ensure_plugin_dirs(app.handle()) {
                    tracing::warn!("create plugin dirs failed: {error}");
                }
                // 宠物状态落盘加载：文件缺失/损坏时保持新宠物（静默降级）
                {
                    let path = crate::paths::pet_persist_path(&dirs);
                    if let Some(saved) = pet::load_from_file(&path) {
                        let pet_arc = app.state::<AppState>().pet.clone();
                        if let Ok(mut pet) = pet_arc.lock() {
                            pet::restore(&mut pet, saved);
                        };
                    }
                }
                // B4.2：MCP 配置落盘加载（重启不丢）。文件缺失/损坏/非法 → 保持空配置（静默降级）。
                {
                    let path = crate::paths::mcp_persist_path(&dirs);
                    if let Some(servers) = load_mcp_persisted(&path) {
                        if let Ok(mut slot) = app.state::<AppState>().runtime_mcp.lock() {
                            *slot = Some(servers);
                            tracing::info!("MCP 配置已从 {} 恢复", path.display());
                        }
                    }
                }
                // Kernel persistence readiness barrier：三个 service 共用同一 SQLite 文件，
                // 但作为一个启动单元串行 open/migrate 并一次性安装。setup 返回后所有
                // command/dispatcher 都可依赖 service 已就绪；任一失败则 setup 失败，
                // 不运行半可用 Kernel，也不回退 localStorage/第二历史权威。
                {
                    let db_path = crate::paths::message_db_path(&dirs);
                    let services = crate::session::PersistenceServices::open(&db_path)?;
                    let state = app.state::<AppState>();
                    *state
                        .message_service
                        .lock()
                        .map_err(|_| "message service slot lock poisoned".to_string())? =
                        Some(services.message);
                    *state
                        .user_data_service
                        .lock()
                        .map_err(|_| "user-data service slot lock poisoned".to_string())? =
                        Some(services.user_data);
                    *state
                        .event_service
                        .lock()
                        .map_err(|_| "event service slot lock poisoned".to_string())? =
                        Some(services.event);
                    tracing::info!("Kernel persistence services ready: {}", db_path.display());
                }
                // I12-W4：gateway 实例启动恢复——解析持久化路径 → 加载配置（spawn_blocking）
                // → 批量创建（统一 Stopped，旧 Connected 不直接恢复）→ 按
                // `enabled && autoStart` 策略显式启动（失败可见，不静默）。损坏/IO 失败
                // 保留原文件，仅可见报错（不阻断启动、不丢配置）。
                // I12-W5：同块打开凭据存储（W3）→ 接线 start 凭据解析器 → 加载后刷新
                // 实例 credential_ref/status（重启不丢凭据引用）。
                {
                    let state = app.state::<AppState>();
                    let store_path_slot = state.gateway_instance_store_path.clone();
                    let credentials_slot = state.gateway_credentials.clone();
                    let path = crate::paths::gateway_instances_path(&dirs);
                    if let Ok(mut slot) = store_path_slot.lock() {
                        *slot = Some(path.clone());
                    }
                    // I12-W5：打开加密凭据存储（密文/主密钥分目录；失败可见不阻断）。
                    // 施工文档 §7.3：路径解析失败 → credentials 槽位保持 None，禁止
                    // 回退 `PathBuf::new()`（避免相对当前目录误写 pylon-master.key）。
                    let credentials = {
                        let credentials_dir = crate::paths::credentials_dir(&dirs);
                        match crate::gateway::credentials::CredentialStore::open(&credentials_dir)
                        {
                            Ok(store) => Some(Arc::new(store)),
                            Err(error) => {
                                tracing::error!("凭据存储打开失败（set_credentials 不可用）：{error}");
                                None
                            }
                        }
                    };
                    if let Ok(mut slot) = credentials_slot.lock() {
                        *slot = credentials.clone();
                    }
                    let service = state.gateway_instances.clone();
                    let path_for_task = path.clone();
                    let credentials_for_refresh = credentials.clone();
                    tokio::spawn(async move {
                        let loaded = tokio::task::spawn_blocking(move || {
                            crate::gateway::instance_store::load_instances(&path_for_task)
                        })
                        .await;
                        match loaded {
                            Ok(Ok(instances)) => {
                                service.load_instances(instances).await;
                                tracing::info!("gateway 实例配置已加载：{}", path.display());
                                // I12-W5：重启恢复凭据引用（secret 不载入内存，仅标记）
                                if let Some(store) = credentials_for_refresh.as_ref() {
                                    let store = store.clone();
                                    service
                                        .refresh_credential_states(move |platform, id| {
                                            store.has_credentials(platform, id).unwrap_or(false)
                                        })
                                        .await;
                                }
                                // AC2：仅 enabled && autoStart 显式启动，失败可见（策略测试见
                                // instance.rs auto_start_instances）
                                service.auto_start_instances().await;
                            }
                            Ok(Err(error)) => tracing::error!(
                                "gateway 实例配置加载失败（保留原文件不覆盖）：{error}"
                            ),
                            Err(error) => {
                                tracing::error!("gateway 实例配置加载 task 失败：{error}");
                            }
                        }
                    });
                    // I12-W5：start 凭据解析器（factory.create 前从 CredentialStore 解析
                    // secret 填入 state；未配置 → None → factory 报 CredentialMissing）
                    {
                        let credentials_slot = state.gateway_credentials.clone();
                        state.gateway_instances.set_credential_resolver(Arc::new(
                            move |platform: &str, instance_id: &str| {
                                credentials_slot
                                    .lock()
                                    .ok()
                                    .and_then(|slot| slot.clone())
                                    .and_then(|store| {
                                        store.get_credentials(platform, instance_id).ok().flatten()
                                    })
                                    .map(|secret| secret.to_string())
                            },
                        ));
                    }
                    // QQ factory 注册（W2 已建；auto-start/手动 start 的凭据校验与连接循环入口）
                    let qq_http = match reqwest::Client::builder()
                        .connect_timeout(Duration::from_secs(10))
                        .timeout(Duration::from_secs(30))
                        .build()
                    {
                        Ok(client) => client,
                        Err(error) => {
                            tracing::warn!("Pylon gateway HTTP client unavailable: {error}");
                            reqwest::Client::new()
                        }
                    };
                    let factory = Arc::new(crate::gateway::qq::factory::QqAdapterFactory::new(
                        state.gateway.clone(),
                        qq_http,
                    ));
                    state.gateway_instances.register_factory(factory);
                    // route guard（W1 remove 的 route_in_use 检查）：任何 route 绑定引用
                    // 该 instance id → 拒绝 remove（D-04：route 保留 + disabled，不级联删除）。
                    {
                        let gateway = state.gateway.clone();
                        state.gateway_instances.set_route_guard(Arc::new(move |instance_id: &str| {
                            gateway
                                .routes()
                                .iter()
                                .any(|binding| binding.instance_id.as_deref() == Some(instance_id))
                        }));
                    }
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
                            // I12-W4：route 绑定强制（决策纯函数 resolve_ingest_agent，
                            // 正反用例见 route.rs 测试）——instance-bound route 必须指向
                            // 已连接实例：InstanceMissing/InstanceNotConnected → 显式错误
                            // + 丢弃，**禁止 fallback 到 active agent**（来源实例不可用却
                            // 按默认 agent 路由会造成错位回复）。Unbound（legacy 无
                            // instance_id）与无 binding 保持旧 fallback 行为（D-04）。
                            let binding_ref = resolved.binding.as_ref();
                            let bound_instance_id = binding_ref.and_then(|b| b.instance_id.as_deref());
                            let instance_status = match bound_instance_id {
                                Some(instance_id) => state
                                    .inner()
                                    .gateway_instances
                                    .status_of(instance_id)
                                    .await,
                                None => None,
                            };
                            let active_agent = state
                                .inner()
                                .active_agent
                                .lock()
                                .map(|v| v.clone())
                                .unwrap_or_default();
                            // I12 W9：unbound_policy 传入决策（reject 时无 binding 消息显式拒绝，
                            // 记录最小元数据，不进入 agent）
                            let unbound_policy = state.inner().gateway.unbound_policy();
                            let agent_id = match crate::gateway::route::resolve_ingest_agent(
                                binding_ref,
                                instance_status,
                                &active_agent,
                                unbound_policy,
                            ) {
                                Ok(id) => id,
                                Err(reason) => {
                                    tracing::error!(
                                        "gateway ingest 拒绝：route {} 绑定实例 {} 状态不可用（{:?}），禁止 fallback",
                                        resolved.source,
                                        bound_instance_id.unwrap_or(""),
                                        reason
                                    );
                                    return;
                                }
                            };
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
                                    profile_id: None,
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
                {
                    let app_for_watcher = app.handle().clone();
                    tokio::spawn(async move {
                        loop {
                            tokio::time::sleep(Duration::from_secs(60)).await;
                            let state = app_for_watcher.state::<AppState>();
                            check_session_expiry(state.inner()).await;
                        }
                    });
                }
                // 权限超时 watcher（ACP-03 §5.6）：每 5s 结算超时挂起请求并发出
                // permission.resolved terminal 事件——后端唯一计时/应答来源，前端
                // 只展示倒计时并提交选择，不自行宣称超时结果（invariant 5）。
                {
                    let app_for_watcher = app.handle().clone();
                    tokio::spawn(async move {
                        loop {
                            tokio::time::sleep(Duration::from_secs(5)).await;
                            let state = app_for_watcher.state::<AppState>();
                            let outcomes =
                                check_pending_permission_timeouts(state.inner()).await;
                            if outcomes.is_empty() {
                                continue;
                            }
                            let Some(window) = app_for_watcher.get_webview_window("main") else {
                                continue;
                            };
                            for outcome in outcomes {
                                emit_event(
                                    &window,
                                    crate::event_names::INTERACTION,
                                    serde_json::json!({
                                        "eventType": "permission.resolved",
                                        "agentId": outcome.agent_id,
                                        "sessionId": outcome.session_id,
                                        "requestId": outcome.request_id.to_string(),
                                        "clientGeneration": outcome.client_generation,
                                        "optionId": outcome.option_id,
                                        "reason": "timed_out",
                                    }),
                                );
                            }
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
