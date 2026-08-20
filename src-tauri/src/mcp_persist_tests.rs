use super::*;

use std::collections::HashMap;

fn sample_servers() -> Vec<mcp::McpServerConfig> {
    vec![
        mcp::McpServerConfig {
            id: Some("files".into()),
            name: None,
            transport: "stdio".into(),
            enabled: true,
            command: Some("npx".into()),
            args: vec!["-y".into(), "mcp-server-filesystem".into()],
            env: [("API_TOKEN".to_string(), "secret-value".to_string())]
                .into_iter()
                .collect(),
            url: None,
            headers: HashMap::new(),
            oauth: None,
            disabled: false,
        },
        mcp::McpServerConfig {
            id: None,
            name: Some("remote".into()),
            transport: "http".into(),
            enabled: true,
            command: None,
            args: Vec::new(),
            env: HashMap::new(),
            url: Some("http://127.0.0.1:3000/mcp".into()),
            headers: [("Authorization".to_string(), "Bearer x".to_string())]
                .into_iter()
                .collect(),
            oauth: None,
            disabled: false,
        },
    ]
}

#[test]
fn load_round_trips_servers_with_secrets() {
    let dir = std::env::temp_dir().join(format!("pylon-mcp-dir-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("pylon-mcp.json");
    std::fs::write(&path, serde_json::to_string(&sample_servers()).unwrap()).unwrap();
    let loaded = load_mcp_persisted(&path).expect("valid file must load");
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].id.as_deref(), Some("files"));
    assert_eq!(
        loaded[0].env.get("API_TOKEN").map(String::as_str),
        Some("secret-value"),
        "secret 必须保留（本地配置文件）"
    );
    assert_eq!(loaded[1].url.as_deref(), Some("http://127.0.0.1:3000/mcp"));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn load_missing_or_corrupt_returns_none() {
    let dir = std::env::temp_dir().join(format!("pylon-mcp-bad-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let missing = dir.join("missing.json");
    assert!(load_mcp_persisted(&missing).is_none(), "缺失文件应降级");
    let corrupt = dir.join("corrupt.json");
    std::fs::write(&corrupt, "{not json").unwrap();
    assert!(load_mcp_persisted(&corrupt).is_none(), "损坏文件应降级");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn load_rejects_hand_edited_invalid_config() {
    let dir = std::env::temp_dir().join(format!("pylon-mcp-invalid-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("invalid.json");
    // 重复 identity：validate 应拒绝 → 整体不加载（防手改文件注入非法配置）
    let invalid = serde_json::json!([
        {"id": "dup", "transport": "stdio", "command": "a"},
        {"id": "dup", "transport": "stdio", "command": "b"}
    ]);
    std::fs::write(&path, invalid.to_string()).unwrap();
    assert!(load_mcp_persisted(&path).is_none());
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn set_mcp_servers_persists_to_disk_and_restores() {
    let dir = std::env::temp_dir().join(format!(
        "pylon-mcp-set-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let dirs = crate::paths::DataDirs {
        data_root: dir.clone(),
        config_root: dir.clone(),
        mode: crate::paths::StorageMode::AppData,
        portable_requested: false,
        fallback_reason: None,
    };
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app must build");
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("")
        .with_data_dirs(dirs.clone())
        .build();
    app.manage(state);
    let path = crate::paths::mcp_persist_path(&dirs);
    let _ = std::fs::remove_file(&path);

    set_mcp_servers(app.state::<AppState>(), Some(sample_servers()))
        .await
        .expect("set_mcp_servers must succeed");
    let loaded = load_mcp_persisted(&path).expect("命令后文件必须存在且可加载");
    assert_eq!(loaded.len(), 2);
    assert_eq!(
        loaded[0].env.get("API_TOKEN").map(String::as_str),
        Some("secret-value")
    );

    // 清空配置 → 落盘空数组（非删除）
    set_mcp_servers(app.state::<AppState>(), Some(Vec::new()))
        .await
        .expect("clear must succeed");
    let cleared = load_mcp_persisted(&path).expect("cleared file must load");
    assert!(cleared.is_empty());
    let _ = std::fs::remove_file(&path);
    std::fs::remove_dir_all(&dir).ok();
}
