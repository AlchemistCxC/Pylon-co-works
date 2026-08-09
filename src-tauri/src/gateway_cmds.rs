//! 网关状态/热重载命令（R1 拆分自 lib.rs；行为零变化）。

use serde::Serialize;

use crate::agent_config;
use crate::error::PylonError;
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
pub(crate) fn collect_gateway_sessions(state: &AppState) -> Result<Vec<GatewaySessionRow>, PylonError> {
    let mut rows: Vec<GatewaySessionRow> = Vec::new();
    for (agent_id, runtime) in state.runtimes.all_with_ids() {
        let sessions = runtime
            .sessions
            .lock()
            .map_err(|e| PylonError::Protocol(e.to_string()))?;
        for (source, info) in sessions.iter() {
            let Some(binding) = state.gateway.binding(source) else { continue };
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
    rows.sort_by(|a, b| a.agent_id.cmp(&b.agent_id).then(a.source.cmp(&b.source)).then(a.peri_id.cmp(&b.peri_id)));
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
/// 注：命令注册（lib.rs invoke_handler）不在 BE 卡 scope——本命令与
/// [`crate::gateway::catalog::builtin_catalog`] 函数级测试冻结 wire 形状；
/// BE-02 生命周期接线时注册。
#[tauri::command]
pub(crate) async fn gateway_catalog() -> Result<Vec<crate::gateway::catalog::AdapterCatalogItem>, PylonError> {
    Ok(crate::gateway::catalog::builtin_catalog())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::GatewayCore;
    use crate::gateway::route::parse_config;
    use crate::runtime::AgentRuntime;
    use crate::session::SessionInfo;
    use crate::test_utils::TestStateBuilder;
    use std::sync::Arc;

    fn gateway_with_routes(yaml: &str) -> Arc<GatewayCore> {
        Arc::new(GatewayCore::from_config(parse_config(yaml).expect("合法配置")))
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
            "gateway:\n  routes:\n    - source: qq:user:14CE\n      agent: peri\n      profile: p\n      session: s\n      reset: daily\n      idle_minutes: 60\n",
        );
        // peri：binding 命中 + GUI source（无 binding）；hermes：平台前缀但无 binding
        let peri = runtime_with(&[
            ("qq:user:14CE", session("peri-1", "平台会话", "deepseek")),
            ("local:gui", session("gui-1", "GUI", "deepseek")),
        ]);
        let hermes = runtime_with(&[("qq:user:9999", session("hermes-1", "无绑定平台", "deepseek"))]);
        let state = TestStateBuilder::bare()
            .with_runtime("peri", peri)
            .with_runtime("hermes", hermes)
            .with_gateway(gateway)
            .build();
        let rows = collect_gateway_sessions(&state).unwrap();
        assert_eq!(rows.len(), 1, "仅 binding 命中的实际 session");
        let row = &rows[0];
        assert_eq!(row.agent_id, "peri");
        assert_eq!(row.source, "qq:user:14CE");
        assert_eq!(row.peri_id, "peri-1");
        assert_eq!(row.title, "平台会话");
        assert_eq!(row.model, "deepseek");
        assert_eq!(row.mode.as_deref(), Some("auto"));
        assert!(row.updated_at.is_some(), "updated_at 必须有值（Timestamp::now）");
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
        let keys: Vec<(&str, &str)> = rows.iter().map(|r| (r.source.as_str(), r.peri_id.as_str())).collect();
        assert_eq!(keys, vec![("qq:user:a", "p-a"), ("qq:user:b", "p-b")], "必须稳定排序");
    }

    #[test]
    fn gateway_sessions_lock_poison_reports_protocol_error() {
        let gateway = gateway_with_routes(
            "gateway:\n  routes:\n    - source: qq:user:14CE\n      agent: peri\n      profile: p\n      session: s\n",
        );
        let poisoned = AgentRuntime::new_disconnected();
        // 在 guard 持有期间 panic → Mutex 标记 poison
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut guard = poisoned.sessions.lock().unwrap();
            guard.insert("qq:user:14CE".into(), session("peri-1", "t", "m"));
            panic!("intentional poison");
        }));
        let state = TestStateBuilder::bare()
            .with_runtime("peri", poisoned)
            .with_gateway(gateway)
            .build();
        let result = collect_gateway_sessions(&state);
        assert!(matches!(result, Err(PylonError::Protocol(_))), "锁中毒必须 protocol_error，不得静默为空");
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
