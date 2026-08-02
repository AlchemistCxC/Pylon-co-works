//! Prism 管理 API 转发命令（R1 拆分自 lib.rs；行为零变化）。
//! 全部为薄转发：Tauri 命令 → PrismClient（本地 Prism HTTP 服务）。

use crate::error::PylonError;
use crate::AppState;

#[tauri::command]
pub(crate) async fn prism_health(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    state.prism.get("/health").await.map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    Ok(state.prism.status().await)
}

#[tauri::command]
pub(crate) async fn prism_state(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    state.prism.get("/state").await.map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_scenarios(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get("/api/scenarios")
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_sources(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get("/api/sources")
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_aliases(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get("/api/aliases")
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_config(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get_query("/api/config", [("name", name)])
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_logs(
    state: tauri::State<'_, AppState>,
    log_type: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<serde_json::Value, PylonError> {
    let mut query = Vec::new();
    if let Some(value) = log_type {
        query.push(("type".to_string(), value));
    }
    if let Some(value) = limit {
        query.push(("limit".to_string(), value.to_string()));
    }
    if let Some(value) = offset {
        query.push(("offset".to_string(), value.to_string()));
    }
    state
        .prism
        .get_query("/api/logs", query)
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_chronicle(
    state: tauri::State<'_, AppState>,
    scenario: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    let query = scenario
        .into_iter()
        .map(|value| ("scenario".to_string(), value))
        .collect::<Vec<_>>();
    state
        .prism
        .get_query("/api/chronicle", query)
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_history(
    state: tauri::State<'_, AppState>,
    scenario: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<serde_json::Value, PylonError> {
    let mut query = Vec::new();
    if let Some(value) = scenario {
        query.push(("scenario".to_string(), value));
    }
    if let Some(value) = limit {
        query.push(("limit".to_string(), value.to_string()));
    }
    if let Some(value) = offset {
        query.push(("offset".to_string(), value.to_string()));
    }
    state
        .prism
        .get_query("/api/history", query)
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_scenario(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get_query("/api/scenario", [("name", name)])
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_blocks(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get("/api/blocks")
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_inject(
    state: tauri::State<'_, AppState>,
    request: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post("/inject", request)
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_command(
    state: tauri::State<'_, AppState>,
    command: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post("/command", serde_json::json!({"command": command}))
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_create_scenario(
    state: tauri::State<'_, AppState>,
    name: String,
    yaml: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post(
            "/api/scenarios",
            serde_json::json!({"name": name, "yaml": yaml}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_delete_scenario(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post_query(
            "/api/scenarios/delete",
            [("name", name)],
            serde_json::json!({}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_create_source(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post("/api/sources", serde_json::json!({"name": name}))
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_delete_source(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post_query(
            "/api/sources/delete",
            [("name", name)],
            serde_json::json!({}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_source_detail(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get_query("/api/source/detail", [("name", name)])
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_source_files(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get_query("/api/sources/files", [("name", name)])
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_read_source_file(
    state: tauri::State<'_, AppState>,
    name: String,
    path: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get_query("/api/sources/file", [("name", name), ("path", path)])
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_write_source_file(
    state: tauri::State<'_, AppState>,
    name: String,
    path: String,
    content: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .put_query(
            "/api/sources/file",
            [("name", name), ("path", path)],
            serde_json::json!({"content": content}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_delete_source_file(
    state: tauri::State<'_, AppState>,
    name: String,
    path: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .delete_query("/api/sources/file", [("name", name), ("path", path)])
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_source_entries(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get_query(
            "/api/source/entries",
            [("source", source), ("scenario", scenario)],
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_source_entry(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
    uid: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .get_query(
            "/api/source/entry",
            [("source", source), ("scenario", scenario), ("uid", uid)],
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_add_source_entry(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
    entry: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post_query(
            "/api/source/entry/add",
            [("source", source), ("scenario", scenario)],
            serde_json::json!({"entry": entry}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_edit_source_entry(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
    uid: String,
    entry: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .put_query(
            "/api/source/entry/edit",
            [("source", source), ("scenario", scenario), ("uid", uid)],
            serde_json::json!({"entry": entry}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_delete_source_entry(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
    uid: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post_query(
            "/api/source/entry/delete",
            [("source", source), ("scenario", scenario), ("uid", uid)],
            serde_json::json!({}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_update_config(
    state: tauri::State<'_, AppState>,
    name: String,
    yaml: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .put_query(
            "/api/config",
            [("name", name)],
            serde_json::json!({"yaml": yaml}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_update_scenario(
    state: tauri::State<'_, AppState>,
    name: String,
    update: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .put_query("/api/scenario", [("name", name)], update)
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_create_block(
    state: tauri::State<'_, AppState>,
    block: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post("/api/blocks", serde_json::json!({"block": block}))
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_update_block(
    state: tauri::State<'_, AppState>,
    id: String,
    block: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .put_query(
            "/api/blocks",
            [("id", id)],
            serde_json::json!({"block": block}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_delete_block(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .delete_query("/api/blocks", [("id", id)])
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_add_scenario_block(
    state: tauri::State<'_, AppState>,
    scenario: String,
    block: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post_query(
            "/api/scenario/blocks/add",
            [("scenario", scenario)],
            serde_json::json!({"block": block}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_edit_scenario_block(
    state: tauri::State<'_, AppState>,
    scenario: String,
    id: String,
    block: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .put_query(
            "/api/scenario/blocks/edit",
            [("scenario", scenario), ("id", id)],
            serde_json::json!({"block": block}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_delete_scenario_block(
    state: tauri::State<'_, AppState>,
    scenario: String,
    id: String,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post_query(
            "/api/scenario/blocks/delete",
            [("scenario", scenario), ("id", id)],
            serde_json::json!({}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_reorder_scenario_blocks(
    state: tauri::State<'_, AppState>,
    scenario: String,
    blocks: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .put_query(
            "/api/scenario/blocks/reorder",
            [("scenario", scenario)],
            serde_json::json!({"blocks": blocks}),
        )
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_reload(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post("/reload", serde_json::json!({}))
        .await
        .map_err(PylonError::Prism)
}

#[tauri::command]
pub(crate) async fn prism_llm_test(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post("/api/llm/test", serde_json::json!({}))
        .await
        .map_err(PylonError::Prism)
}
