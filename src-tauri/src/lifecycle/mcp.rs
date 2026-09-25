//! MCP 配置命令与持久化（自 mod.rs 拆分；行为零变化）。
//!
//! - `get/set_mcp_servers`：runtime 配置读写（C8 写序锁 + E10 wire 缓存）。
//! - B4.2 持久化：原子写（唯一 temp + rename）、启动恢复加载（校验失败静默降级）。

use crate::error::PylonError;
use crate::AppState;

// ── B4.2 MCP 配置持久化 ──

/// MCP 配置落盘路径（统一从 AppState 的一次性 DataDirs 取）。
/// 注意：env/headers 可能含 secret，文件是本地用户配置（写盘是持久化目的），
/// 但不进任何日志/输出。
pub(crate) fn mcp_persist_path(state: &AppState) -> Result<std::path::PathBuf, String> {
    Ok(crate::paths::mcp_persist_path(state.data_dirs()?))
}

/// 原子写 MCP 配置：唯一临时文件 + rename，中断不留半截 JSON。经 agent_config
/// 正身 [`crate::agent_config::AtomicWriteOptions`] 收敛（issue #228 批次D）。
/// 历史行为保留：不 fsync 临时文件（best-effort 持久化）。写失败只 warn，
/// 不阻断主流程。
pub(crate) fn persist_mcp_if_possible(state: &AppState, servers: &[crate::mcp::McpServerConfig]) {
    let path = match mcp_persist_path(state) {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!("resolve MCP persist path failed: {error}");
            return;
        }
    };
    let json = match serde_json::to_string(servers) {
        Ok(json) => json,
        Err(error) => {
            tracing::warn!("serialize MCP config failed: {error}");
            return;
        }
    };
    if let Err(error) = crate::agent_config::write_file_atomically(
        &path,
        json.as_bytes(),
        crate::agent_config::AtomicWriteOptions::best_effort_data_file(),
    ) {
        tracing::warn!("persist MCP config failed: {error}");
    }
}

/// 加载 MCP 持久化配置：文件缺失/损坏 → None（启动时静默降级为空配置）。
/// 内容过 validate_and_serialize（防手改文件注入非法配置）——校验失败视为损坏。
pub(crate) fn load_mcp_persisted(
    path: &std::path::Path,
) -> Option<Vec<crate::mcp::McpServerConfig>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let servers: Vec<crate::mcp::McpServerConfig> = serde_json::from_str(&raw).ok()?;
    match crate::mcp::validate_and_serialize(Some(servers.clone())) {
        Ok(_) => Some(servers),
        Err(error) => {
            tracing::warn!("loaded MCP config invalid; ignored: {error}");
            None
        }
    }
}

// ── B9 权限审批 commands ──
// ── Session persistence commands ──

/// 返回当前 agent 级暴露的 MCP server 配置（cwd 设置据此选择启用哪些）。
#[tauri::command]
pub(crate) async fn get_mcp_servers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::mcp::McpServerConfig>, PylonError> {
    state
        .inner()
        .current_mcp_servers()
        .map_err(PylonError::Protocol)
}

#[tauri::command]
pub(crate) async fn set_mcp_servers(
    state: tauri::State<'_, AppState>,
    servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<Vec<serde_json::Value>, PylonError> {
    // O13：单次 clone（validate 消耗 clone，原值 move 进 runtime_mcp；
    // persist 在锁内借用 guard——原实现 serialized/persisted 两次 clone）。
    let serialized =
        crate::mcp::validate_and_serialize(servers.clone()).map_err(PylonError::Command)?;
    // C8：写 runtime_mcp + 落盘全程持写序锁——并发 set_mcp_servers 串行，
    // 磁盘必为最后一次设置（重启不回滚到旧配置）。
    let _mcp_write_guard = state.mcp_write_lock.lock().await;
    {
        let mut guard = state
            .runtime_mcp
            .lock()
            .map_err(|error| PylonError::Command(error.to_string()))?;
        *guard = servers;
        // P1（E10）：wire 缓存与 runtime_mcp 同锁写入（读路径 miss 时回退重算并回填）。
        if let Ok(mut cache) = state.mcp_wire.lock() {
            *cache = Some(serialized.clone());
        }
        // B4.2：配置落盘（重启不丢）。写失败只 warn，不阻断本次设置。
        persist_mcp_if_possible(state.inner(), guard.as_deref().unwrap_or_default());
    }
    Ok(serialized)
}
