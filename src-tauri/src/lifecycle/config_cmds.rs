//! Agent 配置事务命令（自 mod.rs 拆分；行为零变化）。
//!
//! reload / snapshot / update_agents_config / initialize_agents_config：
//! 写序锁 → lease → 候选生成 + 双域校验 → 原子写盘 → 内存提交 → 幽灵 runtime 清理。

use super::*;
use crate::error::PylonError;
use crate::AppState;


#[tauri::command]
pub(crate) async fn reload_agents(
    state: tauri::State<'_, AppState>,
    config_path: Option<String>,
) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    let new_agents = if let Some(path) = config_path {
        crate::agent_config::load_from_path(std::path::Path::new(&path))?
    } else {
        crate::agent_config::load()?
    };
    crate::agent_config::default_agent_id(&new_agents)?;
    // O12：config 读（read_to_string + parse）在锁外完成（load_from_path/load
    // 在取得 agents 锁之前执行）；active 存在性检查 + 新旧表 diff + 原子替换
    // 合并为单次持锁操作——无"检查通过但替换未完成"的中间态。
    let agent_count = new_agents.len();
    let removed: Vec<String> = {
        let active_agent = state
            .active_agent
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
        if !new_agents.contains_key(&active_agent) {
            return Err(PylonError::Protocol(format!(
                "agent config cannot remove active agent: {active_agent}"
            )));
        }
        // C6：reload 删除 agent 时清理幽灵 runtime——新旧表 diff，删除且非 active 的
        // agent 在注册表替换后 abort notification_task + kill acp（防旧进程继续
        // 运行/崩溃通知复活；与 switch_agent 清理旧 runtime 同款操作）。
        let removed = agents
            .keys()
            .filter(|id| !new_agents.contains_key(*id) && **id != active_agent)
            .cloned()
            .collect();
        *agents = new_agents;
        removed
    };
    remove_stale_runtimes(state.inner(), removed).await;
    state.inner().log_runtime_summary(
        "info",
        "agent",
        None,
        "Agent registry reloaded",
        serde_json::Map::from_iter([(
            "agentCount".to_string(),
            serde_json::Value::from(agent_count),
        )]),
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn agent_config_snapshot(
    _state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let path = crate::agent_config::effective_config_path().ok_or(PylonError::Config(
        crate::agent_config::ConfigError::ReadOnly,
    ))?;
    let (revision, agents) =
        tokio::task::spawn_blocking(move || crate::agent_config::read_config_snapshot(&path))
            .await
            .map_err(|error| PylonError::Io(error.to_string()))??;
    let summaries = agents
        .iter()
        .map(|(id, agent)| agent_summary_payload(id, agent, None, None, false))
        .collect::<Vec<_>>();
    let diagnostics = crate::agent_config::config_diagnostics(&agents);
    Ok(serde_json::json!({
        "revision": revision,
        "agents": summaries,
        "diagnostics": diagnostics,
    }))
}

/// Phase 3：update_agents_config（意见稿 §5.1 显式 scope 契约，用户拍板）。
///
/// scope="agent"：config 为 agent 整块 YAML 字符串（agentId 必填）；
/// scope="gateway"：config 为 `{ gateway: { routes: [...] } }` JSON。
/// 事务（§5.3.B）：写序锁 → embedded 只读检查 → 读当前 → 生成候选 → 双域校验 +
/// active agent 保护（写盘前）→ 原子写盘 → 内存提交（agents 域刷新 + 幽灵 runtime
/// 清理对齐 reload_agents；gateway 域 reload，失败报 config_not_applied）。
#[tauri::command]
pub(crate) async fn update_agents_config(
    state: tauri::State<'_, AppState>,
    scope: String,
    agent_id: Option<String>,
    config: serde_json::Value,
    expected_revision: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    use crate::agent_config::ConfigError;
    let inner = state.inner();
    // 写序锁：读当前→生成候选→校验→写盘→内存提交全程串行，防基于旧版本互相覆盖
    let _write_guard = inner.config_write_lock.lock().await;
    // 1. 来源检查：embedded 无外部写入目标 → config_read_only（绝不 fallback 当前目录）
    let path = crate::agent_config::effective_config_path()
        .ok_or(PylonError::Config(ConfigError::ReadOnly))?;
    let expected_revision =
        expected_revision.ok_or(PylonError::Config(ConfigError::RevisionRequired))?;
    // 跨进程 lease 覆盖“重读 baseline → 生成/校验候选 → 提交”整个窗口。
    // 进程内 config_write_lock 只负责当前 AppState，不能代替文件级互斥。
    let config_lease = crate::agent_config::ConfigLease::acquire(&path)?;
    // 2. 读当前原文（tokio::fs 异步读，不阻塞 async 运行时）
    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        PylonError::Config(ConfigError::Read(format!(
            "读取 {} 失败: {error}",
            path.display()
        )))
    })?;
    let actual = crate::agent_config::config_revision_for_bytes(content.as_bytes());
    if actual != expected_revision {
        return Err(PylonError::Config(ConfigError::Conflict {
            expected: expected_revision,
            actual,
        }));
    }
    // 3. 生成候选 + 双域校验 + 解析 agents（同步 YAML/fs，spawn_blocking；base_dir 绝对化）
    let scope_owned = scope.clone();
    let agent_id_owned = agent_id.clone();
    let config_owned = config.clone();
    let base_dir = path.parent().map(|p| p.to_path_buf());
    let candidate = tokio::task::spawn_blocking(move || {
        let candidate = match scope_owned.as_str() {
            "agent" => {
                let agent_id = agent_id_owned
                    .ok_or_else(|| ConfigError::Invalid("scope=agent 缺少 agentId".to_string()))?;
                let patch_yaml = config_owned.as_str().ok_or_else(|| {
                    ConfigError::Invalid("scope=agent 的 config 必须为 YAML 字符串".to_string())
                })?;
                crate::agent_config::apply_agent_patch(&content, &agent_id, patch_yaml)?
            }
            "agent_fields" => {
                let agent_id = agent_id_owned.ok_or_else(|| {
                    ConfigError::Invalid("scope=agent_fields 缺少 agentId".to_string())
                })?;
                crate::agent_config::apply_agent_field_patch(&content, &agent_id, &config_owned)?
            }
            "agent_create" => {
                let agent_id = agent_id_owned.ok_or_else(|| {
                    ConfigError::Invalid("scope=agent_create 缺少 agentId".to_string())
                })?;
                crate::agent_config::apply_agent_create(&content, &agent_id, &config_owned)?
            }
            "gateway" => crate::agent_config::apply_gateway_patch(&content, &config_owned)?,
            other => return Err(ConfigError::Invalid(format!("未知 scope: {other}"))),
        };
        let agents = crate::agent_config::validate_candidate(&candidate, base_dir.as_deref())?;
        Ok::<
            (
                String,
                std::collections::HashMap<String, crate::agent_config::AgentDef>,
            ),
            ConfigError,
        >((candidate, agents))
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    let (candidate, new_agents) = candidate;
    crate::agent_config::default_agent_id(&new_agents)?;
    // 4. active agent 保护（写盘前，只读不写）：候选不得删除当前 active agent；
    // 同时计算 removed diff，供写盘成功后再清理（施工文档 §2.1）。
    let removed: Vec<String> = {
        let active = inner.active_agent.lock().map_err(|e| e.to_string())?;
        let agents = inner.agents.lock().map_err(|e| e.to_string())?;
        if !new_agents.contains_key(&*active) {
            return Err(PylonError::Config(ConfigError::ActiveAgentProtected(
                format!("候选配置删除了当前 active agent: {}", *active),
            )));
        }
        agents
            .keys()
            .filter(|id| !new_agents.contains_key(*id) && **id != *active)
            .cloned()
            .collect()
    };
    // 5. 原子写盘（替换语义）。先落盘、后提交内存：写盘失败时 registry 不变
    // （施工文档 §2.1 必测失败链）。
    let write_content = candidate.clone();
    let write_path = path.clone();
    let expected_for_write = expected_revision.clone();
    tokio::task::spawn_blocking(move || {
        crate::agent_config::write_config_transaction_under_lease(
            &config_lease,
            &write_path,
            &expected_for_write,
            write_content.as_bytes(),
        )
        .map(|_| ())
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    // 6. 磁盘成功后提交内存 registry（与 reload_agents 的原子替换同语义）。
    {
        let mut agents = inner.agents.lock().map_err(|e| e.to_string())?;
        *agents = new_agents;
    }
    // 7. 幽灵 runtime 清理（与 reload_agents 同款：abort + kill + 移除）
    remove_stale_runtimes(inner, removed).await;
    // 8. gateway 域提交（scope=gateway 才需要；失败=磁盘已写但未生效 → config_not_applied）
    if scope == "gateway" {
        let gateway_config = crate::gateway::route::parse_config(&candidate).map_err(|e| {
            PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
        })?;
        inner.gateway.reload(gateway_config).map_err(|e| {
            PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
        })?;
    }
    inner.log_runtime_summary(
        "info",
        "config",
        None,
        &format!("Config updated (scope={scope})"),
        serde_json::Map::from_iter([(
            "scope".to_string(),
            serde_json::Value::String(scope.clone()),
        )]),
    );
    // 9. 返回摘要（不返回完整敏感配置）
    let agent_count = inner.agents.lock().map(|a| a.len()).unwrap_or(0);
    let revision = crate::agent_config::config_revision_for_path(&path)?;
    let config_activation_state = agent_id
        .as_deref()
        .and_then(|agent_id| stored_agent_activation(inner, agent_id));
    Ok(serde_json::json!({
        "applied": true,
        "scope": scope,
        "agentCount": agent_count,
        "revision": revision,
        "configActivationState": config_activation_state,
    }))
}

// ── 施工文档 Phase 2：首次外部配置初始化 + 连接测试 ──

/// embedded → exe 旁 `agents.yaml` 的首次外部配置初始化（施工文档 §4.6）。
/// 只允许当前 source 为 Embedded 时执行；目标固定 exe 同目录 `agents.yaml`，
/// 不写 `data/agents.yaml`，不写 AppData。走与 `update_agents_config` 相同的
/// 候选校验、原子写盘、内存提交与 gateway reload。
#[tauri::command]
pub(crate) async fn initialize_agents_config(
    state: tauri::State<'_, AppState>,
    agent_id: Option<String>,
    config: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    use crate::agent_config::ConfigError;
    let inner = state.inner();
    let _write_guard = inner.config_write_lock.lock().await;

    // 1. 仅 embedded source 允许初始化（已有外部配置时直接走 update_agents_config）
    if crate::agent_config::effective_config_path().is_some() {
        return Err(PylonError::Config(ConfigError::ReadOnly));
    }
    let exe_dir = std::env::current_exe()
        .map_err(|error| PylonError::Io(format!("resolve current_exe failed: {error}")))?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| PylonError::Io("current_exe has no parent".to_string()))?;
    let target = exe_dir.join("agents.yaml");
    let config_lease = crate::agent_config::ConfigLease::acquire(&target)?;
    if target.exists() {
        return Err(PylonError::Config(ConfigError::Conflict {
            expected: "<missing>".to_string(),
            actual: crate::agent_config::config_revision_for_path(&target)?,
        }));
    }

    // 2. 候选生成 + 双域校验（base_dir = exe 目录；同步 YAML/fs 移出 async 运行时）
    let content_owned = if config.get("agents").is_some() {
        crate::agent_config::serialize_agents_document(&config)?
    } else if config.is_object() {
        let requested_id = agent_id.as_deref().ok_or_else(|| {
            PylonError::Config(ConfigError::Invalid("结构化初始化缺少 agentId".to_string()))
        })?;
        let current = crate::agent_config::read_config_document()?;
        crate::agent_config::apply_agent_field_patch(&current.content, requested_id, &config)?
    } else {
        return Err(PylonError::Config(ConfigError::Invalid(
            "initialize_agents_config 的 config 必须为结构化 agents document 或字段 patch"
                .to_string(),
        )));
    };
    let base_dir = exe_dir.clone();
    let candidate = tokio::task::spawn_blocking(move || {
        let agents = crate::agent_config::validate_candidate(&content_owned, Some(&base_dir))?;
        Ok::<
            (
                String,
                std::collections::HashMap<String, crate::agent_config::AgentDef>,
            ),
            ConfigError,
        >((content_owned, agents))
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    let (candidate, new_agents) = candidate;
    let default_agent_id = crate::agent_config::default_agent_id(&new_agents)?.unwrap_or_default();
    if let Some(requested_id) = agent_id.as_deref() {
        if !new_agents.contains_key(requested_id) {
            return Err(PylonError::Config(ConfigError::Invalid(format!(
                "初始化配置不包含 agentId: {requested_id}"
            ))));
        }
    }

    // 3. 原子写盘（先磁盘）
    let write_content = candidate.clone();
    let write_path = target.clone();
    let revision = tokio::task::spawn_blocking(move || {
        crate::agent_config::write_new_config_under_lease(
            &config_lease,
            &write_path,
            write_content.as_bytes(),
        )
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;

    // 4. 磁盘成功后提交内存（embedded → external；active 不在新配置时切到新默认）
    let removed: Vec<String> = {
        let mut agents = inner.agents.lock().map_err(|e| e.to_string())?;
        let mut active = inner.active_agent.lock().map_err(|e| e.to_string())?;
        let removed = agents
            .keys()
            .filter(|id| !new_agents.contains_key(*id))
            .cloned()
            .collect();
        *agents = new_agents;
        if !agents.contains_key(&*active) {
            *active = default_agent_id.clone();
        }
        removed
    };
    // 5. 清理被移除的旧 runtime（与 reload_agents 同款）
    remove_stale_runtimes(inner, removed).await;
    // 6. gateway 域提交（配置文档已通过双域校验；reload 失败 → config_not_applied）
    let gateway_config = crate::gateway::route::parse_config(&candidate).map_err(|e| {
        PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
    })?;
    inner.gateway.reload(gateway_config).map_err(|e| {
        PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
    })?;

    inner.log_runtime_summary(
        "info",
        "config",
        None,
        "Agent config initialized to external file",
        serde_json::Map::from_iter([
            (
                "scope".to_string(),
                serde_json::Value::String("initialize".to_string()),
            ),
            (
                "agentCount".to_string(),
                serde_json::Value::from(inner.agents.lock().map(|a| a.len()).unwrap_or(0)),
            ),
        ]),
    );
    Ok(serde_json::json!({
        "applied": true,
        "scope": "initialize",
        "agentCount": inner.agents.lock().map(|a| a.len()).unwrap_or(0),
        "defaultAgentId": inner.active_agent.lock().map(|a| a.clone()).unwrap_or_default(),
        "revision": revision,
    }))
}
