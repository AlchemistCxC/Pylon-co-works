//! Prism 管理 API 转发命令（R1 拆分自 lib.rs；行为零变化）。
//! 全部为薄转发：Tauri 命令 → PrismClient（本地 Prism HTTP 服务）。
//! R24：同构命令收敛为宏（prism_get! / prism_post! 等 6 模式）——wire
//! 路径/参数/错误码不变；map_err(PylonError::Prism) 单一来源（helper 函数）。

use crate::error::PylonError;
use crate::AppState;

// ── helper：map_err 单一来源（宏展开体不再重复）──

async fn prism_get(
    state: tauri::State<'_, AppState>,
    path: &str,
) -> Result<serde_json::Value, PylonError> {
    state.prism.get(path).await.map_err(PylonError::Prism)
}

async fn prism_get_query<I, K, V>(
    state: tauri::State<'_, AppState>,
    path: &str,
    query: I,
) -> Result<serde_json::Value, PylonError>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    state
        .prism
        .get_query(path, query)
        .await
        .map_err(PylonError::Prism)
}

async fn prism_post(
    state: tauri::State<'_, AppState>,
    path: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    state
        .prism
        .post(path, body)
        .await
        .map_err(PylonError::Prism)
}

async fn prism_post_query<I, K, V>(
    state: tauri::State<'_, AppState>,
    path: &str,
    query: I,
    body: serde_json::Value,
) -> Result<serde_json::Value, PylonError>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    state
        .prism
        .post_query(path, query, body)
        .await
        .map_err(PylonError::Prism)
}

async fn prism_put_query<I, K, V>(
    state: tauri::State<'_, AppState>,
    path: &str,
    query: I,
    body: serde_json::Value,
) -> Result<serde_json::Value, PylonError>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    state
        .prism
        .put_query(path, query, body)
        .await
        .map_err(PylonError::Prism)
}

async fn prism_delete_query<I, K, V>(
    state: tauri::State<'_, AppState>,
    path: &str,
    query: I,
) -> Result<serde_json::Value, PylonError>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    state
        .prism
        .delete_query(path, query)
        .await
        .map_err(PylonError::Prism)
}

// ── 命令宏：同名函数由宏展开生成（lib.rs generate_handler! 注册表不变）──

/// GET 无参命令：`prism_get!(prism_health, "/health")`。
macro_rules! prism_get {
    ($name:ident, $path:literal) => {
        #[tauri::command]
        pub(crate) async fn $name(
            state: tauri::State<'_, AppState>,
        ) -> Result<serde_json::Value, PylonError> {
            prism_get(state, $path).await
        }
    };
}

/// GET 带 query 命令：`prism_get_query!(prism_config, "/api/config", (name: String), [("name", name)])`。
macro_rules! prism_get_query {
    ($name:ident, $path:literal, ($($arg:ident: $ty:ty),*), $query:expr) => {
        #[tauri::command]
        pub(crate) async fn $name(
            state: tauri::State<'_, AppState>,
            $($arg: $ty),*
        ) -> Result<serde_json::Value, PylonError> {
            prism_get_query(state, $path, $query).await
        }
    };
}

/// POST 无 query 命令：`prism_post!(prism_command, "/command", (command: String), json!({...}))`。
macro_rules! prism_post {
    ($name:ident, $path:literal, ($($arg:ident: $ty:ty),*), $body:expr) => {
        #[tauri::command]
        pub(crate) async fn $name(
            state: tauri::State<'_, AppState>,
            $($arg: $ty),*
        ) -> Result<serde_json::Value, PylonError> {
            prism_post(state, $path, $body).await
        }
    };
}

/// POST 带 query 命令：`prism_post_query!(..., (name: String), [("name", name)], json!({}))`。
macro_rules! prism_post_query {
    ($name:ident, $path:literal, ($($arg:ident: $ty:ty),*), $query:expr, $body:expr) => {
        #[tauri::command]
        pub(crate) async fn $name(
            state: tauri::State<'_, AppState>,
            $($arg: $ty),*
        ) -> Result<serde_json::Value, PylonError> {
            prism_post_query(state, $path, $query, $body).await
        }
    };
}

/// PUT 带 query 命令。
macro_rules! prism_put_query {
    ($name:ident, $path:literal, ($($arg:ident: $ty:ty),*), $query:expr, $body:expr) => {
        #[tauri::command]
        pub(crate) async fn $name(
            state: tauri::State<'_, AppState>,
            $($arg: $ty),*
        ) -> Result<serde_json::Value, PylonError> {
            prism_put_query(state, $path, $query, $body).await
        }
    };
}

/// DELETE 带 query 命令。
macro_rules! prism_delete_query {
    ($name:ident, $path:literal, ($($arg:ident: $ty:ty),*), $query:expr) => {
        #[tauri::command]
        pub(crate) async fn $name(
            state: tauri::State<'_, AppState>,
            $($arg: $ty),*
        ) -> Result<serde_json::Value, PylonError> {
            prism_delete_query(state, $path, $query).await
        }
    };
}

// ── GET 无参 ──

prism_get!(prism_health, "/health");
prism_get!(prism_state, "/state");
prism_get!(prism_scenarios, "/api/scenarios");
prism_get!(prism_sources, "/api/sources");
prism_get!(prism_aliases, "/api/aliases");
prism_get!(prism_blocks, "/api/blocks");

// ── GET 带 query ──

prism_get_query!(prism_config, "/api/config", (name: String), [("name", name)]);
prism_get_query!(prism_scenario, "/api/scenario", (name: String), [("name", name)]);
prism_get_query!(prism_source_detail, "/api/source/detail", (name: String), [("name", name)]);
prism_get_query!(prism_source_files, "/api/sources/files", (name: String), [("name", name)]);
prism_get_query!(
    prism_read_source_file,
    "/api/sources/file",
    (name: String, path: String),
    [("name", name), ("path", path)]
);
prism_get_query!(
    prism_source_entries,
    "/api/source/entries",
    (source: String, scenario: String),
    [("source", source), ("scenario", scenario)]
);
prism_get_query!(
    prism_source_entry,
    "/api/source/entry",
    (source: String, scenario: String, uid: String),
    [("source", source), ("scenario", scenario), ("uid", uid)]
);

// ── 条件 query（可选参数逐项拼装，手写保留原语义）──

#[tauri::command]
pub(crate) async fn prism_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    Ok(state.prism.status().await)
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
    prism_get_query(state, "/api/logs", query).await
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
    prism_get_query(state, "/api/chronicle", query).await
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
    prism_get_query(state, "/api/history", query).await
}

// ── POST 无 query ──

prism_post!(prism_inject, "/inject", (request: serde_json::Value), request);
prism_post!(
    prism_command,
    "/command",
    (command: String),
    serde_json::json!({"command": command})
);
prism_post!(
    prism_create_scenario,
    "/api/scenarios",
    (name: String, yaml: String),
    serde_json::json!({"name": name, "yaml": yaml})
);
prism_post!(
    prism_create_source,
    "/api/sources",
    (name: String),
    serde_json::json!({"name": name})
);
prism_post!(
    prism_create_block,
    "/api/blocks",
    (block: serde_json::Value),
    serde_json::json!({"block": block})
);
prism_post!(prism_reload, "/reload", (), serde_json::json!({}));
prism_post!(prism_llm_test, "/api/llm/test", (), serde_json::json!({}));

// ── POST 带 query ──

prism_post_query!(
    prism_delete_scenario,
    "/api/scenarios/delete",
    (name: String),
    [("name", name)],
    serde_json::json!({})
);
prism_post_query!(
    prism_delete_source,
    "/api/sources/delete",
    (name: String),
    [("name", name)],
    serde_json::json!({})
);
prism_post_query!(
    prism_add_source_entry,
    "/api/source/entry/add",
    (source: String, scenario: String, entry: serde_json::Value),
    [("source", source), ("scenario", scenario)],
    serde_json::json!({"entry": entry})
);
prism_post_query!(
    prism_delete_source_entry,
    "/api/source/entry/delete",
    (source: String, scenario: String, uid: String),
    [("source", source), ("scenario", scenario), ("uid", uid)],
    serde_json::json!({})
);
prism_post_query!(
    prism_add_scenario_block,
    "/api/scenario/blocks/add",
    (scenario: String, block: serde_json::Value),
    [("scenario", scenario)],
    serde_json::json!({"block": block})
);
prism_post_query!(
    prism_delete_scenario_block,
    "/api/scenario/blocks/delete",
    (scenario: String, id: String),
    [("scenario", scenario), ("id", id)],
    serde_json::json!({})
);

// ── PUT 带 query ──

prism_put_query!(
    prism_write_source_file,
    "/api/sources/file",
    (name: String, path: String, content: String),
    [("name", name), ("path", path)],
    serde_json::json!({"content": content})
);
prism_put_query!(
    prism_edit_source_entry,
    "/api/source/entry/edit",
    (source: String, scenario: String, uid: String, entry: serde_json::Value),
    [("source", source), ("scenario", scenario), ("uid", uid)],
    serde_json::json!({"entry": entry})
);
prism_put_query!(
    prism_update_config,
    "/api/config",
    (name: String, yaml: String),
    [("name", name)],
    serde_json::json!({"yaml": yaml})
);
prism_put_query!(
    prism_update_scenario,
    "/api/scenario",
    (name: String, update: serde_json::Value),
    [("name", name)],
    update
);
prism_put_query!(
    prism_update_block,
    "/api/blocks",
    (id: String, block: serde_json::Value),
    [("id", id)],
    serde_json::json!({"block": block})
);
prism_put_query!(
    prism_edit_scenario_block,
    "/api/scenario/blocks/edit",
    (scenario: String, id: String, block: serde_json::Value),
    [("scenario", scenario), ("id", id)],
    serde_json::json!({"block": block})
);
prism_put_query!(
    prism_reorder_scenario_blocks,
    "/api/scenario/blocks/reorder",
    (scenario: String, blocks: serde_json::Value),
    [("scenario", scenario)],
    serde_json::json!({"blocks": blocks})
);

// ── DELETE 带 query ──

prism_delete_query!(
    prism_delete_source_file,
    "/api/sources/file",
    (name: String, path: String),
    [("name", name), ("path", path)]
);
prism_delete_query!(prism_delete_block, "/api/blocks", (id: String), [("id", id)]);
