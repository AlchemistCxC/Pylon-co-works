//! 网关状态/热重载命令（R1 拆分自 lib.rs；行为零变化）。

use serde::Serialize;

use crate::agent_config;
use crate::error::PylonError;
use crate::gateway::instance::{
    AdapterInstance, CreateInstanceInput, GatewayInstanceError, UpdateInstanceInput,
};
use crate::gateway::instance_store::StoredInstance;
use crate::AppState;

/// 平台会话行（后端施工计划书 Phase 2 §4.1 最小 DTO）。
/// 只暴露必要字段：不携带 cwd/token/persona/config_options/回复缓存；
/// periId 是实际 ACP session id，session_key 是静态路由配置值，二者不同不得混淆。
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewaySessionRow {
    /// 会话所在 runtime 的 agent id（all_with_ids 键）。
    pub(crate) agent_id: String,
    pub(crate) source: String,
    /// 实际 ACP session id（SessionInfo.peri_id）。
    pub(crate) peri_id: String,
    pub(crate) title: String,
    pub(crate) model: String,
    pub(crate) mode: Option<String>,
    /// Timestamp wire 规则（毫秒字符串）；缺失为 null。
    pub(crate) updated_at: Option<String>,
    /// 静态路由 reset 策略（缺省有效值 idle）。
    pub(crate) reset: String,
    pub(crate) allow_from: Option<Vec<String>>,
    pub(crate) idle_minutes: Option<u64>,
}

/// 聚合平台会话（意见稿 §4）：遍历全部 runtime 快照 sessions，仅纳入
/// `gateway.binding(source)` 命中的实际会话（不以 is_platform_source 为准——
/// 已注册 adapter 会让整个平台前缀命中而无对应绑定）；锁中毒按协议错误返回
/// （避免 UI 误判"无会话"）；输出按 (agentId, source, periId) 稳定排序。
pub(crate) fn collect_gateway_sessions(
    state: &AppState,
) -> Result<Vec<GatewaySessionRow>, PylonError> {
    let mut rows: Vec<GatewaySessionRow> = Vec::new();
    for (agent_id, runtime) in state.runtimes.all_with_ids() {
        let sessions = runtime
            .sessions
            .lock()
            .map_err(|e| PylonError::Protocol(e.to_string()))?;
        for (source, info) in sessions.iter() {
            let Some(binding) = state.gateway.binding(source) else {
                continue;
            };
            rows.push(GatewaySessionRow {
                agent_id: agent_id.clone(),
                source: source.clone(),
                peri_id: info.peri_id.clone(),
                title: info.title.clone(),
                model: info.model.clone(),
                mode: info.mode.clone(),
                updated_at: info.updated_at.map(|t| t.to_string()),
                reset: binding.reset.clone().unwrap_or_else(|| "idle".to_string()),
                allow_from: binding.allow_from.clone(),
                idle_minutes: binding.idle_minutes,
            });
        }
    }
    rows.sort_by(|a, b| {
        a.agent_id
            .cmp(&b.agent_id)
            .then(a.source.cmp(&b.source))
            .then(a.peri_id.cmp(&b.peri_id))
    });
    Ok(rows)
}

/// 平台会话列表（只读快照；不触发 session load/reset/gateway reload/ACP RPC）。
#[tauri::command]
pub(crate) async fn gateway_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<GatewaySessionRow>, PylonError> {
    collect_gateway_sessions(state.inner())
}

/// 平台 catalog（只读；I12-A-BE-01 契约冻结，D-01）：平台类型能力描述，
/// 与实例分离；凭据字段只描述不携带值（D-02）。未实现平台状态稳定（不可启用）。
/// I12-W4：命令已注册（lib.rs invoke_handler）。
#[tauri::command]
pub(crate) async fn gateway_catalog(
) -> Result<Vec<crate::gateway::catalog::AdapterCatalogItem>, PylonError> {
    Ok(crate::gateway::catalog::builtin_catalog())
}

// ============================================================================
// I12-W4：实例管理命令（typed IPC）。
// mutation（create/update/remove）后把非敏感配置持久化到 instance store——持久化
// 失败如实报错（mutation 已生效于内存但未落盘，重启会丢，不得静默）；路径未配置
// （测试）→ 跳过持久化（内存态仍生效）。状态（start/stop/restart）是运行时数据
// 不落盘；remove 由 route guard 检查 route_in_use（D-04：route 保留 + disabled）。
// 核心逻辑实现为取 &AppState 的普通 async fn（与 collect_gateway_sessions 同风格），
// #[tauri::command] 包装仅一行委托——便于无 tauri State 的测试直达逻辑。
// ============================================================================

/// 把当前实例列表（非敏感配置部分）持久化到 store；路径未配置 → 跳过。
/// fs 写经 spawn_blocking；失败 → [`GatewayInstanceError::Store`]。
pub(crate) async fn persist_instance_store(state: &AppState) -> Result<(), GatewayInstanceError> {
    let path = state
        .gateway_instance_store_path
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    let Some(path) = path else {
        return Ok(());
    };
    let stored: Vec<StoredInstance> = state
        .gateway_instances
        .list()
        .await
        .into_iter()
        .map(|dto| StoredInstance {
            id: dto.id,
            platform: dto.platform,
            label: dto.label,
            enabled: dto.enabled,
            auto_start: dto.auto_start,
        })
        .collect();
    let path_for_task = path.clone();
    tokio::task::spawn_blocking(move || {
        crate::gateway::instance_store::persist_instances(&path_for_task, &stored)
    })
    .await
    .map_err(|error| GatewayInstanceError::Store(format!("persist task failed: {error}")))?
    .map_err(|error| GatewayInstanceError::Store(format!("{}: {error}", error.code())))
}

/// 实例列表（只读快照：状态/凭据状态，无凭据值）。
pub(crate) async fn list_instances(state: &AppState) -> Vec<AdapterInstance> {
    state.gateway_instances.list().await
}

/// 创建实例（同 id 同 platform 幂等）+ 持久化。
pub(crate) async fn create_instance(
    state: &AppState,
    input: CreateInstanceInput,
) -> Result<AdapterInstance, GatewayInstanceError> {
    let dto = state.gateway_instances.create(input).await?;
    persist_instance_store(state).await?;
    Ok(dto)
}

/// 更新实例（仅 label/enabled/autoStart）+ 持久化。
pub(crate) async fn update_instance(
    state: &AppState,
    id: String,
    input: UpdateInstanceInput,
) -> Result<AdapterInstance, GatewayInstanceError> {
    let dto = state.gateway_instances.update(&id, input).await?;
    persist_instance_store(state).await?;
    Ok(dto)
}

/// 删除实例（route_in_use 拒绝；Stopped/Error 才可删）+ 持久化。
pub(crate) async fn remove_instance(
    state: &AppState,
    id: String,
) -> Result<(), GatewayInstanceError> {
    let platform = state
        .gateway_instances
        .get(&id)
        .await
        .map(|instance| instance.platform)
        .ok();
    state.gateway_instances.remove(&id).await?;
    persist_instance_store(state).await?;
    // I12-W5：删除实例同时删除其加密凭据（CredentialStore 按 platform+instanceId 键控）
    if let Some(platform) = platform {
        if let Some(store) = state
            .gateway_credentials
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
        {
            store.remove_credentials(&platform, &id).map_err(|error| {
                GatewayInstanceError::Credentials(format!("{}: {error}", error.code()))
            })?;
        }
    }
    Ok(())
}

/// I12-W5：设置实例凭据——加密落盘 CredentialStore（AES-GCM + AAD 绑定
/// platform|instanceId），更新 credential_ref/status 为 Configured。secret 不进日志/
/// wire（store 层 Zeroizing 脱敏）。
pub(crate) async fn set_instance_credentials(
    state: &AppState,
    id: String,
    secret: String,
) -> Result<AdapterInstance, GatewayInstanceError> {
    let instance = state.gateway_instances.get(&id).await?;
    let store = state
        .gateway_credentials
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .ok_or_else(|| {
            GatewayInstanceError::Credentials("credential store unavailable".to_string())
        })?;
    store
        .set_credentials(&instance.platform, &id, &secret)
        .map_err(|error| GatewayInstanceError::Credentials(format!("{}: {error}", error.code())))?;
    state
        .gateway_instances
        .set_credential_state(&id, crate::gateway::instance::CredentialStatus::Configured)
        .await?;
    state.gateway_instances.get(&id).await
}

#[tauri::command]
pub(crate) async fn gateway_instances(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AdapterInstance>, GatewayInstanceError> {
    Ok(list_instances(state.inner()).await)
}

#[tauri::command]
pub(crate) async fn gateway_instance_create(
    state: tauri::State<'_, AppState>,
    input: CreateInstanceInput,
) -> Result<AdapterInstance, GatewayInstanceError> {
    create_instance(state.inner(), input).await
}

#[tauri::command]
pub(crate) async fn gateway_instance_update(
    state: tauri::State<'_, AppState>,
    id: String,
    input: UpdateInstanceInput,
) -> Result<AdapterInstance, GatewayInstanceError> {
    update_instance(state.inner(), id, input).await
}

#[tauri::command]
pub(crate) async fn gateway_instance_remove(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), GatewayInstanceError> {
    remove_instance(state.inner(), id).await
}

#[tauri::command]
pub(crate) async fn gateway_instance_start(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<AdapterInstance, GatewayInstanceError> {
    state.inner().gateway_instances.start(&id).await
}

#[tauri::command]
pub(crate) async fn gateway_instance_stop(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<AdapterInstance, GatewayInstanceError> {
    state.inner().gateway_instances.stop(&id).await
}

#[tauri::command]
pub(crate) async fn gateway_instance_restart(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<AdapterInstance, GatewayInstanceError> {
    state.inner().gateway_instances.restart(&id).await
}

#[tauri::command]
pub(crate) async fn gateway_instance_set_credentials(
    state: tauri::State<'_, AppState>,
    id: String,
    secret: String,
) -> Result<AdapterInstance, GatewayInstanceError> {
    set_instance_credentials(state.inner(), id, secret).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::instance::InstanceStatus;
    use crate::gateway::route::parse_config;
    use crate::gateway::GatewayCore;
    use crate::runtime::AgentRuntime;
    use crate::session::SessionInfo;
    use crate::test_utils::TestStateBuilder;
    use std::sync::{Arc, Mutex};

    fn gateway_with_routes(yaml: &str) -> Arc<GatewayCore> {
        Arc::new(GatewayCore::from_config(
            parse_config(yaml).expect("合法配置"),
        ))
    }

    // ── I12-W4：实例管理命令/持久化测试 ──

    fn unique_store_path() -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "pylon-gateway-cmds-test-{}-{}.json",
            std::process::id(),
            n
        ))
    }

    fn state_with_store_path(path: std::path::PathBuf) -> AppState {
        let mut state = TestStateBuilder::bare().build();
        state.gateway_instance_store_path = Arc::new(Mutex::new(Some(path)));
        state
    }

    fn create_input(id: &str, platform: &str) -> CreateInstanceInput {
        CreateInstanceInput {
            id: id.into(),
            platform: platform.into(),
            label: format!("label-{id}"),
            enabled: true,
            auto_start: false,
        }
    }

    #[tokio::test]
    async fn create_instance_persists_non_sensitive_config_to_store() {
        let path = unique_store_path();
        let state = state_with_store_path(path.clone());
        let dto = create_instance(&state, create_input("qq-1", "qq"))
            .await
            .expect("create");
        assert_eq!(dto.id, "qq-1");
        assert_eq!(dto.status, InstanceStatus::Stopped);
        let stored = crate::gateway::instance_store::load_instances(&path).expect("load");
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, "qq-1");
        assert_eq!(stored[0].platform, "qq");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("secret") && !text.contains("\"status\"") && !text.contains("lastError"),
            "持久化文件不得包含凭据值/运行状态: {text}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn create_skips_persist_without_configured_path() {
        // store 路径未配置（测试默认）→ 跳过持久化，内存态仍生效
        let state = TestStateBuilder::bare().build();
        let dto = create_instance(&state, create_input("qq-1", "qq"))
            .await
            .expect("create");
        assert_eq!(dto.id, "qq-1");
        assert_eq!(list_instances(&state).await.len(), 1);
    }

    #[tokio::test]
    async fn create_idempotent_same_platform_returns_existing() {
        let state = TestStateBuilder::bare().build();
        create_instance(&state, create_input("a", "qq"))
            .await
            .expect("create");
        let again = create_instance(&state, create_input("a", "qq"))
            .await
            .expect("idempotent");
        assert_eq!(again.id, "a");
        assert_eq!(list_instances(&state).await.len(), 1);
    }

    #[tokio::test]
    async fn create_conflicting_platform_rejected() {
        let state = TestStateBuilder::bare().build();
        create_instance(&state, create_input("a", "qq"))
            .await
            .expect("create");
        let error = create_instance(&state, create_input("a", "wechat"))
            .await
            .expect_err("conflict");
        assert_eq!(error.code(), "invalid_transition");
    }

    #[tokio::test]
    async fn update_persists_label_change() {
        let path = unique_store_path();
        let state = state_with_store_path(path.clone());
        create_instance(&state, create_input("a", "qq"))
            .await
            .expect("create");
        update_instance(
            &state,
            "a".into(),
            UpdateInstanceInput {
                label: Some("新标签".into()),
                enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .expect("update");
        let stored = crate::gateway::instance_store::load_instances(&path).expect("load");
        assert_eq!(stored[0].label, "新标签");
        assert!(!stored[0].enabled);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn remove_rejected_when_route_in_use() {
        let state = TestStateBuilder::bare().build();
        create_instance(&state, create_input("a", "qq"))
            .await
            .expect("create");
        state
            .gateway_instances
            .set_route_guard(Arc::new(|id: &str| id == "a"));
        let error = remove_instance(&state, "a".into())
            .await
            .expect_err("route in use");
        assert_eq!(error.code(), "route_in_use");
    }

    #[tokio::test]
    async fn remove_persists_removal() {
        let path = unique_store_path();
        let state = state_with_store_path(path.clone());
        create_instance(&state, create_input("a", "qq"))
            .await
            .expect("create");
        create_instance(&state, create_input("b", "qq"))
            .await
            .expect("create");
        remove_instance(&state, "a".into()).await.expect("remove");
        let stored = crate::gateway::instance_store::load_instances(&path).expect("load");
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].id, "b");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn remove_unknown_instance_reports_not_found() {
        let state = TestStateBuilder::bare().build();
        let error = remove_instance(&state, "ghost".into())
            .await
            .expect_err("not found");
        assert_eq!(error.code(), "instance_not_found");
    }

    #[tokio::test]
    async fn start_without_factory_reports_adapter_unavailable_and_rolls_back() {
        // 测试 state 无 factory 注册 → start 必须显式报错，不得静默
        let state = TestStateBuilder::bare().build();
        create_instance(&state, create_input("a", "qq"))
            .await
            .expect("create");
        let error = state
            .gateway_instances
            .start("a")
            .await
            .expect_err("no factory");
        assert_eq!(error.code(), "adapter_unavailable");
        let dto = state.gateway_instances.get("a").await.unwrap();
        assert_eq!(
            dto.status,
            InstanceStatus::Stopped,
            "start 失败回滚为 Stopped"
        );
    }

    #[tokio::test]
    async fn persist_failure_reports_store_error_and_memory_still_applied() {
        // CR-001（AC3）：持久化失败必须如实报错（instance_store_write_failed），
        // 不得静默——内存态已生效（重启才可见差异），磁盘未写入。
        // 失败注入：store 路径的父目录是一个"文件"（create_dir_all 必失败）。
        let parent_file = unique_store_path();
        std::fs::write(&parent_file, b"x").unwrap();
        let store_path = parent_file.join("instances.json");
        let mut state = TestStateBuilder::bare().build();
        state.gateway_instance_store_path = Arc::new(Mutex::new(Some(store_path.clone())));
        let error = create_instance(&state, create_input("a", "qq"))
            .await
            .expect_err("persist 必须失败并如实报错");
        assert_eq!(error.code(), "instance_store_write_failed");
        // 内存态已生效（create 在内存 registry 提交成功）
        assert_eq!(list_instances(&state).await.len(), 1);
        // 磁盘未写入
        assert!(!store_path.exists(), "持久化失败不得留下半写入文件");
        let _ = std::fs::remove_file(&parent_file);
    }

    // ── I12-W5：凭据设置/删除/启动解析 ──

    fn unique_app_data_dir() -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("pylon-gw-cmds-cred-{}-{}", std::process::id(), n))
    }

    fn state_with_credentials(app_data: &std::path::Path) -> AppState {
        let mut state = TestStateBuilder::bare().build();
        let store = crate::gateway::credentials::CredentialStore::open(app_data)
            .expect("open credential store");
        state.gateway_credentials = Arc::new(Mutex::new(Some(Arc::new(store))));
        state
    }

    #[tokio::test]
    async fn set_credentials_marks_configured_and_persists_encrypted() {
        let app_data = unique_app_data_dir();
        let state = state_with_credentials(&app_data);
        create_instance(&state, create_input("bot-a", "qq"))
            .await
            .expect("create");
        let dto = set_instance_credentials(&state, "bot-a".into(), "app:client-secret".into())
            .await
            .expect("set credentials");
        assert_eq!(
            dto.credential_status,
            crate::gateway::instance::CredentialStatus::Configured
        );
        assert!(dto.credential_ref.is_some(), "credential_ref 已标记");
        // 密文落盘（重新打开可解密；明文不出现于 Debug 输出）
        let reopened =
            crate::gateway::credentials::CredentialStore::open(&app_data).expect("reopen store");
        let secret = reopened
            .get_credentials("qq", "bot-a")
            .expect("get")
            .expect("present");
        assert_eq!(secret.as_str(), "app:client-secret");
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[tokio::test]
    async fn remove_instance_cleans_encrypted_credentials() {
        let app_data = unique_app_data_dir();
        let state = state_with_credentials(&app_data);
        create_instance(&state, create_input("bot-a", "qq"))
            .await
            .expect("create");
        set_instance_credentials(&state, "bot-a".into(), "app:secret".into())
            .await
            .expect("set");
        remove_instance(&state, "bot-a".into())
            .await
            .expect("remove");
        let store =
            crate::gateway::credentials::CredentialStore::open(&app_data).expect("reopen store");
        assert_eq!(
            store.has_credentials("qq", "bot-a").expect("has"),
            false,
            "凭据随实例删除"
        );
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[tokio::test]
    async fn start_resolves_credentials_via_resolver_before_factory() {
        // service 层：凭据解析器在 start 前把 secret 填入 state（factory 校验用）
        let service = crate::gateway::instance::GatewayInstanceService::new();
        let seen = Arc::new(std::sync::Mutex::new(None::<String>));
        let seen_clone = seen.clone();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let factory = crate::gateway::instance::tests::factory_with(
            calls.clone(),
            move |state, _cancel, notifier| {
                *seen_clone.lock().unwrap() = state.credential_secret.clone();
                let notifier = notifier.clone();
                let run: crate::gateway::instance::BoxRunFuture = Box::pin(async move {
                    notifier.connected().await;
                    std::future::pending::<()>().await;
                    Ok(())
                });
                Ok((
                    Arc::new(crate::gateway::instance::tests::StubAdapter { platform: "qq" }),
                    run,
                ))
            },
        );
        service.register_factory(factory);
        service.set_credential_resolver(Arc::new(|_platform, id| {
            if id == "bot-a" {
                Some("sk-secret".to_string())
            } else {
                None
            }
        }));
        service
            .create(crate::gateway::instance::CreateInstanceInput {
                id: "bot-a".into(),
                platform: "qq".into(),
                label: "a".into(),
                enabled: true,
                auto_start: false,
            })
            .await
            .unwrap();
        service.start("bot-a").await.unwrap();
        for _ in 0..200 {
            if seen.lock().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            seen.lock().unwrap().as_deref(),
            Some("sk-secret"),
            "start 前凭据已解析填入 state"
        );
    }

    fn session(peri_id: &str, title: &str, model: &str) -> SessionInfo {
        let mut s = SessionInfo::new(peri_id.into(), String::new(), ".".into(), true, 0);
        s.title = title.into();
        s.model = model.into();
        s.mode = Some("auto".into());
        s
    }

    fn runtime_with(sessions: &[(&str, SessionInfo)]) -> Arc<AgentRuntime> {
        let runtime = AgentRuntime::new_disconnected();
        let mut map = runtime.sessions.lock().unwrap();
        for (source, info) in sessions {
            map.insert(source.to_string(), info.clone());
        }
        drop(map);
        runtime
    }

    #[test]
    fn gateway_catalog_returns_builtin_platforms_deterministic() {
        // I12-A-BE-01：catalog 只读快照——qq built-in、wechat 未安装，顺序稳定
        let catalog = crate::gateway::catalog::builtin_catalog();
        let platforms: Vec<&str> = catalog.iter().map(|c| c.platform.as_str()).collect();
        assert_eq!(platforms, vec!["qq", "wechat"], "catalog 顺序必须稳定");
        let wire = serde_json::to_value(&catalog).expect("serialize");
        assert!(wire.is_array());
        assert_eq!(wire[0]["availability"], "builtIn");
        assert_eq!(wire[1]["availability"], "notInstalled");
        let text = serde_json::to_string(&catalog).unwrap();
        assert!(
            !text.contains("sk-"),
            "catalog 命令不得泄露任何凭据值: {text}"
        );
    }

    #[test]
    fn gateway_sessions_filters_binding_and_aggregates() {
        let gateway = gateway_with_routes(
            "gateway:\n  routes:\n    - source: qq:user:demo-user\n      agent: peri\n      profile: p\n      session: s\n      reset: daily\n      idle_minutes: 60\n",
        );
        // peri：binding 命中 + GUI source（无 binding）；hermes：平台前缀但无 binding
        let peri = runtime_with(&[
            ("qq:user:demo-user", session("peri-1", "平台会话", "deepseek")),
            ("local:gui", session("gui-1", "GUI", "deepseek")),
        ]);
        let hermes = runtime_with(&[(
            "qq:user:9999",
            session("hermes-1", "无绑定平台", "deepseek"),
        )]);
        let state = TestStateBuilder::bare()
            .with_runtime("peri", peri)
            .with_runtime("hermes", hermes)
            .with_gateway(gateway)
            .build();
        let rows = collect_gateway_sessions(&state).unwrap();
        assert_eq!(rows.len(), 1, "仅 binding 命中的实际 session");
        let row = &rows[0];
        assert_eq!(row.agent_id, "peri");
        assert_eq!(row.source, "qq:user:demo-user");
        assert_eq!(row.peri_id, "peri-1");
        assert_eq!(row.title, "平台会话");
        assert_eq!(row.model, "deepseek");
        assert_eq!(row.mode.as_deref(), Some("auto"));
        assert!(
            row.updated_at.is_some(),
            "updated_at 必须有值（Timestamp::now）"
        );
        assert_eq!(row.reset, "daily");
        assert_eq!(row.idle_minutes, Some(60));
        assert_eq!(row.allow_from, None);
    }

    #[test]
    fn gateway_sessions_empty_without_binding() {
        let state = TestStateBuilder::bare()
            .with_gateway(gateway_with_routes("gateway:\n  routes: []\n"))
            .build();
        assert_eq!(collect_gateway_sessions(&state).unwrap(), Vec::new());
    }

    #[test]
    fn gateway_sessions_updated_at_none_serializes_null() {
        let gateway = gateway_with_routes(
            "gateway:\n  routes:\n    - source: qq:user:x\n      agent: peri\n      profile: p\n      session: s\n",
        );
        let mut s = session("p-x", "X", "m");
        s.updated_at = None;
        let runtime = runtime_with(&[("qq:user:x", s)]);
        let state = TestStateBuilder::bare()
            .with_runtime("peri", runtime)
            .with_gateway(gateway)
            .build();
        let rows = collect_gateway_sessions(&state).unwrap();
        assert_eq!(rows[0].updated_at, None);
        assert_eq!(rows[0].reset, "idle", "reset 缺省有效值 idle");
        assert_eq!(rows[0].idle_minutes, None);
    }

    #[test]
    fn gateway_sessions_sorts_stable_by_agent_source_peri() {
        let gateway = gateway_with_routes(
            "gateway:\n  routes:\n    - source: qq:user:b\n      agent: peri\n      profile: p\n      session: s\n    - source: qq:user:a\n      agent: peri\n      profile: p\n      session: s\n",
        );
        let runtime = runtime_with(&[
            ("qq:user:b", session("p-b", "B", "m")),
            ("qq:user:a", session("p-a", "A", "m")),
        ]);
        let state = TestStateBuilder::bare()
            .with_runtime("peri", runtime)
            .with_gateway(gateway)
            .build();
        let rows = collect_gateway_sessions(&state).unwrap();
        let keys: Vec<(&str, &str)> = rows
            .iter()
            .map(|r| (r.source.as_str(), r.peri_id.as_str()))
            .collect();
        assert_eq!(
            keys,
            vec![("qq:user:a", "p-a"), ("qq:user:b", "p-b")],
            "必须稳定排序"
        );
    }

    #[test]
    fn gateway_sessions_lock_poison_reports_protocol_error() {
        let gateway = gateway_with_routes(
            "gateway:\n  routes:\n    - source: qq:user:demo-user\n      agent: peri\n      profile: p\n      session: s\n",
        );
        let poisoned = AgentRuntime::new_disconnected();
        // 在 guard 持有期间 panic → Mutex 标记 poison
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut guard = poisoned.sessions.lock().unwrap();
            guard.insert("qq:user:demo-user".into(), session("peri-1", "t", "m"));
            panic!("intentional poison");
        }));
        let state = TestStateBuilder::bare()
            .with_runtime("peri", poisoned)
            .with_gateway(gateway)
            .build();
        let result = collect_gateway_sessions(&state);
        assert!(
            matches!(result, Err(PylonError::Protocol(_))),
            "锁中毒必须 protocol_error，不得静默为空"
        );
    }
}

/// 网关状态：已注册平台适配器 + 静态路由表 + 平台配置 + 注入配置。
#[tauri::command]
pub(crate) async fn gateway_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let gateway = &state.gateway;
    // B4：Binding 序列化（camelCase + extra skip）——手工 JSON 组装曾与
    // EntityBinding 字段无编译期同步保护（G5 C5），现在增字段即编译期强制。
    let routes: Vec<serde_json::Value> = gateway
        .routes()
        .iter()
        .map(|binding| serde_json::to_value(binding).unwrap_or(serde_json::Value::Null))
        .collect();
    let qq = gateway.qq_config();
    Ok(serde_json::json!({
        "adapters": gateway.adapter_keys(),
        "routes": routes,
        "qq": { "groupAllowFrom": qq.group_allow_from },
        // I12 W9：未绑定消息策略 wire（active-agent | reject）——UI 明示风险
        "unboundPolicy": gateway.unbound_policy().as_str(),
        "inject": {
            "enabled": gateway.inject_enabled(),
            "scenario": gateway.inject_scenario(),
            "sources": gateway.inject_sources(),
            "persist": gateway.inject_persist(),
        },
    }))
}

/// 网关配置热重载：重新解析当前生效 agents.yaml 的 gateway 段
/// （PYLON_AGENTS_CONFIG / exe 旁 agents.yaml / 内置配置）。
/// 注意：QQ 凭据（PYLON_QQ_APP_ID/CLIENT_SECRET）与已注册适配器不受影响（启动生效）。
#[tauri::command]
pub(crate) async fn reload_gateway(state: tauri::State<'_, AppState>) -> Result<(), PylonError> {
    // R35/O57：配置来源统一——有路径时 tokio::fs 异步读（不阻塞 async 运行时），
    // 无路径（内置配置）时经 load_gateway_config 的 include_str 兜底。
    let content = match agent_config::effective_config_path() {
        Some(path) => tokio::fs::read_to_string(&path)
            .await
            .map_err(|error| PylonError::Io(format!("读取 {} 失败: {error}", path.display())))?,
        None => agent_config::load_gateway_config().map_err(PylonError::from)?,
    };
    let config = crate::gateway::route::parse_config(&content).map_err(PylonError::Protocol)?;
    // R4（P1-2）：reload 失败（配置锁中毒）必须如实返回错误，不得继续报成功。
    state.gateway.reload(config).map_err(PylonError::from)?;
    state.inner().log_runtime_summary(
        "info",
        "gateway",
        None,
        "Gateway config reloaded",
        serde_json::Map::new(),
    );
    Ok(())
}
