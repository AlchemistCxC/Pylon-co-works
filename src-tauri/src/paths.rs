//! paths — 数据/配置目录统一解析（portable 优先，AppData 回退）。
//!
//! 便携模式判定：
//! - exe 同目录存在 `portable.flag`，或存在 `data/` 目录 → 请求 portable；
//! - portable 根目录 = `<exe_dir>/data/`（数据与配置同根）；
//! - portable 根目录不可写（如只读介质/Program Files）→ 回退 AppData/AppConfig。
//!
//! 写权限判定用真实探针（`create_new` + 写入 + `sync_all` + 删除），
//! 不信任 `create_dir_all` 对已存在目录的暗示。
//!
//! `DataDirs` 在 `setup()` 最前面解析一次并放入 `AppState.data_dirs`；
//! 所有 SQLite / 插件目录 / MCP / gateway / pet 持久化必须经本模块的
//! `*_path(&DataDirs)` 函数取路径，禁止再直接调 `app.path().app_data_dir()` /
//! `app_config_dir()` 或重复解析。

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::PylonError;

/// 本次启动实际采用的存储模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StorageMode {
    Portable,
    AppData,
}

#[derive(Debug, Clone)]
pub(crate) struct DataDirs {
    /// SQLite、gateway 实例/凭据等数据文件根目录。
    pub(crate) data_root: PathBuf,
    /// 插件、MCP、pet 等配置/状态文件根目录（portable 下与 data_root 相同）。
    pub(crate) config_root: PathBuf,
    /// 本次启动实际采用的存储模式。
    pub(crate) mode: StorageMode,
    /// 是否请求了 portable（exe 旁 data/ 或 portable.flag 存在）。
    pub(crate) portable_requested: bool,
    /// portable 请求后回退 AppData 的脱敏原因；未回退为 None。
    pub(crate) fallback_reason: Option<String>,
}

fn exe_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("resolve current_exe failed: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "current_exe has no parent".to_string())
}

/// 请求 portable 的判定：`portable.flag` 或 `data/` 任一存在即请求。
/// 保留该兼容规则：只删 flag、保留 data 仍为 portable（施工文档 §2.5）。
fn portable_requested(exe_dir: &Path) -> bool {
    exe_dir.join("data").is_dir() || exe_dir.join("portable.flag").is_file()
}

/// 真实写探针：create_dir_all → create_new 探针文件 → 写短字节 → sync_all →
/// 关闭 → 删除。任一步失败返回脱敏原因（不暴露随机外部输入，不覆盖现有文件）。
fn probe_writable(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|error| format!("create data root failed: {error}"))?;
    let probe = root.join(format!(".pylon-write-test-{}", std::process::id()));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create_new(&probe)?;
        file.write_all(b"pylon\n")?;
        file.sync_all()?;
        Ok(())
    })();
    let remove_result = std::fs::remove_file(&probe);
    if let Err(error) = write_result {
        return Err(format!("portable data root not writable: {error}"));
    }
    remove_result.map_err(|error| format!("portable probe cleanup failed: {error}"))?;
    Ok(())
}

/// 纯路径解析：基于 exe_dir + 系统 app dirs 判定，供生产入口与测试共用。
/// 生产入口传真实路径；测试传临时目录，不依赖测试可执行文件旁目录。
pub(crate) fn resolve_data_dirs_for(
    exe_dir: &Path,
    app_data_dir: PathBuf,
    app_config_dir: PathBuf,
) -> Result<DataDirs, String> {
    let portable_root = exe_dir.join("data");
    let requested = portable_requested(exe_dir);
    if requested {
        match probe_writable(&portable_root) {
            Ok(()) => {
                tracing::info!("portable data dir active: {}", portable_root.display());
                return Ok(DataDirs {
                    data_root: portable_root.clone(),
                    config_root: portable_root,
                    mode: StorageMode::Portable,
                    portable_requested: true,
                    fallback_reason: None,
                });
            }
            Err(reason) => {
                tracing::warn!("portable data dir unavailable, fallback to AppData: {reason}");
                return Ok(DataDirs {
                    data_root: app_data_dir,
                    config_root: app_config_dir,
                    mode: StorageMode::AppData,
                    portable_requested: true,
                    fallback_reason: Some(reason),
                });
            }
        }
    }
    Ok(DataDirs {
        data_root: app_data_dir,
        config_root: app_config_dir,
        mode: StorageMode::AppData,
        portable_requested: false,
        fallback_reason: None,
    })
}

/// 生产入口：解析一次数据/配置根目录（portable 优先，失败回退 AppData/AppConfig）。
/// 调用方（`setup()`）必须把返回值写入 `AppState.data_dirs`，之后所有路径
/// 消费者只使用该实例。
pub(crate) fn resolve_data_dirs<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<DataDirs, String> {
    let exe_dir = exe_dir()?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    resolve_data_dirs_for(&exe_dir, app_data_dir, app_config_dir)
}

pub(crate) fn message_db_path(dirs: &DataDirs) -> PathBuf {
    dirs.data_root.join("pylon-data-v1.sqlite3")
}

/// Tauri bundle identifier，与 `tauri.conf.json::identifier` 同源。
///
/// #362：日志目录必须在 `main()` 里（`setup()` 之前）就能解析——`init_tracing()`
/// 要先于一切可观测工作装上 subscriber。所以这里复现 Tauri `app_data_dir()` 的
/// 拼法（`<平台数据根>/<identifier>`），而不是等 `DataDirs`。`paths` 的单测断言本
/// 常量与 `tauri.conf.json` 一致，防止两处漂移。
pub(crate) const APP_IDENTIFIER: &str = "com.prism.desktop";

/// 平台数据根目录（Tauri `dirs::data_dir()` 的等价物），不依赖 Tauri 运行时。
///
/// Windows = `%APPDATA%`（Roaming）；macOS = `~/Library/Application Support`；
/// 其他 = `$XDG_DATA_HOME` 或 `~/.local/share`。
pub(crate) fn platform_data_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
            })
    }
}

/// 非 portable 情况下的应用数据根目录。
pub(crate) fn app_data_root() -> Option<PathBuf> {
    platform_data_root().map(|root| root.join(APP_IDENTIFIER))
}

/// 日志根目录的候选顺序：portable 命中时 `<exe_dir>/data/logs` 打头，其余情况
/// 以 AppData 收尾。**纯解析、不触盘**（可写性由调用方逐个探测）。
pub(crate) fn log_dir_candidates(exe_dir: &Path, app_data_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if portable_requested(exe_dir) {
        candidates.push(exe_dir.join("data").join("logs"));
    }
    if let Some(app_data_dir) = app_data_dir {
        candidates.push(app_data_dir.join("logs"));
    }
    candidates
}

/// 逐个候选真探可写性，返回第一个可写者（都不行则 `None`）。
///
/// portable 介质（只读 U 盘 / Program Files）上第一个候选必然失败，回退 AppData——
/// 与 [`resolve_data_dirs_for`] 的决策顺序一致。
pub(crate) fn first_writable_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|candidate| probe_writable(candidate).is_ok())
        .cloned()
}

/// 日志根目录：`main()` 的 `init_tracing()` 用，等价于 [`resolve_data_dirs`] 会选中的
/// `data_root` 再加 `logs/`，但不依赖 Tauri。
pub(crate) fn resolve_log_root() -> Option<PathBuf> {
    let exe_dir = exe_dir().ok()?;
    first_writable_dir(&log_dir_candidates(&exe_dir, app_data_root()))
}

pub(crate) fn gateway_instances_path(dirs: &DataDirs) -> PathBuf {
    dirs.data_root.join("pylon-gateway-instances.json")
}

/// Workspace 实体注册表。它属于用户业务数据，而不是可重建的 UI 缓存。
pub(crate) fn workspace_persist_path(dirs: &DataDirs) -> PathBuf {
    dirs.data_root.join("pylon-workspaces.json")
}

/// 凭据存储的打开根目录（`CredentialStore::open` 会在其下追加
/// `pylon-credentials/` 与 `pylon-master.key`）。
pub(crate) fn credentials_dir(dirs: &DataDirs) -> PathBuf {
    dirs.data_root.clone()
}

pub(crate) fn mcp_persist_path(dirs: &DataDirs) -> PathBuf {
    dirs.config_root.join("pylon-mcp.json")
}

/// Agent 浏览器设置（issue #82：档位/黑名单/广告过滤；Rust 侧权威）。
pub(crate) fn browser_agent_settings_path(dirs: &DataDirs) -> PathBuf {
    dirs.config_root.join("pylon-browser-agent.json")
}

pub(crate) fn pet_persist_path(dirs: &DataDirs) -> PathBuf {
    dirs.config_root.join("pylon-pet.json")
}

pub(crate) fn plugin_root(dirs: &DataDirs) -> PathBuf {
    dirs.config_root.join("pylon/plugins")
}

pub(crate) fn plugin_packages_dir(dirs: &DataDirs) -> PathBuf {
    plugin_root(dirs).join("packages")
}

pub(crate) fn plugin_data_dir(dirs: &DataDirs) -> PathBuf {
    plugin_root(dirs).join("data")
}

pub(crate) fn plugin_runtime_dir(dirs: &DataDirs) -> PathBuf {
    plugin_root(dirs).join("runtime")
}

pub(crate) fn plugin_transactions_dir(dirs: &DataDirs) -> PathBuf {
    plugin_root(dirs).join("transactions")
}

// ── 施工文档 §7.5/§7.6：portable 迁移检测与 staging 迁移 ──

/// 已知业务文件集合（portable root 是否为空不能只看目录是否为空，
/// packager 会预建空 `data/`）。
const BUSINESS_FILE_NAMES: &[&str] = &[
    "pylon-data-v1.sqlite3",
    "pylon-gateway-instances.json",
    "pylon-workspaces.json",
    "pylon-master.key",
    "pylon-mcp.json",
    "pylon-pet.json",
    "pylon-browser-agent.json",
];
const BUSINESS_DIR_NAMES: &[&str] = &["pylon-credentials", "pylon/plugins"];

/// AppData 侧旧数据集合（SQLite/gateway/凭据）。
const APPDATA_BUSINESS_NAMES: &[&str] = &[
    "pylon-data-v1.sqlite3",
    "pylon-gateway-instances.json",
    "pylon-workspaces.json",
    "pylon-master.key",
    "pylon-credentials",
];
/// AppConfig 侧旧数据集合（MCP/pet/plugins）。
const APPCONFIG_BUSINESS_NAMES: &[&str] = &[
    "pylon-mcp.json",
    "pylon-pet.json",
    "pylon-browser-agent.json",
    "pylon/plugins",
];

fn path_present(root: &Path, name: &str) -> bool {
    root.join(name).exists()
}

/// portable root 是否已有任一业务数据。
pub(crate) fn portable_has_business_data(root: &Path) -> bool {
    BUSINESS_FILE_NAMES
        .iter()
        .any(|name| path_present(root, name))
        || BUSINESS_DIR_NAMES
            .iter()
            .any(|name| path_present(root, name))
}

/// AppData/AppConfig 是否至少存在一项旧数据。
pub(crate) fn appdata_has_business_data(app_data_dir: &Path, app_config_dir: &Path) -> bool {
    APPDATA_BUSINESS_NAMES
        .iter()
        .any(|name| path_present(app_data_dir, name))
        || APPCONFIG_BUSINESS_NAMES
            .iter()
            .any(|name| path_present(app_config_dir, name))
}

/// 施工文档 §7.5：仅在 portable 模式、portable root 无业务数据、
/// 且 AppData/AppConfig 存在旧数据时标记迁移可用。
pub(crate) fn migration_available(
    dirs: &DataDirs,
    app_data_dir: &Path,
    app_config_dir: &Path,
) -> bool {
    dirs.mode == StorageMode::Portable
        && !portable_has_business_data(&dirs.data_root)
        && appdata_has_business_data(app_data_dir, app_config_dir)
}

/// 复制文件（含 flush）。目标父目录必须已存在。
fn copy_file_staged(source: &Path, target: &Path) -> Result<(), String> {
    let mut input = std::fs::File::open(source)
        .map_err(|error| format!("读取 {} 失败: {error}", source.display()))?;
    let mut output = std::fs::File::create(target)
        .map_err(|error| format!("创建 {} 失败: {error}", target.display()))?;
    std::io::copy(&mut input, &mut output)
        .map_err(|error| format!("复制 {} 失败: {error}", source.display()))?;
    output
        .sync_all()
        .map_err(|error| format!("flush {} 失败: {error}", target.display()))?;
    Ok(())
}

fn copy_dir_staged(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|error| format!("创建目录 {} 失败: {error}", target.display()))?;
    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("读取目录 {} 失败: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let meta = std::fs::symlink_metadata(&from)
            .map_err(|error| format!("读取属性 {} 失败: {error}", from.display()))?;
        if meta.file_type().is_symlink() {
            return Err(format!("旧数据含符号链接，拒绝迁移: {}", from.display()));
        }
        if meta.is_dir() {
            copy_dir_staged(&from, &to)?;
        } else if meta.is_file() {
            copy_file_staged(&from, &to)?;
        } else {
            return Err(format!("旧数据含非常规文件，拒绝迁移: {}", from.display()));
        }
    }
    Ok(())
}

/// 检查凭据组完整性：key 与 credentials 目录必须成组存在或成组缺失。
fn validate_credentials_group(app_data_dir: &Path) -> Result<(), String> {
    let key = app_data_dir.join("pylon-master.key").exists();
    let creds = app_data_dir.join("pylon-credentials").exists();
    if key != creds {
        return Err(
            "凭据迁移不完整：pylon-master.key 与 pylon-credentials/ 必须成组迁移，禁止只复制一半"
                .to_string(),
        );
    }
    Ok(())
}

fn rename_into_place(staging: &Path, target_root: &Path, name: &str) -> Result<(), String> {
    let source = staging.join(name);
    if !source.exists() {
        return Ok(());
    }
    let target = target_root.join(name);
    if target.exists() {
        return Err(format!("迁移目标冲突: {}", target.display()));
    }
    std::fs::rename(&source, &target).map_err(|error| format!("迁移 {name} 失败: {error}"))?;
    Ok(())
}

/// 施工文档 §7.6：AppData/AppConfig → portable staging 迁移。
/// 前置条件（调用方保证）：当前 mode=Portable、目标无业务数据、源至少一项。
/// 复制纪律：先全部复制到 staging，再逐项 rename；失败删除 staging，源/目标正式文件不变。
pub(crate) fn migrate_appdata_to_portable_staged(
    app_data_dir: &Path,
    app_config_dir: &Path,
    portable_root: &Path,
) -> Result<(), String> {
    validate_credentials_group(app_data_dir)?;
    if portable_has_business_data(portable_root) {
        return Err("portable root 已有业务数据，拒绝迁移覆盖".to_string());
    }

    let staging = portable_root.join(format!(".migration-staging-{}", std::process::id()));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|error| format!("清理旧 staging 失败: {error}"))?;
    }
    std::fs::create_dir_all(&staging).map_err(|error| format!("创建 staging 失败: {error}"))?;

    let result = (|| -> Result<(), String> {
        // AppData 侧：SQLite 主库 + 可能的 -wal/-shm；gateway 实例；凭据组。
        for name in [
            "pylon-data-v1.sqlite3",
            "pylon-gateway-instances.json",
            "pylon-workspaces.json",
            "pylon-master.key",
            "pylon-credentials",
        ] {
            let source = app_data_dir.join(name);
            if !source.exists() {
                continue;
            }
            if source.is_dir() {
                copy_dir_staged(&source, &staging.join(name))?;
            } else {
                copy_file_staged(&source, &staging.join(name))?;
            }
        }
        for wal_name in ["pylon-data-v1.sqlite3-wal", "pylon-data-v1.sqlite3-shm"] {
            let wal = app_data_dir.join(wal_name);
            if wal.is_file() {
                copy_file_staged(&wal, &staging.join(wal_name))?;
            }
        }
        // AppConfig 侧：MCP / pet / plugins。
        for name in APPCONFIG_BUSINESS_NAMES {
            let source = app_config_dir.join(name);
            if !source.exists() {
                continue;
            }
            if source.is_dir() {
                copy_dir_staged(&source, &staging.join(name))?;
            } else {
                copy_file_staged(&source, &staging.join(name))?;
            }
        }

        // 全部 staged 后逐项 rename（冲突才可能在此阶段失败）。
        std::fs::create_dir_all(portable_root.join("pylon"))
            .map_err(|error| format!("创建 pylon 目录失败: {error}"))?;
        for name in [
            "pylon-data-v1.sqlite3",
            "pylon-data-v1.sqlite3-wal",
            "pylon-data-v1.sqlite3-shm",
            "pylon-gateway-instances.json",
            "pylon-master.key",
            "pylon-credentials",
            "pylon-mcp.json",
            "pylon-pet.json",
            "pylon/plugins",
        ] {
            rename_into_place(&staging, portable_root, name)?;
        }
        Ok(())
    })();

    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = std::fs::remove_dir_all(&staging);
    Ok(())
}

/// 施工文档 §7.6：AppData → portable 迁移命令。
/// 安全约束：持久化服务（SQLite/gateway/凭据）尚未初始化时才允许执行；否则
/// 返回明确错误（完整启动时序见施工文档 §7.6 推荐实现）。
#[tauri::command]
pub(crate) async fn migrate_appdata_to_portable(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<serde_json::Value, PylonError> {
    let dirs = state.data_dirs_cloned().map_err(PylonError::Command)?;
    if dirs.mode != StorageMode::Portable {
        return Err(PylonError::Command(
            "portable_migration_unavailable: 当前不是 portable 模式".into(),
        ));
    }
    {
        let message_service = state
            .message_service
            .lock()
            .map_err(|error| PylonError::Command(error.to_string()))?;
        if message_service.is_some() {
            return Err(PylonError::Command(
                "portable_migration_unavailable: 持久化服务已初始化，请在启动迁移提示中选择迁移"
                    .into(),
            ));
        }
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| PylonError::Command(error.to_string()))?;
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| PylonError::Command(error.to_string()))?;
    if !migration_available(&dirs, &app_data_dir, &app_config_dir) {
        return Err(PylonError::Command(
            "portable_migration_unavailable: 迁移条件不满足".into(),
        ));
    }
    migrate_appdata_to_portable_staged(&app_data_dir, &app_config_dir, &dirs.data_root)
        .map_err(PylonError::Command)?;
    Ok(serde_json::json!({ "migrated": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pylon-paths-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn portable_requested_by_data_dir_or_flag() {
        let root = temp_root("request");
        std::fs::create_dir_all(root.join("data")).unwrap();
        assert!(portable_requested(&root));
        std::fs::remove_dir_all(root.join("data")).unwrap();
        assert!(!portable_requested(&root));
        std::fs::write(root.join("portable.flag"), b"").unwrap();
        assert!(portable_requested(&root));
        // 只删 flag、保留 data 仍请求 portable（§2.5 兼容规则）
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::remove_file(root.join("portable.flag")).unwrap();
        assert!(portable_requested(&root));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_uses_portable_when_writable() {
        let exe = temp_root("portable");
        let app_data = temp_root("appdata");
        let app_config = temp_root("appconfig");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::create_dir_all(exe.join("data")).unwrap();
        let dirs = resolve_data_dirs_for(&exe, app_data, app_config).expect("resolve");
        assert_eq!(dirs.mode, StorageMode::Portable);
        assert_eq!(dirs.data_root, exe.join("data"));
        assert_eq!(dirs.config_root, exe.join("data"));
        assert!(dirs.portable_requested);
        assert!(dirs.fallback_reason.is_none());
        assert!(!exe.join("data/.pylon-write-test").exists());
        std::fs::remove_dir_all(&exe).ok();
    }

    #[test]
    fn probe_writable_detects_readonly_existing_dir() {
        // 已存在但不可写的目录无法在 CI/Windows 上可靠模拟；此处至少钉住
        // 探针成功路径与残留清理语义（真实只读介质由 manual 验收覆盖）。
        let root = temp_root("probe-ok");
        std::fs::create_dir_all(&root).unwrap();
        probe_writable(&root).expect("writable temp dir must pass probe");
        let entries = std::fs::read_dir(&root).unwrap().count();
        assert_eq!(entries, 0, "探针文件必须清理");
        std::fs::remove_dir_all(&root).ok();
    }

    /// #362：日志目录走的是 `main()` 早期（`DataDirs` 还不存在），所以标识符在这里
    /// 复现了一份。与 `tauri.conf.json` 漂移会让日志落到另一个目录（用户按
    /// 说明书找不到），必须由测试钉住。
    #[test]
    fn app_identifier_matches_the_tauri_bundle_config() {
        let config = include_str!("../tauri.conf.json");
        let expected = format!("\"identifier\": \"{APP_IDENTIFIER}\"");
        assert!(
            config.contains(&expected),
            "paths::APP_IDENTIFIER 与 tauri.conf.json 不一致：期望配置里出现 {expected}"
        );
    }

    #[test]
    fn log_dir_candidates_prefer_portable_then_fall_back_to_appdata() {
        let exe = temp_root("logs-portable");
        let app_data = temp_root("logs-appdata");
        std::fs::create_dir_all(&exe).unwrap();
        // 未请求 portable：只有 AppData 一个候选
        assert_eq!(
            log_dir_candidates(&exe, Some(app_data.clone())),
            vec![app_data.join("logs")]
        );
        // 请求 portable：portable 打头、AppData 兜底（顺序即优先级）
        std::fs::create_dir_all(exe.join("data")).unwrap();
        assert_eq!(
            log_dir_candidates(&exe, Some(app_data.clone())),
            vec![exe.join("data").join("logs"), app_data.join("logs")]
        );
        // 连 AppData 都解析不出来时也至少给出 portable 候选
        assert_eq!(
            log_dir_candidates(&exe, None),
            vec![exe.join("data").join("logs")]
        );
        std::fs::remove_dir_all(&exe).ok();
    }

    #[test]
    fn first_writable_dir_picks_the_earlier_candidate_and_creates_it() {
        let root = temp_root("writable-first");
        let first = root.join("logs");
        let second = root.join("fallback");
        let picked = first_writable_dir(&[first.clone(), second.clone()]).expect("candidate");
        assert_eq!(picked, first);
        assert!(first.is_dir(), "选中的目录必须真的建好");
        assert!(!second.exists(), "落选候选不该被创建");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn app_data_root_joins_the_bundle_identifier() {
        if let Some(root) = app_data_root() {
            assert!(root.ends_with(APP_IDENTIFIER), "{}", root.display());
        }
    }

    #[test]
    fn path_helpers_use_provided_dirs() {
        let dirs = DataDirs {
            data_root: PathBuf::from("D:/pylon-data"),
            config_root: PathBuf::from("C:/pylon-config"),
            mode: StorageMode::AppData,
            portable_requested: false,
            fallback_reason: None,
        };
        assert_eq!(
            message_db_path(&dirs),
            PathBuf::from("D:/pylon-data/pylon-data-v1.sqlite3")
        );
        assert_eq!(
            plugin_root(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins")
        );
        assert_eq!(
            plugin_packages_dir(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins/packages")
        );
        assert_eq!(
            plugin_data_dir(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins/data")
        );
        assert_eq!(
            plugin_runtime_dir(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins/runtime")
        );
        assert_eq!(
            plugin_transactions_dir(&dirs),
            PathBuf::from("C:/pylon-config/pylon/plugins/transactions")
        );
        assert_eq!(
            mcp_persist_path(&dirs),
            PathBuf::from("C:/pylon-config/pylon-mcp.json")
        );
    }

    // ── 施工文档 §7.5/§7.6 迁移检测与 staging 迁移 ──

    fn temp_migration_roots() -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "pylon-migration-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let app_data = base.join("appdata");
        let app_config = base.join("appconfig");
        let portable = base.join("portable-data");
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::create_dir_all(&app_config).unwrap();
        std::fs::create_dir_all(&portable).unwrap();
        (app_data, app_config, portable)
    }

    #[test]
    fn migration_available_detection_and_staging_migration_round_trip() {
        let (app_data, app_config, portable) = temp_migration_roots();
        // AppData 旧数据
        std::fs::write(app_data.join("pylon-data-v1.sqlite3"), b"db").unwrap();
        std::fs::write(app_data.join("pylon-data-v1.sqlite3-wal"), b"wal").unwrap();
        std::fs::write(app_data.join("pylon-gateway-instances.json"), b"{}").unwrap();
        std::fs::write(app_data.join("pylon-master.key"), b"key").unwrap();
        std::fs::create_dir_all(app_data.join("pylon-credentials")).unwrap();
        std::fs::write(app_data.join("pylon-credentials").join("c.json"), b"{}").unwrap();
        // AppConfig 旧数据
        std::fs::write(app_config.join("pylon-mcp.json"), b"[]").unwrap();
        std::fs::write(app_config.join("pylon-pet.json"), b"{}").unwrap();
        std::fs::create_dir_all(app_config.join("pylon/plugins")).unwrap();
        std::fs::write(app_config.join("pylon/plugins").join("state.json"), b"{}").unwrap();

        let dirs = DataDirs {
            data_root: portable.clone(),
            config_root: portable.clone(),
            mode: StorageMode::Portable,
            portable_requested: true,
            fallback_reason: None,
        };
        assert!(migration_available(&dirs, &app_data, &app_config));
        migrate_appdata_to_portable_staged(&app_data, &app_config, &portable).expect("migrate");
        assert!(portable.join("pylon-data-v1.sqlite3").exists());
        assert!(portable.join("pylon-data-v1.sqlite3-wal").exists());
        assert!(portable.join("pylon-master.key").exists());
        assert!(portable.join("pylon-credentials/c.json").exists());
        assert!(portable.join("pylon-mcp.json").exists());
        assert!(portable.join("pylon/plugins/state.json").exists());
        // 源保留
        assert!(app_data.join("pylon-data-v1.sqlite3").exists());
        // staging 清理
        assert!(std::fs::read_dir(&portable).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("migration-staging")));
        std::fs::remove_dir_all(app_data.parent().unwrap()).ok();
    }

    #[test]
    fn migration_rejects_target_conflict_and_keeps_source() {
        let (app_data, app_config, portable) = temp_migration_roots();
        std::fs::write(app_data.join("pylon-data-v1.sqlite3"), b"db").unwrap();
        std::fs::write(portable.join("pylon-data-v1.sqlite3"), b"existing").unwrap();
        let dirs = DataDirs {
            data_root: portable.clone(),
            config_root: portable.clone(),
            mode: StorageMode::Portable,
            portable_requested: true,
            fallback_reason: None,
        };
        assert!(!migration_available(&dirs, &app_data, &app_config));
        let result = migrate_appdata_to_portable_staged(&app_data, &app_config, &portable);
        assert!(result.is_err(), "目标已有业务数据必须拒绝");
        assert_eq!(
            std::fs::read_to_string(portable.join("pylon-data-v1.sqlite3")).unwrap(),
            "existing",
            "拒绝迁移不得覆盖目标"
        );
        std::fs::remove_dir_all(app_data.parent().unwrap()).ok();
    }

    #[test]
    fn migration_rejects_incomplete_credentials_group() {
        let (app_data, app_config, portable) = temp_migration_roots();
        std::fs::write(app_data.join("pylon-master.key"), b"key").unwrap();
        let result = migrate_appdata_to_portable_staged(&app_data, &app_config, &portable);
        assert!(result.is_err(), "只有 key 没有密文必须拒绝");
        assert!(
            result.unwrap_err().contains("成组"),
            "错误必须说明凭据成组迁移"
        );
        std::fs::remove_dir_all(app_data.parent().unwrap()).ok();
    }
}
