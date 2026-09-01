//! Phase D（R2-WI03，交接 §7）：provider-scoped 协议适配器注册表。
//!
//! 最小垂直切片：interaction request/response 的 classify / normalize / respond。
//! 当前内置 Peri 与 Hermes 适配器（wire 与既有
//! `parse_permission_request_with_generation` / `resolve_pending` 完全一致）；
//! 未注册 provider 由调用方明确返回 unsupported、
//! runtime-log 可观察，不生成 RPC（交接纪律：不生成未经实证的 Hermes/新 Agent response）。

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use crate::error::PylonError;
use crate::permission::{
    parse_permission_request_with_generation, resolve_permission, InteractionAnswerInput,
    InteractionIdentityInput, PendingPermission,
};
use crate::runtime::AgentRuntime;

/// interaction 请求分类结果（dispatcher 按此决定处理路径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InteractionClassification {
    /// interaction 请求（normalize 后挂起/发送）
    Interaction,
    /// 非 interaction 请求/通知（dispatcher 按既有语义继续/丢弃）
    NotInteraction,
}

/// The ACP client-request methods understood by the protocol boundary.
///
/// These names are the canonical wire spellings.  A few providers emit the
/// camelCase form; `looks_like_interaction_method` compares a compact key so
/// both forms are observed.  Keeping the list in one place also means the
/// diagnostics command and the dispatcher cannot silently drift apart.
pub(crate) const SUPPORTED_ACP_CLIENT_REQUEST_METHODS: &[&str] = &[
    "fs/write_text_file",
    "fs/read_text_file",
    "terminal/create",
    "terminal/output",
    "terminal/release",
    "terminal/wait_for_exit",
    "terminal/kill",
    "elicitation/create",
    "mcp/connect",
    "mcp/message",
    "mcp/disconnect",
    "session/request_permission",
    "session/request_question",
    "session/request_input",
    "session/request_user_input",
];

/// Read-only description of one ACP client request.  `responseMethod` is the
/// JSON-RPC response channel (all current entries are ordinary request/response
/// calls); it is intentionally explicit so a future notification-only method
/// cannot be mistaken for an actionable interaction.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SupportedInteraction {
    pub(crate) method: String,
    pub(crate) aliases: Vec<String>,
    pub(crate) kind: String,
    pub(crate) response_method: String,
}

/// Runtime adapter projection used by the diagnostics UI and support bundles.
/// `baseline` is the shared catalog claim; `adapterRegistered` and
/// `adapterMethods` are the actual process-local registry state.  The two are
/// deliberately separate because a provider may be capable in practice even
/// when its older shared catalog entry has not advertised that capability yet.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProtocolAdapterProvider {
    pub(crate) provider: String,
    pub(crate) display_name: String,
    pub(crate) catalog_known: bool,
    pub(crate) adapter_registered: bool,
    pub(crate) adapter_methods: Vec<String>,
    pub(crate) response_methods: Vec<String>,
    pub(crate) interaction_kinds: Vec<String>,
    pub(crate) baseline: Option<pylon_core::agent_catalog::CatalogProtocolProfile>,
    pub(crate) configured_agent_ids: Vec<String>,
}

/// Complete, read-only protocol capability catalog.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProtocolAdapterCatalog {
    pub(crate) schema_version: u32,
    pub(crate) recognized_methods: Vec<String>,
    pub(crate) supported_interactions: Vec<SupportedInteraction>,
    pub(crate) providers: Vec<ProtocolAdapterProvider>,
}

/// provider-scoped 协议适配器（R2-WI03 最小垂直切片）。
pub(crate) trait AgentProtocolAdapter: Send + Sync {
    /// 协议/实现类别（如 peri/hermes）。
    fn provider(&self) -> &'static str;
    /// Canonical methods handled by this adapter.  The default keeps third-party
    /// adapters source-compatible while allowing the diagnostics projection to
    /// report precise coverage for built-in adapters.
    fn interaction_methods(&self) -> &'static [&'static str] {
        &[]
    }
    /// JSON-RPC response methods emitted by this adapter.
    fn response_methods(&self) -> &'static [&'static str] {
        &[]
    }
    /// User-facing interaction kinds handled by this adapter.
    fn interaction_kinds(&self) -> &'static [&'static str] {
        &[]
    }
    /// 按 ACP method 名分类 interaction 请求。
    fn classify(&self, method: Option<&str>) -> InteractionClassification;
    /// normalize interaction 请求参数 → 统一挂起数据；None = 解析失败（调用方按
    /// protocol error 处理，ACP-04 §5.6：JSON-RPC error 应答，不伪造 optionId）。
    fn normalize_request(
        &self,
        params: Option<&serde_json::Value>,
        client_generation: u64,
    ) -> Option<PendingPermission>;
    /// 应答 interaction（kind/身份/选项校验 + 锁外发送）。
    fn respond_interaction<'a>(
        &'a self,
        runtime: &'a AgentRuntime,
        identity: &'a InteractionIdentityInput,
        kind: &'a str,
        answer: &'a InteractionAnswerInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), PylonError>> + Send + 'a>>;
}

/// request_permission 协议适配器（provider 参数化）：
/// 复用既有 request_permission 解析与 resolve_pending 应答核心（wire 不变）。
/// R2-WI06（Phase F 源码实证）：Peri 与 Hermes 的审批 wire 逐字段一致——
/// 均走 ACP `session/request_permission` + `RequestPermissionResponse` +
/// 同一 optionId 语义集，故同一实现按 provider 注册即可。
pub(crate) struct RequestPermissionAdapter {
    pub(crate) provider: &'static str,
}

impl AgentProtocolAdapter for RequestPermissionAdapter {
    fn provider(&self) -> &'static str {
        self.provider
    }

    fn interaction_methods(&self) -> &'static [&'static str] {
        &[crate::acp::METHOD_SESSION_REQUEST_PERMISSION]
    }

    fn response_methods(&self) -> &'static [&'static str] {
        &[crate::acp::METHOD_SESSION_REQUEST_PERMISSION]
    }

    fn interaction_kinds(&self) -> &'static [&'static str] {
        &["approval"]
    }

    fn classify(&self, method: Option<&str>) -> InteractionClassification {
        match method {
            Some(crate::acp::METHOD_SESSION_REQUEST_PERMISSION) => {
                InteractionClassification::Interaction
            }
            _ => InteractionClassification::NotInteraction,
        }
    }

    fn normalize_request(
        &self,
        params: Option<&serde_json::Value>,
        client_generation: u64,
    ) -> Option<PendingPermission> {
        parse_permission_request_with_generation(params, client_generation)
    }

    fn respond_interaction<'a>(
        &'a self,
        runtime: &'a AgentRuntime,
        identity: &'a InteractionIdentityInput,
        kind: &'a str,
        answer: &'a InteractionAnswerInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), PylonError>> + Send + 'a>> {
        Box::pin(respond_request_permission(
            self.provider(),
            runtime,
            identity,
            kind,
            answer,
        ))
    }
}

/// request_permission 应答核心（原 respond_interaction 命令主体；provider 查找上移到调用方）。
async fn respond_request_permission(
    provider: &str,
    runtime: &AgentRuntime,
    identity: &InteractionIdentityInput,
    kind: &str,
    answer: &InteractionAnswerInput,
) -> Result<(), PylonError> {
    if kind != "approval" {
        return Err(PylonError::Protocol(format!(
            "interaction response unsupported: provider={provider} kind={kind}"
        )));
    }
    let option_id = answer.option_id.clone().ok_or_else(|| {
        PylonError::Protocol("permission interaction requires optionId".to_string())
    })?;
    // ACP-01：前端回显为字符串——数字形态还原为 Number（命中原 numeric 请求），
    // 否则 String；最终 variant 由 pending 规范键决定（原 string-id 请求不被转数）。
    let candidate = crate::acp::RequestId::from_echo_string(&identity.request_id);
    let canonical_id = {
        let pending = runtime
            .pending_permissions
            .lock()
            .map_err(|e| e.to_string())?;
        let canonical_id = crate::permission::canonical_pending_key(&pending, &candidate)
            .ok_or_else(|| {
                PylonError::Protocol(format!(
                    "permission request not found: {}",
                    identity.request_id
                ))
            })?;
        let permission = pending.get(&canonical_id).ok_or_else(|| {
            PylonError::Protocol(format!(
                "permission request not found: {}",
                identity.request_id
            ))
        })?;
        if permission.session_id != identity.session_id
            || identity
                .tool_call_id
                .as_deref()
                .is_some_and(|id| id != permission.tool_call_id)
            || permission.client_generation != identity.client_generation
        {
            return Err(PylonError::Protocol(
                "stale interaction identity".to_string(),
            ));
        }
        canonical_id
    };
    let _ = (&answer.text, &answer.values);
    resolve_permission(runtime, canonical_id, &option_id).await
}

type AdapterRef = Arc<dyn AgentProtocolAdapter>;

static PROTOCOL_ADAPTERS: OnceLock<Mutex<HashMap<String, AdapterRef>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, AdapterRef>> {
    PROTOCOL_ADAPTERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_provider(provider: &str) -> String {
    provider.trim().to_lowercase()
}

/// Conservative interaction-method probe used by the dispatcher for requests that
/// are not part of the small, explicitly typed ACP enum yet.  ACP providers often
/// add approval/question/oauth methods before the host has a dedicated adapter.  We
/// must reject those requests explicitly (and answer their JSON-RPC id) without
/// accidentally treating ordinary session methods as user interactions.
pub(crate) fn looks_like_interaction_method(method: Option<&str>) -> bool {
    let Some(method) = method.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    if method == crate::acp::METHOD_SESSION_REQUEST_PERMISSION {
        return true;
    }

    // ACP's client-request surface contains interactions whose names do not
    // carry words such as `permission` or `question` (filesystem, terminal,
    // elicitation and MCP requests).  A provider may also serialize the same
    // method using camelCase (`terminal/waitForExit`).  Compare a compact,
    // separator/case-insensitive key against the official v1 client methods so
    // these requests are rejected/observed instead of silently dropped.
    let compact = method
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect::<String>();
    if SUPPORTED_ACP_CLIENT_REQUEST_METHODS
        .iter()
        .map(|candidate| {
            candidate
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .map(|ch| ch.to_ascii_lowercase())
                .collect::<String>()
        })
        .any(|candidate| candidate == compact)
    {
        return true;
    }
    let normalized = method
        .chars()
        .enumerate()
        .flat_map(|(index, ch)| {
            // Split camelCase before the keyword probe; otherwise
            // `requestPermission` becomes one opaque word.
            let boundary = index > 0 && ch.is_ascii_uppercase();
            [if boundary { ' ' } else { '\0' }, if ch.is_ascii_alphanumeric() { ch.to_ascii_lowercase() } else { ' ' }]
                .into_iter()
                .filter(|value| *value != '\0')
        })
        .collect::<String>();
    let words = normalized.split_whitespace().collect::<Vec<_>>();
    // `ask` is intentionally only accepted as a complete segment.  Matching a
    // substring would classify unrelated methods such as `task/list`.
    [
        "permission",
        "interaction",
        "approval",
        "approve",
        "question",
        "clarify",
        "confirm",
        "oauth",
        "authorize",
        "authorization",
        "ask",
    ]
    .iter()
    .any(|needle| words.iter().any(|word| word == needle))
}

/// 注册 provider 适配器（应用启动时；同 provider 重复注册覆盖）。
pub(crate) fn register_protocol_adapter(adapter: AdapterRef) {
    let _ = registry()
        .lock()
        .map(|mut adapters| adapters.insert(normalize_provider(adapter.provider()), adapter));
}

/// 按 provider 取适配器；未注册返回 None（调用方返回明确 unsupported，不生成 RPC）。
pub(crate) fn get_protocol_adapter(provider: &str) -> Option<AdapterRef> {
    registry()
        .lock()
        .ok()
        .and_then(|adapters| adapters.get(&normalize_provider(provider)).cloned())
}

/// Stable list used by both the dispatcher probe and the diagnostics command.
pub(crate) fn supported_interactions() -> Vec<SupportedInteraction> {
    SUPPORTED_ACP_CLIENT_REQUEST_METHODS
        .iter()
        .map(|method| SupportedInteraction {
            method: (*method).to_string(),
            aliases: vec![camel_case_method(method)],
            kind: if *method == crate::acp::METHOD_SESSION_REQUEST_PERMISSION {
                "approval".to_string()
            } else if method.starts_with("session/request_") {
                "user-input".to_string()
            } else {
                "client-request".to_string()
            },
            response_method: "json-rpc".to_string(),
        })
        .collect()
}

fn camel_case_method(method: &str) -> String {
    method
        .split('/')
        .map(|segment| {
            let mut chars = segment.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            let mut out = first.to_lowercase().collect::<String>();
            let mut uppercase_next = false;
            for ch in chars {
                if ch == '_' || ch == '-' {
                    uppercase_next = true;
                } else if uppercase_next {
                    out.extend(ch.to_uppercase());
                    uppercase_next = false;
                } else {
                    out.push(ch);
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn dedup_sorted(values: impl IntoIterator<Item = String>) -> Vec<String> {
    values.into_iter().collect::<BTreeSet<_>>().into_iter().collect()
}

/// Build the protocol catalog from the shared baseline, runtime registry, and
/// configured agent providers.  This pure-ish seam accepts a borrowed map so it
/// can be tested without creating a Tauri WebView or starting an ACP process.
pub(crate) fn build_protocol_adapter_catalog(
    configured_agents: Option<&HashMap<String, crate::agent_config::AgentDef>>,
) -> Result<ProtocolAdapterCatalog, String> {
    let baselines = pylon_core::agent_catalog::protocol_profiles()?;
    let baseline_by_provider = baselines
        .into_iter()
        .map(|profile| (normalize_provider(&profile.provider), profile))
        .collect::<BTreeMap<_, _>>();

    let registered = registry()
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .map(|adapter| {
            (
                normalize_provider(adapter.provider()),
                (
                    adapter.provider().to_string(),
                    adapter
                        .interaction_methods()
                        .iter()
                        .map(|method| (*method).to_string())
                        .collect::<Vec<_>>(),
                    adapter
                        .response_methods()
                        .iter()
                        .map(|method| (*method).to_string())
                        .collect::<Vec<_>>(),
                    adapter
                        .interaction_kinds()
                        .iter()
                        .map(|kind| (*kind).to_string())
                        .collect::<Vec<_>>(),
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();

    let mut configured_by_provider = BTreeMap::<String, Vec<String>>::new();
    if let Some(agents) = configured_agents {
        for (agent_id, agent) in agents {
            let provider = agent
                .provider
                .as_deref()
                .and_then(|value| (!value.trim().is_empty()).then(|| normalize_provider(value)))
                .or_else(|| {
                    std::path::Path::new(&agent.exe)
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .and_then(|stem| {
                            pylon_core::agent_catalog::provider_for_executable_stem(stem)
                                .ok()
                                .flatten()
                        })
                        .map(|value| normalize_provider(&value))
                });
            if let Some(provider) = provider {
                configured_by_provider
                    .entry(provider)
                    .or_default()
                    .push(agent_id.clone());
            }
        }
    }

    let providers = baseline_by_provider
        .keys()
        .chain(registered.keys())
        .chain(configured_by_provider.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let providers = providers
        .into_iter()
        .map(|provider| {
            let baseline = baseline_by_provider.get(&provider).cloned();
            let registered_entry = registered.get(&provider);
            let adapter_methods = registered_entry
                .map(|entry| dedup_sorted(entry.1.clone()))
                .unwrap_or_default();
            let adapter_response_methods = registered_entry
                .map(|entry| dedup_sorted(entry.2.clone()))
                .unwrap_or_default();
            let adapter_kinds = registered_entry
                .map(|entry| dedup_sorted(entry.3.clone()))
                .unwrap_or_default();
            let response_methods = dedup_sorted(
                baseline
                    .as_ref()
                    .map(|profile| profile.response_methods.clone())
                    .unwrap_or_default()
                    .into_iter()
                    .chain(adapter_response_methods),
            );
            let interaction_kinds = dedup_sorted(
                baseline
                    .as_ref()
                    .map(|profile| profile.interaction_kinds.clone())
                    .unwrap_or_default()
                    .into_iter()
                    .chain(adapter_kinds),
            );
            let display_name = baseline
                .as_ref()
                .map(|profile| profile.display_name.clone())
                .or_else(|| registered_entry.map(|entry| entry.0.clone()))
                .unwrap_or_else(|| provider.clone());
            let configured_agent_ids = configured_by_provider
                .get(&provider)
                .cloned()
                .unwrap_or_default();
            ProtocolAdapterProvider {
                provider,
                display_name,
                catalog_known: baseline.is_some(),
                adapter_registered: registered_entry.is_some(),
                adapter_methods,
                response_methods,
                interaction_kinds,
                baseline,
                configured_agent_ids,
            }
        })
        .collect::<Vec<_>>();

    let recognized_methods = dedup_sorted(
        SUPPORTED_ACP_CLIENT_REQUEST_METHODS
            .iter()
            .map(|method| (*method).to_string())
            .chain(
                providers
                    .iter()
                    .flat_map(|provider| provider.adapter_methods.iter().cloned()),
            ),
    );
    Ok(ProtocolAdapterCatalog {
        schema_version: 1,
        recognized_methods,
        supported_interactions: supported_interactions(),
        providers,
    })
}

/// Read-only Tauri command; no secrets or raw interaction params are returned.
#[tauri::command(rename_all = "camelCase")]
pub(crate) fn protocol_adapter_catalog(
    state: tauri::State<'_, crate::AppState>,
) -> Result<ProtocolAdapterCatalog, PylonError> {
    let agents = state
        .agents
        .lock()
        .map_err(|error| PylonError::Protocol(error.to_string()))?;
    build_protocol_adapter_catalog(Some(&agents)).map_err(PylonError::Protocol)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(provider: &str, request_id: &str) -> InteractionIdentityInput {
        InteractionIdentityInput {
            provider: provider.to_string(),
            agent_id: provider.to_string(),
            request_id: request_id.to_string(),
            session_id: "s1".to_string(),
            tool_call_id: None,
            client_generation: 0,
        }
    }

    #[test]
    fn registry_returns_only_registered_providers() {
        // 探测 provider 专用名——避免与 peri/hermes（run()/test_state_with_acp 注册、
        // 其他测试并发注册）冲突；本测试不调用全局 clear（防跨测试注册表 wipe 竞态）。
        register_protocol_adapter(Arc::new(RequestPermissionAdapter {
            provider: "test-probe",
        }));
        let adapter = get_protocol_adapter("test-probe").expect("注册的 provider 必须可取");
        assert_eq!(adapter.provider(), "test-probe");
        assert!(
            get_protocol_adapter("nope").is_none(),
            "未注册 provider 必须明确 unsupported"
        );
        assert!(
            get_protocol_adapter("TEST-PROBE").is_some(),
            "provider 查找必须大小写不敏感"
        );
    }

    #[test]
    fn hermes_adapter_reuses_request_permission_wire() {
        // R2-WI06（Phase F 源码实证）：Hermes 审批 wire 与 Peri 逐字段一致
        // （session/request_permission + RequestPermissionResponse + optionId 语义集），
        // 同一 request_permission 实现按 provider 注册即可。不调用全局 clear（防竞态）。
        register_protocol_adapter(Arc::new(RequestPermissionAdapter { provider: "hermes" }));
        let adapter = get_protocol_adapter("hermes").expect("hermes 适配器必须已注册");
        assert_eq!(adapter.provider(), "hermes");
        let params = serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "perm-check-1", "title": "edit"},
            "options": [{"optionId": "allow_once"}, {"optionId": "deny"}]
        });
        let permission = adapter
            .normalize_request(Some(&params), 5)
            .expect("hermes request_permission 必须按同款 wire 解析");
        assert_eq!(permission.session_id, "s1");
        assert_eq!(permission.tool_call_id, "perm-check-1");
        assert_eq!(
            permission.options,
            vec![
                crate::permission::PermissionOption::plain("allow_once"),
                crate::permission::PermissionOption::plain("deny"),
            ]
        );
    }

    #[test]
    fn peri_classifies_only_request_permission_as_interaction() {
        let adapter = RequestPermissionAdapter { provider: "peri" };
        assert_eq!(
            adapter.classify(Some(crate::acp::METHOD_SESSION_REQUEST_PERMISSION)),
            InteractionClassification::Interaction
        );
        assert_eq!(
            adapter.classify(Some("session/new")),
            InteractionClassification::NotInteraction
        );
        assert_eq!(
            adapter.classify(None),
            InteractionClassification::NotInteraction
        );
    }

    #[test]
    fn interaction_method_probe_is_conservative() {
        assert!(looks_like_interaction_method(Some("session/request_permission")));
        assert!(looks_like_interaction_method(Some("session/request_question")));
        assert!(looks_like_interaction_method(Some("claude/oauth/authorize")));
        // ACP client-request methods are interactions too, even though their
        // names do not contain the approval/question keywords.  Providers and
        // SDKs also emit camelCase spellings in a few extension envelopes.
        for method in [
            "fs/write_text_file",
            "fs/writeTextFile",
            "fs/readTextFile",
            "terminal/create",
            "terminal/waitForExit",
            "terminal/kill",
            "elicitation/create",
            "mcp/message",
            "session/requestPermission",
            "session/requestUserInput",
        ] {
            assert!(looks_like_interaction_method(Some(method)), "{method} should be observable as an interaction");
        }
        assert!(!looks_like_interaction_method(Some("session/new")));
        assert!(!looks_like_interaction_method(Some("task/list")));
        assert!(!looks_like_interaction_method(Some("terminal/status")));
        assert!(!looks_like_interaction_method(Some("filesystem/list")));
        assert!(!looks_like_interaction_method(None));
    }

    #[test]
    fn supported_interactions_has_canonical_and_camel_case_spellings() {
        let interactions = supported_interactions();
        let permission = interactions
            .iter()
            .find(|entry| entry.method == "session/request_permission")
            .expect("permission request must be catalogued");
        assert_eq!(permission.kind, "approval");
        assert!(permission
            .aliases
            .iter()
            .any(|alias| alias == "session/requestPermission"));
        assert!(interactions
            .iter()
            .any(|entry| entry.method == "terminal/wait_for_exit"));
    }

    #[test]
    fn protocol_catalog_separates_baseline_from_runtime_registration() {
        // Hermes' shared baseline intentionally says permissionRequests=false,
        // while the runtime registry has a proven request_permission adapter.
        register_protocol_adapter(Arc::new(RequestPermissionAdapter { provider: "hermes" }));
        let catalog = build_protocol_adapter_catalog(None).expect("catalog must build");
        let hermes = catalog
            .providers
            .iter()
            .find(|entry| entry.provider == "hermes")
            .expect("hermes baseline must be present");
        assert!(hermes.catalog_known);
        assert!(hermes.adapter_registered);
        assert_eq!(hermes.baseline.as_ref().map(|p| p.permission_requests), Some(false));
        assert!(hermes
            .adapter_methods
            .iter()
            .any(|method| method == "session/request_permission"));
        assert!(catalog
            .recognized_methods
            .iter()
            .any(|method| method == "fs/write_text_file"));
    }

    #[test]
    fn protocol_catalog_adds_configured_unknown_provider_without_secrets() {
        let mut agent = crate::test_utils::fake_acp_agent("custom", "print('x')");
        agent.provider = Some("Acme-ACP".to_string());
        let mut agents = HashMap::new();
        agents.insert("custom-agent".to_string(), agent);
        let catalog = build_protocol_adapter_catalog(Some(&agents)).expect("catalog must build");
        let custom = catalog
            .providers
            .iter()
            .find(|entry| entry.provider == "acme-acp")
            .expect("configured provider must be visible");
        assert!(!custom.catalog_known);
        assert!(!custom.adapter_registered);
        assert_eq!(custom.configured_agent_ids, vec!["custom-agent"]);
        let serialized = serde_json::to_value(custom).expect("provider projection serializes");
        assert!(serialized.get("exe").is_none(), "catalog must not expose executable paths");
        assert!(serialized.get("env").is_none(), "catalog must not expose environment values");
    }

    #[test]
    fn peri_normalize_reuses_permission_parser() {
        let adapter = RequestPermissionAdapter { provider: "peri" };
        let params = serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "call-1", "title": "t"},
            "options": [{"optionId": "allow_once"}, {"optionId": "reject_once"}]
        });
        let permission = adapter
            .normalize_request(Some(&params), 3)
            .expect("合法 request_permission 必须解析");
        assert_eq!(permission.session_id, "s1");
        assert_eq!(permission.tool_call_id, "call-1");
        assert_eq!(permission.client_generation, 3);
        assert_eq!(
            permission.options,
            vec![
                crate::permission::PermissionOption::plain("allow_once"),
                crate::permission::PermissionOption::plain("reject_once"),
            ]
        );
        assert!(
            adapter
                .normalize_request(Some(&serde_json::json!({"sessionId": "s"})), 0)
                .is_none(),
            "缺 options 必须解析失败（调用方按 protocol error 处理）"
        );
    }

    #[tokio::test]
    async fn peri_respond_rejects_non_approval_kind() {
        let runtime = AgentRuntime::new_disconnected();
        let answer = InteractionAnswerInput {
            option_id: Some("allow_once".to_string()),
            text: None,
            values: None,
        };
        let error = RequestPermissionAdapter { provider: "peri" }
            .respond_interaction(&runtime, &identity("peri", "7"), "clarify", &answer)
            .await
            .expect_err("非 approval kind 必须拒绝");
        assert!(
            error.to_string().contains("unsupported"),
            "kind 门禁文案必须含 unsupported，实际: {error}"
        );
    }

    #[tokio::test]
    async fn peri_respond_rejects_missing_option_id() {
        let runtime = AgentRuntime::new_disconnected();
        let answer = InteractionAnswerInput {
            option_id: None,
            text: None,
            values: None,
        };
        let error = RequestPermissionAdapter { provider: "peri" }
            .respond_interaction(&runtime, &identity("peri", "7"), "approval", &answer)
            .await
            .expect_err("approval 应答必须要求 optionId");
        assert!(
            error.to_string().contains("optionId"),
            "缺 optionId 必须明确报错，实际: {error}"
        );
    }
}
