use super::*;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) fn read_config_snapshot(
    path: &Path,
) -> Result<(String, HashMap<String, AgentDef>), ConfigError> {
    let _lease = ConfigLease::acquire(path)?;
    let bytes = std::fs::read(path)
        .map_err(|error| ConfigError::Read(format!("读取 {} 失败: {error}", path.display())))?;
    let content = std::str::from_utf8(&bytes).map_err(|error| {
        ConfigError::Parse(format!("配置 {} 不是有效 UTF-8: {error}", path.display()))
    })?;
    let agents = parse_agents(content, path.parent())?;
    Ok((config_revision_for_bytes(&bytes), agents))
}

pub(crate) struct ConfigLease {
    path: PathBuf,
    _file: std::fs::File,
}

impl ConfigLease {
    pub(crate) fn acquire(config_path: &Path) -> Result<Self, ConfigError> {
        let lease_path = config_path.with_file_name(format!(
            ".{}.pylon.lock",
            config_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("agents.yaml"),
        ));

        #[cfg(windows)]
        let file = {
            use std::os::windows::ffi::OsStrExt;
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::Foundation::{
                GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
            };
            use windows_sys::Win32::Storage::FileSystem::{
                CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_DELETE_ON_CLOSE, OPEN_ALWAYS,
            };

            let wide = lease_path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                let error = std::io::Error::last_os_error();
                return Err(if matches!(error.raw_os_error(), Some(32 | 33)) {
                    ConfigError::LockBusy(lease_path.display().to_string())
                } else {
                    ConfigError::Write(format!(
                        "打开配置 lease {} 失败: {error}",
                        lease_path.display()
                    ))
                });
            }
            unsafe { std::fs::File::from_raw_handle(handle as _) }
        };

        #[cfg(unix)]
        let file = {
            use std::os::fd::AsRawFd;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .open(&lease_path)
                .map_err(|error| {
                    ConfigError::Write(format!(
                        "打开配置 lease {} 失败: {error}",
                        lease_path.display()
                    ))
                })?;
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                return Err(
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::PermissionDenied
                    ) {
                        ConfigError::LockBusy(lease_path.display().to_string())
                    } else {
                        ConfigError::Write(format!(
                            "锁定配置 lease {} 失败: {error}",
                            lease_path.display()
                        ))
                    },
                );
            }
            file
        };

        #[cfg(not(any(windows, unix)))]
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lease_path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    ConfigError::LockBusy(lease_path.display().to_string())
                } else {
                    ConfigError::Write(format!(
                        "创建配置 lease {} 失败: {error}",
                        lease_path.display()
                    ))
                }
            })?;

        Ok(Self {
            path: lease_path,
            _file: file,
        })
    }
}

#[cfg(not(any(windows, unix)))]
impl Drop for ConfigLease {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) static CONFIG_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(crate) fn unique_sibling(path: &Path, kind: &str) -> Result<PathBuf, ConfigError> {
    let dir = path
        .parent()
        .ok_or_else(|| ConfigError::Write(format!("{} 无父目录", path.display())))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| ConfigError::Write(format!("{} 无文件名", path.display())))?;
    let sequence = CONFIG_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!(
        ".{}.{kind}-{}-{sequence}",
        file_name.to_string_lossy(),
        std::process::id()
    )))
}

pub(crate) fn cleanup_stale_config_temps(path: &Path) {
    let Some(parent) = path.parent() else { return };
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let prefixes = [
        format!(".{file_name}.tmp-"),
        format!(".{file_name}.bak-tmp-"),
    ];
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if prefixes.iter().any(|prefix| name.starts_with(prefix))
            && entry.file_type().is_ok_and(|kind| kind.is_file())
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub(crate) fn write_synced_temp(
    path: &Path,
    kind: &str,
    content: &[u8],
) -> Result<PathBuf, std::io::Error> {
    write_temp_sibling(path, kind, content, true)
}

/// `write_synced_temp` 的 sync 开关变体：`sync=false` 保留调用方（MCP/pet 的
/// best-effort 持久化路径）「不 fsync」的历史行为（issue #228 批次D 收敛时点名保留）。
fn write_temp_sibling(
    path: &Path,
    kind: &str,
    content: &[u8],
    sync: bool,
) -> Result<PathBuf, std::io::Error> {
    let temp = unique_sibling(path, kind).map_err(std::io::Error::other)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let result = file
        .write_all(content)
        .and_then(|_| if sync { file.sync_all() } else { Ok(()) });
    if let Err(error) = result {
        drop(file);
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(temp)
}

/// 通用原子写选项（issue #228 批次D：非 agent-config 域的原子写收敛到正身单实现）。
///
/// 字段用于显式表达各调用方**历史行为差异**（不设 Default，强制调用方具名选择），
/// 收敛时行为零变化；差异本身是否合理见批次D 报告，不在本次重构内悄悄改写。
/// 正身 config 域自身语义（fsync 临时文件 + fsync 父目录、不创建父目录）仍由
/// `write_config_transaction_*` / [`replace_config_with_backup`] 直接组合原语实现，
/// 不经本结构。
#[derive(Debug, Clone, Copy)]
pub(crate) struct AtomicWriteOptions {
    /// rename 前 sync 临时文件内容（掉电时已确认写入不丢）。
    pub(crate) sync_temp: bool,
    /// 写入前 create_dir_all 父目录（config 域父目录必然存在，故为 false）。
    pub(crate) create_parents: bool,
    /// rename 后 sync 父目录（仅 Unix 有实现；Windows 恒 no-op）。
    pub(crate) sync_parent_dir: bool,
}

impl AtomicWriteOptions {
    /// 持久化数据文件语义：fsync 临时文件 + 创建父目录，不 fsync 父目录
    /// （gateway instance_store / credentials 的历史行为）。
    pub(crate) fn synced_data_file() -> Self {
        Self {
            sync_temp: true,
            create_parents: true,
            sync_parent_dir: false,
        }
    }

    /// 尽力而为（best-effort）数据文件语义：不 fsync 临时文件、创建父目录
    /// （lifecycle MCP / pet 的历史行为：写失败只告警不阻断主流程）。
    pub(crate) fn best_effort_data_file() -> Self {
        Self {
            sync_temp: false,
            create_parents: true,
            sync_parent_dir: false,
        }
    }
}

/// 通用原子写入口：唯一临时文件（`create_new`，与进程内序号防碰撞）+ 写全 +
/// 可选 sync + 原子替换（Windows 走 MoveFileExW，含 WRITE_THROUGH）+ 可选父目录
/// sync；任一步失败清理临时文件、原文件不动。错误一律 [`std::io::Error`]，
/// 由调用方映射各自的领域错误。
pub(crate) fn write_file_atomically(
    path: &Path,
    content: &[u8],
    options: AtomicWriteOptions,
) -> std::io::Result<()> {
    if options.create_parents {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let temp = write_temp_sibling(path, "tmp", content, options.sync_temp)?;
    let commit = replace_file(&temp, path).and_then(|_| {
        if options.sync_parent_dir {
            sync_parent(path)
        } else {
            Ok(())
        }
    });
    if let Err(error) = commit {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target_wide = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::rename(source, target)
}

#[cfg(unix)]
pub(crate) fn sync_parent(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn sync_parent(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[allow(dead_code)] // 测试便捷封装（自带 lease 获取）；生产写路径必须走 under_lease 变体（复用外层 ConfigLease）
pub fn write_config_transaction(
    path: &Path,
    expected: &str,
    candidate: &[u8],
) -> Result<String, ConfigError> {
    let lease = ConfigLease::acquire(path)?;
    write_config_transaction_under_lease(&lease, path, expected, candidate)
}

pub(crate) fn write_config_transaction_under_lease(
    lease: &ConfigLease,
    path: &Path,
    expected: &str,
    candidate: &[u8],
) -> Result<String, ConfigError> {
    validate_config_lease(lease, path)?;
    cleanup_stale_config_temps(path);
    let current = std::fs::read(path)
        .map_err(|error| ConfigError::Read(format!("读取 {} 失败: {error}", path.display())))?;
    let actual = config_revision_for_bytes(&current);
    if actual != expected {
        return Err(ConfigError::Conflict {
            expected: expected.to_string(),
            actual,
        });
    }
    replace_config_with_backup(path, &current, candidate)?;
    Ok(config_revision_for_bytes(candidate))
}

pub(crate) fn validate_config_lease(lease: &ConfigLease, path: &Path) -> Result<(), ConfigError> {
    if lease.path
        != path.with_file_name(format!(
            ".{}.pylon.lock",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("agents.yaml")
        ))
    {
        return Err(ConfigError::LockBusy(format!(
            "lease 与配置路径不匹配: {}",
            path.display()
        )));
    }
    Ok(())
}

pub(crate) fn replace_config_with_backup(
    path: &Path,
    current: &[u8],
    candidate: &[u8],
) -> Result<(), ConfigError> {
    let candidate_temp = write_synced_temp(path, "tmp", candidate).map_err(|error| {
        ConfigError::Write(format!("写候选配置 {} 失败: {error}", path.display()))
    })?;
    let backup = path.with_extension(format!(
        "{}.bak",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
    ));
    let backup_temp = match write_synced_temp(path, "bak-tmp", current) {
        Ok(temp) => temp,
        Err(error) => {
            let _ = std::fs::remove_file(&candidate_temp);
            return Err(ConfigError::Backup(format!(
                "写备份临时文件 {} 失败: {error}",
                backup.display()
            )));
        }
    };
    if let Err(error) = replace_file(&backup_temp, &backup).and_then(|_| sync_parent(&backup)) {
        let _ = std::fs::remove_file(&candidate_temp);
        let _ = std::fs::remove_file(&backup_temp);
        return Err(ConfigError::Backup(format!(
            "替换备份 {} 失败: {error}",
            backup.display()
        )));
    }
    if let Err(error) = replace_file(&candidate_temp, path).and_then(|_| sync_parent(path)) {
        let _ = std::fs::remove_file(&candidate_temp);
        return Err(ConfigError::Write(format!(
            "替换配置 {} 失败: {error}",
            path.display()
        )));
    }
    Ok(())
}

pub(crate) fn write_new_config_under_lease(
    lease: &ConfigLease,
    path: &Path,
    candidate: &[u8],
) -> Result<String, ConfigError> {
    validate_config_lease(lease, path)?;
    cleanup_stale_config_temps(path);
    if path.exists() {
        let actual = config_revision_for_path(path)?;
        return Err(ConfigError::Conflict {
            expected: "<missing>".to_string(),
            actual,
        });
    }
    let temp = write_synced_temp(path, "tmp", candidate).map_err(|error| {
        ConfigError::Write(format!("写配置临时文件 {} 失败: {error}", path.display()))
    })?;
    if path.exists() {
        let _ = std::fs::remove_file(&temp);
        let actual = config_revision_for_path(path)?;
        return Err(ConfigError::Conflict {
            expected: "<missing>".to_string(),
            actual,
        });
    }
    if let Err(error) = replace_file(&temp, path).and_then(|_| sync_parent(path)) {
        let _ = std::fs::remove_file(&temp);
        return Err(ConfigError::Write(format!(
            "创建配置 {} 失败: {error}",
            path.display()
        )));
    }
    Ok(config_revision_for_bytes(candidate))
}
