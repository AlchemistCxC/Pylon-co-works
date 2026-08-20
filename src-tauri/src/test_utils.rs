//! 共享测试基建（R5c + G5-1）：fake ACP 子进程 agent 构造 + AppState 测试构造 builder。
//!
//! 消除 acp.rs 测试（14 块 AgentDef 字面量）与 lib.rs 集成测试（auto_reconnect /
//! b11 inject / gateway 平台测试）之间的重复构造；AppState 字面量（10 处）与
//! build_state_with 包装（4 份）收敛到 TestStateBuilder。仅 cfg(test) 编译。

use crate::acp::AcpClient;
use crate::agent_config::AgentDef;
use crate::gateway::GatewayCore;
use crate::prism::PrismClient;
use crate::runtime::{AgentRuntime, AgentRuntimeManager};
use crate::AppState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

/// 探测结果进程级缓存：`py -3 --version` 探测本身有子进程启动开销，单测多次
/// 构造 agent 时只探测一次（once 惰性求值，无副作用）。
static TEST_PYTHON_EXE: OnceLock<String> = OnceLock::new();

/// 探测测试用 python 解释器：`PYLON_TEST_PYTHON`（显式覆盖，命中即用）→
/// `python` → `py -3` → `python3`（Windows 下 `py -3` 比裸 `python` 更可靠；
/// 链式兜底保证跨平台可用）。全部不可用时回落 `python`（保持原有报错行为，
/// 由子进程启动失败显式暴露）。
pub(crate) fn test_python_exe() -> &'static str {
    TEST_PYTHON_EXE.get_or_init(probe_test_python).as_str()
}

fn probe_test_python() -> String {
    if let Ok(custom) = std::env::var("PYLON_TEST_PYTHON") {
        if !custom.trim().is_empty() {
            return custom;
        }
    }
    ["python", "py -3", "python3"]
        .into_iter()
        .find(|candidate| python_available(candidate))
        .unwrap_or("python")
        .to_string()
}

/// 探测 candidate（`py -3` 形式按空白拆 program + args）能否成功执行 --version。
fn python_available(candidate: &str) -> bool {
    let mut parts = candidate.split_whitespace();
    let Some(program) = parts.next() else {
        return false;
    };
    let mut command = std::process::Command::new(program);
    command.args(parts).arg("--version");
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// 构造 fake ACP 子进程 agent：`python -u -c <script>`，无额外参数与环境。
pub(crate) fn fake_acp_agent(name: &str, script: &str) -> AgentDef {
    fake_acp_agent_with(name, script, Vec::new(), HashMap::new())
}

/// 构造 fake ACP 子进程 agent：`python -u -c <script> [extra_args...]` + 自定义环境。
/// extra_args 通常携带 trace 文件路径（fake 脚本把收到的请求逐行写入，测试回读断言）。
pub(crate) fn fake_acp_agent_with(
    name: &str,
    script: &str,
    extra_args: Vec<String>,
    env: HashMap<String, String>,
) -> AgentDef {
    let mut args = vec!["-u".to_string(), "-c".to_string(), script.to_string()];
    args.extend(extra_args);
    AgentDef {
        name: name.to_string(),
        provider: None,
        transport: "subprocess".to_string(),
        exe: test_python_exe().to_string(),
        args,
        cwd: None,
        env,
        default: false,
        set_model_api: false,
        model: None,
        hermes_profile: None,
        acp_args: Vec::new(),
        acp: None,
    }
}

// ── AppState 测试构造 builder（G5-1）──

/// AppState 测试构造 builder（G5-1）：收敛 10 处测试字面量 + 4 份 build_state_with。
///
/// # 默认值纪律（E18）
/// 本 builder 的默认值 = `lib.rs run()` 生产构造现值（lib.rs:2602-2616）与既有
/// 测试字面量并集：runtimes 空表 / agents 空表 / active_agent="ghost-agent" /
/// pet=PetState::default() / runtime_logs 新建 / runtime_mcp=None /
/// prism=PrismClient::unavailable("test") / gateway=GatewayCore::new() /
/// approval_mode="default" / 三把锁新建（G6-07b：pet_last_persist_ms 已删，写盘自愈归后台任务）。
/// **AppState 增加字段时必须同步本 builder**——字面量构造点会编译失败强制同步，
/// 而 builder 需手工同步（纪律登记：后端手册 §2.1；E18 封闭）。
pub(crate) struct TestStateBuilder {
    runtimes: Arc<AgentRuntimeManager>,
    agents: Arc<Mutex<HashMap<String, AgentDef>>>,
    active_agent: String,
    prism: PrismClient,
    gateway: Arc<GatewayCore>,
    startup: Arc<RwLock<crate::startup::StartupDiagnostics>>,
    approval_mode: String,
    workspaces: Arc<Mutex<HashMap<String, crate::workspaces::Workspace>>>,
    data_dirs: Arc<OnceLock<crate::paths::DataDirs>>,
}

impl TestStateBuilder {
    /// 裸状态：空 runtimes/agents，active_agent="ghost-agent"
    /// （替代 session.rs:1911 / workspace_cmds.rs:112 / lib.rs:1966 字面量；
    /// lib.rs:1966 用 `.with_active_agent("")` 覆盖）。
    pub(crate) fn bare() -> Self {
        Self {
            runtimes: Arc::new(AgentRuntimeManager::new()),
            agents: Arc::new(Mutex::new(HashMap::new())),
            active_agent: "ghost-agent".to_string(),
            prism: PrismClient::unavailable("test".to_string()),
            gateway: Arc::new(GatewayCore::new()),
            startup: Arc::new(RwLock::new(
                crate::startup::StartupDiagnostics::test_default(),
            )),
            approval_mode: "default".to_string(),
            workspaces: Arc::new(Mutex::new(HashMap::new())),
            data_dirs: Arc::new(OnceLock::new()),
        }
    }

    pub(crate) fn with_active_agent(mut self, id: impl Into<String>) -> Self {
        self.active_agent = id.into();
        self
    }

    /// 入 agents 表（键 = AgentDef.name，与 `test_state_with_acp` 同语义）。
    pub(crate) fn with_agent(self, def: AgentDef) -> Self {
        self.agents.lock().unwrap().insert(def.name.clone(), def);
        self
    }

    pub(crate) fn with_runtime(self, id: impl Into<String>, runtime: Arc<AgentRuntime>) -> Self {
        self.runtimes.insert(id.into(), runtime);
        self
    }

    pub(crate) fn with_prism(mut self, prism: PrismClient) -> Self {
        self.prism = prism;
        self
    }

    pub(crate) fn with_gateway(mut self, gateway: Arc<GatewayCore>) -> Self {
        self.gateway = gateway;
        self
    }

    /// CWD-03：注入 Workspace 实体（root 解析链迁移测试用）。
    pub(crate) fn with_workspace(self, workspace: crate::workspaces::Workspace) -> Self {
        self.workspaces
            .lock()
            .unwrap()
            .insert(workspace.id.clone(), workspace);
        self
    }

    pub(crate) fn with_approval_mode(mut self, mode: impl Into<String>) -> Self {
        self.approval_mode = mode.into();
        self
    }

    /// 施工文档 §2.3：注入本次启动的 DataDirs（路径消费者测试用）。
    pub(crate) fn with_data_dirs(self, dirs: crate::paths::DataDirs) -> Self {
        let _ = self.data_dirs.set(dirs);
        self
    }

    /// 同步构造（AppState 无 async 字段）；未覆盖字段全默认（E18 纪律见结构体文档）。
    pub(crate) fn build(self) -> AppState {
        AppState {
            runtimes: self.runtimes,
            agents: self.agents,
            active_agent: Arc::new(Mutex::new(self.active_agent)),
            pet: Arc::new(Mutex::new(crate::pet::PetState::default())),
            runtime_logs: crate::runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism: self.prism,
            gateway: self.gateway,
            startup: self.startup,
            approval_mode: Arc::new(Mutex::new(self.approval_mode)),
            pet_write_lock: tokio::sync::Mutex::new(()),
            switch_lock: tokio::sync::Mutex::new(()),
            mcp_write_lock: tokio::sync::Mutex::new(()),
            config_write_lock: tokio::sync::Mutex::new(()),
            browser: Arc::new(crate::browser::BrowserManager::new()),
            // E18 纪律：默认值 = run() 现值（mcp_wire 初始 None）。
            mcp_wire: Mutex::new(None),
            frontend_log_throttle: Mutex::new(crate::runtime_log::FrontendLogThrottle::default()),
            // I14-W1 机械后果：AppState 新字段默认 None（与 run() 一致，setup 填充）。
            message_service: Arc::new(Mutex::new(None)),
            // I14-W5 机械后果：AppState 新字段默认 None（与 run() 一致，setup 填充）。
            user_data_service: Arc::new(Mutex::new(None)),
            // M3 EVT-02 机械后果：canonical 事件仓库槽位默认 None（与 run() 一致，setup 填充）。
            event_service: Arc::new(Mutex::new(None)),
            // I12-W4 机械后果：gateway 实例服务默认空 registry，store 路径 None（测试不落盘）。
            gateway_instances: crate::gateway::instance::GatewayInstanceService::new(),
            gateway_instance_store_path: Arc::new(Mutex::new(None)),
            // I12-W5 机械后果：凭据存储槽位默认 None（测试可注入临时目录 CredentialStore）。
            gateway_credentials: Arc::new(Mutex::new(None)),
            // CWD-03 机械后果：Workspace 注册表默认空（测试经 with_workspace 注入）。
            workspaces: self.workspaces,
            // 施工文档 §2.3 机械后果：数据目录槽位默认空（测试经 with_data_dirs 注入）。
            data_dirs: self.data_dirs,
            plugin_processes: Arc::new(crate::plugin_process::PluginProcessSupervisor::default()),
            pylon_cli: Arc::new(crate::pylon_cli::PylonCliBridge::default()),
        }
    }
}

/// 带已连接 ACP 客户端的 state（替代 4 份 build_state_with）：
/// agent 入表（键 = agent.name）+ runtime(acp=initial_acp) 入 runtimes +
/// active_agent=agent.name；其余字段全默认。
/// async 原因：acp 注入需要 tokio Mutex（`runtime.acp`）。
pub(crate) async fn test_state_with_acp(
    agent: AgentDef,
    initial_acp: AcpClient,
    gateway: Arc<GatewayCore>,
    prism: PrismClient,
) -> AppState {
    // P0-3（R2-WI03）+ R2-WI06：镜像 run() 的协议适配器注册（单测进程不执行 run()）——
    // request_permission 走 provider-scoped adapter dispatch 必需；幂等覆盖。
    crate::protocol_adapter::register_protocol_adapter(std::sync::Arc::new(
        crate::protocol_adapter::RequestPermissionAdapter { provider: "peri" },
    ));
    crate::protocol_adapter::register_protocol_adapter(std::sync::Arc::new(
        crate::protocol_adapter::RequestPermissionAdapter { provider: "hermes" },
    ));
    let runtime = AgentRuntime::new_disconnected();
    *runtime.acp.lock().await = initial_acp;
    TestStateBuilder::bare()
        .with_agent(agent.clone())
        .with_runtime(agent.name.clone(), runtime)
        .with_active_agent(agent.name)
        .with_gateway(gateway)
        .with_prism(prism)
        .build()
}

/// Connected 状态 runtime（替代 lifecycle.rs:621-625 / 686-689 内联状态赋值）。
pub(crate) fn connected_runtime() -> Arc<AgentRuntime> {
    let runtime = AgentRuntime::new_disconnected();
    *runtime.agent_runtime.lock().unwrap() = crate::agent_runtime::AgentRuntimeState {
        status: crate::agent_runtime::AgentLifecycleStatus::Connected,
        last_error: None,
        last_connected_at: None,
    };
    runtime
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn builder_bare_defaults_match_run_construction() {
        let state = TestStateBuilder::bare().build();
        assert_eq!(&*state.active_agent.lock().unwrap(), "ghost-agent");
        assert!(state.agents.lock().unwrap().is_empty());
        assert!(state.runtimes.all().is_empty());
        assert_eq!(&*state.approval_mode.lock().unwrap(), "default");
        assert!(state.runtime_mcp.lock().unwrap().is_none());
        assert_eq!(
            state.prism.status().await["status"],
            "configuration_error",
            "默认 prism 必须为 unavailable(\"test\")（与既有测试字面量一致）"
        );
    }

    #[test]
    fn builder_with_chain_registers_agent_runtime_and_overrides() {
        let def = fake_acp_agent("peri", "print('x')");
        let runtime = connected_runtime();
        let gateway = Arc::new(GatewayCore::new());
        let state = TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(def)
            .with_runtime("peri", runtime.clone())
            .with_gateway(gateway.clone())
            .with_approval_mode("auto")
            .build();
        assert_eq!(&*state.active_agent.lock().unwrap(), "peri");
        assert_eq!(&*state.approval_mode.lock().unwrap(), "auto");
        assert!(Arc::ptr_eq(&state.gateway, &gateway));
        assert!(state.agents.lock().unwrap().contains_key("peri"));
        assert!(Arc::ptr_eq(&state.runtimes.get("peri").unwrap(), &runtime));
        assert_eq!(
            state
                .runtimes
                .get("peri")
                .unwrap()
                .agent_runtime
                .lock()
                .unwrap()
                .status,
            crate::agent_runtime::AgentLifecycleStatus::Connected,
            "connected_runtime 必须置 Connected"
        );
    }

    #[tokio::test]
    async fn test_state_with_acp_injects_client_and_sets_active() {
        let agent = fake_acp_agent("fake-acp", "print('x')");
        let initial_acp = AcpClient::disconnected();
        initial_acp
            .crashed
            .store(true, std::sync::atomic::Ordering::Release);
        let gateway = Arc::new(GatewayCore::new());
        let state = test_state_with_acp(
            agent.clone(),
            initial_acp,
            gateway.clone(),
            PrismClient::unavailable("test".to_string()),
        )
        .await;
        assert_eq!(&*state.active_agent.lock().unwrap(), "fake-acp");
        assert!(state.agents.lock().unwrap().contains_key("fake-acp"));
        assert!(Arc::ptr_eq(&state.gateway, &gateway));
        let runtime = state.runtimes.get("fake-acp").expect("runtime 必须注册");
        assert!(
            runtime.acp.lock().await.is_crashed(),
            "注入的 AcpClient 必须挂在 runtime.acp 上（新建 disconnected 默认未崩溃）"
        );
    }
}

/// 通用 HTTP 测试桩：绑定随机端口，按序消费响应字节序列。
///
/// 收敛 prism.rs / gateway/qq/send.rs 等测试中重复的
/// `TcpListener::bind(127.0.0.1:0) → thread::spawn(accept → read → write_all)`
/// 样板。返回 `(socket_addr, 请求字节捕获 channel, 服务线程 join handle)`。
///
/// 语义：
/// - 按 `responses` 顺序每个请求回一个响应；响应耗尽后其余请求收到空响应（测试
///   不应依赖，计数断言用请求 channel）。
/// - 每个已接受连接单次读缓冲（不等到 EOF，避免 keep-alive 连接阻塞）后写入对应
///   响应，再关闭。与历史 qq `spawn_sequence_server` 语义一致。
/// - 请求字节原文通过 `request_rx` 捕获（供断言请求形状），连接数即请求数。
pub(crate) fn spawn_http_stub(
    responses: &'static [&'static [u8]],
) -> (
    std::net::SocketAddr,
    std::sync::mpsc::Receiver<Vec<u8>>,
    std::thread::JoinHandle<()>,
) {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    let address = listener.local_addr().expect("listener address");
    let (request_tx, request_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = match listener.accept() {
                Ok(accepted) => accepted,
                Err(_) => return,
            };
            let mut buffer = [0_u8; 4096];
            let mut bytes = Vec::new();
            match stream.read(&mut buffer) {
                Ok(count) if count > 0 => bytes.extend_from_slice(&buffer[..count]),
                _ => {}
            }
            let _ = request_tx.send(bytes);
            let _ = stream.write_all(response);
        }
    });
    (address, request_rx, server)
}
