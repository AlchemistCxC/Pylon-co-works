//! 网关状态/热重载命令（R1 拆分自 lib.rs；行为零变化）。

use crate::agent_config;
use crate::error::PylonError;
use crate::AppState;

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
        None => agent_config::load_gateway_config().map_err(PylonError::Io)?,
    };
    let config = crate::gateway::route::parse_config(&content).map_err(PylonError::Protocol)?;
    state.gateway.reload(config);
    state.inner().log_runtime_summary(
        "info",
        "gateway",
        None,
        "Gateway config reloaded",
        serde_json::Map::new(),
    );
    Ok(())
}
