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
    let routes: Vec<serde_json::Value> = gateway
        .routes()
        .iter()
        .map(|binding| {
            serde_json::json!({
                "source": binding.source,
                "agentId": binding.agent_id,
                "profileId": binding.profile_id,
                "sessionKey": binding.session_key,
                "allowFrom": binding.allow_from,
                "reset": binding.reset,
                "idleMinutes": binding.idle_minutes,
            })
        })
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
    let content = match agent_config::effective_config_path() {
        Some(path) => std::fs::read_to_string(&path)
            .map_err(|error| PylonError::Io(format!("读取 {} 失败: {error}", path.display())))?,
        None => include_str!("../../agents.yaml").to_string(),
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
