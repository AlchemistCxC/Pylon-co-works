//! #106 P2：统一测试 harness——一步组装「无 UI 的整个产品运行」。
//!
//! boot(HarnessConfig) = mock App + mock window + TestStateBuilder AppState
//! （build_app_state 单一构造点）+ 假 agent AcpClient + 真实 dispatcher 事件泵
//! + in-memory EventService。证据收集三路：
//!
//! 1. `events()`——窗口 emit 捕获（前端可见事件面）
//! 2. `journal()`——in-memory EventService 回读（持久化事实面）
//! 3. `wire()`——AcpWireHub snapshot（raw wire 观测面）
//!
//! **temp 生存期**（决策 12）：[`TempPath`] 统一 pid+nanos 命名 + Drop 清理，
//! 断言失败路径不残留（回归锁 `temp_path_is_removed_on_drop`）。
//!
//! **时钟注入点**（决策 12 查证结论）：`Timestamp::now()` 在生产代码有 26 个
//! 散布调用点（session/dispatcher/pet 等），构造入口不收敛，强注入需改动生产
//! 代码——按 spec 预案**降级为编写约定**：新增涉及保留期/过期/重试间隔语义的
//! 测试优先注入 `Timestamp::new(毫秒)` 显式时刻（本模块 TempPath 同理），不调用
//! 真实时钟；确需真实时钟流逝的用 setInterval 轮询 + 显式 deadline。查证日期
//! 2026-09-16（`grep -c "Timestamp::now()"` = 26）。
//!
//! 仅 cfg(test) 编译；P5 抽离时经 `#[cfg(feature = "test-agent")] #[doc(hidden)]`
//! pub 门面暴露给 `tests/integration.rs`。

use crate::agent_config::AgentDef;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager};

/// 统一临时路径守卫：唯一命名（复用 test_utils::unique_temp）+ Drop 无条件清理。
pub(crate) struct TempPath(PathBuf);

impl TempPath {
    pub(crate) fn new(label: &str) -> Self {
        Self(crate::test_utils::unique_temp(label))
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        if self.0.is_dir() {
            std::fs::remove_dir_all(&self.0).ok();
        } else {
            std::fs::remove_file(&self.0).ok();
        }
    }
}

/// harness 装配配置（builder 形态；未覆盖项 = TestStateBuilder 生产同源默认值）。
/// P5 门面：外部 `tests/` 目标经 `pub` 方法消费；字段一律私有（不出 crate 内部类型）。
pub struct HarnessConfig {
    agent: Option<AgentDef>,
    approval_mode: String,
    gateway: Option<Arc<crate::gateway::GatewayCore>>,
    /// YAML 文本（`route::parse_config` 形态）——外部测试经它注入 gateway 配置。
    gateway_yaml: Option<String>,
}

impl HarnessConfig {
    pub fn new() -> Self {
        Self {
            agent: None,
            approval_mode: "default".to_string(),
            gateway: None,
            gateway_yaml: None,
        }
    }

    /// 注入 agent 定义并作为 active agent（连接由 [`TestHarness::boot`] 完成）。
    /// lib 内嵌测试用（AgentDef 为 crate 类型）；外部测试用 [`Self::with_fake_agent`]。
    pub(crate) fn with_agent(mut self, agent: AgentDef) -> Self {
        self.agent = Some(agent);
        self
    }

    /// P5 门面：经假 agent bin 场景旗标注入 agent（外部测试可命名形态）。
    pub fn with_fake_agent(mut self, name: &str, args: &[&str]) -> Self {
        self.agent = Some(crate::test_utils::fake_acp_agent(name, args));
        self
    }

    /// P5 门面：gateway 配置以 YAML 文本注入（内部 route::parse_config + from_config）。
    pub fn with_gateway_yaml(mut self, yaml: &str) -> Self {
        self.gateway_yaml = Some(yaml.to_string());
        self
    }

    #[allow(dead_code)]
    pub(crate) fn with_approval_mode(mut self, mode: impl Into<String>) -> Self {
        self.approval_mode = mode.into();
        self
    }

    #[allow(dead_code)]
    pub(crate) fn with_gateway(mut self, gateway: Arc<crate::gateway::GatewayCore>) -> Self {
        self.gateway = Some(gateway);
        self
    }

    /// 解析 gateway：显式实例 > YAML 文本 > None（boot 内再兜底 GatewayCore::new）。
    fn resolve_gateway(&self) -> Option<Arc<crate::gateway::GatewayCore>> {
        self.gateway.clone().or_else(|| {
            self.gateway_yaml.as_ref().map(|yaml| {
                Arc::new(crate::gateway::GatewayCore::from_config(
                    crate::gateway::route::parse_config(yaml)
                        .expect("gateway yaml must parse"),
                ))
            })
        })
    }
}

impl Default for HarnessConfig {
    fn default() -> Self {
        Self::new()
    }
}

/// 一步组装的产品运行现场：owned app + window + 三路证据收集器。
/// P5 门面：`tests/` 目标可直接构造与驱动；内部字段不出 crate。
pub struct TestHarness {
    app: tauri::App<tauri::test::MockRuntime>,
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    event_rx: std::sync::mpsc::Receiver<serde_json::Value>,
    /// agent 名 → wire hub（boot 时连接的 fake agent 注册于此）。
    wire_hubs: Arc<Mutex<std::collections::HashMap<String, Arc<crate::acp::AcpWireHub>>>>,
    /// P5 门面：register_qq_platform 注册的 QQ 适配器（handle_incoming 驱动用）。
    qq_adapter: Mutex<Option<Arc<crate::gateway::qq::QqAdapter>>>,
    _temp: Vec<TempPath>,
}

/// P5 门面：平台入站的窄值视图（只出值，不出 crate 内部类型引用）。
pub struct IngestView {
    pub source: String,
    pub agent_id: String,
    pub content: String,
}

impl TestHarness {
    /// boot：mock app → AppState（单一构造点）→ in-memory EventService →
    /// 假 agent 连接 → dispatcher 事件泵。任何一步失败即 panic（测试环境缺
    /// 前置属配置错误，早失败优于静默）。
    pub async fn boot(config: HarnessConfig) -> Self {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock webview must build");

        // 窗口事件捕获（证据一路）：boot 即挂关键事件面监听，先于任何驱动。
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        let captured_events = [
            crate::event_names::SESSION_UPDATE,
            crate::event_names::SESSION_DONE,
            crate::event_names::SESSION_ERROR,
            crate::event_names::USER_ECHO,
            crate::event_names::INTERACTION,
            crate::event_names::AGENT_STATUS,
            crate::event_names::AGENT_CRASHED,
        ];
        for event in captured_events {
            let event_tx = event_tx.clone();
            webview.listen(event, move |e| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                    let _ = event_tx.send(payload);
                }
            });
        }

        // run() 同源注册入口（协议适配器 + 能力消费者 + rustls provider）。
        crate::install_process_registrations();

        let mut wire_hubs = std::collections::HashMap::new();
        let state = if let Some(agent) = &config.agent {
            let client = crate::acp::AcpClient::connect_with_logs(agent, None)
                .await
                .expect("harness fake agent must initialize");
            wire_hubs.insert(
                agent.name.clone(),
                client
                    .wire_trace()
                    .expect("connected client exposes wire trace"),
            );
            // 与既有集成测试同语义：agent 入表 + runtime(acp=client) + active。
            let gateway = config.resolve_gateway().unwrap_or_else(|| {
                Arc::new(crate::gateway::GatewayCore::new())
            });
            crate::test_utils::test_state_with_acp(
                agent.clone(),
                client,
                gateway,
                crate::prism::PrismClient::unavailable("test".to_string()),
            )
            .await
        } else {
            let mut builder = crate::test_utils::TestStateBuilder::bare();
            if let Some(gateway) = config.resolve_gateway() {
                builder = builder.with_gateway(gateway);
            }
            builder.build()
        };
        // approval_mode 覆盖在 build 之后（build_app_state 只承载生产默认值）。
        *state.approval_mode.lock().expect("approval mode lock") = config.approval_mode;
        {
            let event_service =
                crate::session::EventService::in_memory().expect("in-memory event service");
            *state.event_service.lock().expect("event service slot") =
                Some(Arc::new(event_service));
        }
        app.manage(state);

        // dispatcher 事件泵（真实产品路径：崩溃通知/权限/交互的事件源）。
        if config.agent.is_some() {
            let handles =
                crate::AppStateHandles::from_state(app.state::<crate::AppState>().inner());
            if let Some(runtime) = handles.active_runtime() {
                crate::dispatcher::start_notification_dispatcher(
                    &handles,
                    &runtime,
                    webview.clone(),
                );
            }
        }

        Self {
            app,
            window: webview,
            event_rx,
            wire_hubs: Arc::new(Mutex::new(wire_hubs)),
            qq_adapter: Mutex::new(None),
            _temp: Vec::new(),
        }
    }

    // ── P5 门面：外部 tests/ 目标的驱动与观测面 ─────────────────────────────

    /// HTTP 桩（`test_utils::spawn_http_stub` 门面）：随机端口 + 按序应答 +
    /// 请求字节捕获。返回 `(地址, 请求接收端, 服务线程)`。
    pub fn http_stub(
        &self,
        responses: &'static [&'static [u8]],
    ) -> (
        std::net::SocketAddr,
        std::sync::mpsc::Receiver<Vec<u8>>,
        std::thread::JoinHandle<()>,
    ) {
        crate::test_utils::spawn_http_stub(responses)
    }

    /// 注册 QQ 平台适配器（测试构造：token + 桩地址，真实 HTTP 客户端）。
    pub fn register_qq_platform(&self, api_base_url: &str, token: &str) {
        let gateway = {
            let state = self.app.state::<crate::AppState>();
            state.gateway.clone()
        };
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("http client");
        let auth = Arc::new(crate::gateway::qq::auth::QqAuth::for_testing(token.to_string()));
        let adapter = crate::gateway::qq::QqAdapter::for_testing(
            gateway.clone(),
            http,
            auth,
            api_base_url.to_string(),
        );
        gateway.register(adapter.clone()).expect("register qq");
        *self.qq_adapter.lock().expect("qq adapter lock") = Some(adapter);
    }

    /// 平台消息入站驱动（去重 + 白名单 + ingest 解析），返回窄值视图。
    pub fn qq_handle_incoming(
        &self,
        source: &str,
        msg_id: &str,
        content: &str,
        member_openid: Option<&str>,
    ) -> Result<Option<IngestView>, String> {
        let adapter = self
            .qq_adapter
            .lock()
            .expect("qq adapter lock")
            .clone()
            .expect("register_qq_platform must be called first");
        let resolved = adapter.handle_incoming(source, msg_id, content, member_openid, None)?;
        Ok(resolved.map(|resolved| IngestView {
            source: resolved.source,
            agent_id: resolved
                .binding
                .as_ref()
                .map(|binding| binding.agent_id.clone())
                .unwrap_or_default(),
            content: resolved.content,
        }))
    }

    /// 接线 gateway ingest handler（镜像 run() setup 的绑定路由 + 发送链路：
    /// ingest → agent runtime → send_prompt_core）。
    pub fn wire_gateway_ingest(&self) {
        use crate::session::send_prompt_core;
        let app_handle = self.app.handle().clone();
        let window = self.window.as_ref().window().clone();
        let state = self.app.state::<crate::AppState>();
        state.gateway.set_ingest_handler(Arc::new(
            move |resolved: &crate::gateway::ResolvedIngest| {
                let app = app_handle.clone();
                let window = window.clone();
                let resolved = resolved.clone();
                tokio::spawn(async move {
                    let state = app.state::<crate::AppState>();
                    let agent_id = resolved
                        .binding
                        .as_ref()
                        .map(|binding| binding.agent_id.clone())
                        .unwrap_or_default();
                    let runtime = state.inner().runtimes.get_or_create(&agent_id);
                    if let Err(error) = send_prompt_core(
                        state.inner(),
                        &runtime,
                        Some(&window),
                        &state.gateway,
                        &crate::session::PromptContext {
                            source: resolved.source.clone(),
                            profile_id: None,
                            content: resolved.content.clone(),
                            persona: String::new(),
                            session_prompt: None,
                            attachments: None,
                            mcp_servers: None,
                            cwd: None,
                            known_peri_id: None,
                        },
                    )
                    .await
                    {
                        tracing::warn!("ingest send failed: {error}");
                    }
                });
            },
        ));
    }

    /// 轮询等待 active runtime 建立平台会话映射（ingest 链路通的证据）。
    pub async fn wait_for_platform_session(&self, source: &str, seconds: u64) {
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(seconds);
        loop {
            let has = self
                .app
                .state::<crate::AppState>()
                .inner()
                .active_runtime()
                .map(|runtime| {
                    runtime
                        .sessions
                        .lock()
                        .map(|sessions| sessions.contains_key(source))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if has {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "平台会话 {source} 必须在 {seconds}s 内建立"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// 已连接 agent 的 runtime（状态检视：generation/status/sessions）。
    pub(crate) fn runtime(&self, agent_id: &str) -> Option<Arc<crate::runtime::AgentRuntime>> {
        self.state().runtimes.get(agent_id)
    }

    /// AppState 借用（生命周期由 self.app 持有）。
    pub(crate) fn state(&self) -> tauri::State<'_, crate::AppState> {
        self.app.state::<crate::AppState>()
    }

    /// 主窗口（驱动 command 所需的事件面参数）。
    pub(crate) fn window(&self) -> &tauri::WebviewWindow<tauri::test::MockRuntime> {
        &self.window
    }

    /// 证据一路：窗口事件捕获 channel 的当前快照（非阻塞 drain）。
    pub(crate) fn events(&self) -> Vec<serde_json::Value> {
        let mut drained = Vec::new();
        while let Ok(payload) = self.event_rx.try_recv() {
            drained.push(payload);
        }
        drained
    }

    /// 证据二路：in-memory journal 回读（owner key = 序列化后的身份三元组）。
    pub(crate) async fn journal(&self, owner_key: &str) -> Vec<crate::session::CanonicalEventRow> {
        let state = self.state();
        let service = state
            .event_service
            .lock()
            .expect("event service slot")
            .clone();
        let service = service.expect("boot installed in-memory event service");
        service
            .list_events(owner_key.to_string(), None, 100)
            .await
            .expect("journal readback")
            .events
    }

    /// 证据三路：AcpWireHub snapshot（raw wire 观测）。
    pub(crate) fn wire(&self, agent_id: &str) -> Vec<crate::acp::WireRecord> {
        self.wire_hubs
            .lock()
            .expect("wire hubs lock")
            .get(agent_id)
            .map(|hub| hub.snapshot())
            .unwrap_or_default()
    }

    /// temp 路径登记进 harness（Drop 随 harness 清理）。
    #[allow(dead_code)]
    pub(crate) fn temp_path(&mut self, label: &str) -> PathBuf {
        let temp = TempPath::new(label);
        let path = temp.path().to_path_buf();
        self._temp.push(temp);
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验收 19（temp 生存期）：harness TempPath 清理后路径不存在。
    #[test]
    fn temp_path_is_removed_on_drop() {
        let path = {
            let temp = TempPath::new("harness-lifetime");
            std::fs::write(temp.path(), b"payload").expect("write temp");
            assert!(temp.path().exists());
            temp.path().to_path_buf()
        };
        assert!(!path.exists(), "Drop 必须清理 temp 路径");
    }

    /// 验收 7（harness 冒烟）：boot → 假 agent prompt → journal 落盘 +
    /// 窗口事件 + wire snapshot 三路断言贯通。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn boot_prompt_produces_journal_events_and_wire_evidence() {
        use crate::acp::METHOD_SESSION_NEW;

        let agent = crate::test_utils::fake_acp_agent(
            "harness-smoke",
            &["--scenario", "stream", "--session-id", "harness-session"],
        );
        let harness = TestHarness::boot(HarnessConfig::new().with_agent(agent)).await;
        let state = harness.state();
        let window = harness.window().clone();

        // 经真实 command 入口建会话（session/new 上 wire + SessionInfo 记账）。
        let created = crate::session::new_session(
            state.clone(),
            "harness-smoke".to_string(),
            "local:harness-smoke".to_string(),
            "profile-harness".to_string(),
            "persona".to_string(),
            Some(".".to_string()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("session must be created");
        assert_eq!(
            created["sessionId"], "harness-session",
            "假 agent 的 sessionId 必须回显"
        );

        // 经 send_message 驱动一次完整 prompt（真实产品路径：journal + 事件 + wire）。
        crate::session::send_message(
            state.clone(),
            window.as_ref().window().clone(),
            "harness-smoke".to_string(),
            "local:harness-smoke".to_string(),
            Some("profile-harness".to_string()),
            "harness prompt".to_string(),
            String::new(),
            None,
            None,
            None,
            None,
        )
        .await
        .expect("prompt must settle");

        // 证据三路·wire：session/new 与 session/prompt 都在 raw wire 上。
        let wire = harness.wire("harness-smoke");
        assert!(
            wire.iter()
                .any(|record| record.method.as_deref() == Some(METHOD_SESSION_NEW)),
            "session/new 必须出现在 wire 证据中"
        );
        assert!(
            wire.iter()
                .any(|record| record.method.as_deref() == Some("session/prompt")),
            "session/prompt 必须出现在 wire 证据中"
        );

        // 证据二路·journal：authoritative user 事实行落盘。
        let owner =
            serde_json::to_string(&["profile-harness", "harness-smoke", "local:harness-smoke"])
                .expect("owner key");
        let journal = harness.journal(&owner).await;
        assert!(
            journal
                .iter()
                .any(|event| event.event_type == "user.message"),
            "journal 必须含 user.message（实际: {:?}）",
            journal
                .iter()
                .map(|event| event.event_type.clone())
                .collect::<Vec<_>>()
        );

        // 证据一路·窗口事件：前端可见面已有捕获（stream 场景必有 chunk/done）。
        let events = harness.events();
        assert!(
            !events.is_empty(),
            "窗口事件证据不得为空（stream 场景至少发一条 chunk + done）"
        );

        // 状态检视面：runtime 仍挂 Harness 上可用。
        assert!(
            harness.runtime("harness-smoke").is_some(),
            "runtime 检视面必须可用"
        );
    }
}
