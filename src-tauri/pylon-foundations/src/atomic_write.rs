//! 通用原子写正身（#317 批次二 ③ 自宿主 `agent_config/atomic_write.rs` 下沉）。
//!
//! 依赖方向：本模块只依赖 std（Windows 替换走 windows-sys），宿主 crate 与
//! pylon-session 均可复用——pylon-foundations 不能依赖宿主，故正身必须住这里。
//! 宿主 `agent_config` 的 config 域事务（ConfigLease/CAS/.bak 备份）留在宿主，
//! 直接组合本模块暴露的原语（`write_synced_temp`/`replace_file`/`sync_parent`）。
//!
//! 序列：唯一临时文件（`create_new`，进程内序号防碰撞）+ 写全 + 可选 sync +
//! 原子替换（Windows 走 MoveFileExW，含 WRITE_THROUGH）+ 可选父目录 sync；
//! 任一步失败清理临时文件、原文件不动。错误一律 [`std::io::Error`]，
//! 由调用方映射各自的领域错误。
//!
//! 历史脉络：issue #228 批次 D 把非 agent-config 域的原子写收敛到宿主正身单实现；
//! pylon-foundations 因 crate 依赖方向遗留了一份无 fsync 的弱实现
//! （`workspace.rs::write_atomic`，remove+rename 有丢失窗口），#317 批次二 ③
//! 将正身下沉本模块后，该弱实现改调正身消除。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn unique_sibling(path: &Path, kind: &str) -> Result<PathBuf, std::io::Error> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other(format!("{} 无父目录", path.display())))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other(format!("{} 无文件名", path.display())))?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!(
        ".{}.{kind}-{}-{sequence}",
        file_name.to_string_lossy(),
        std::process::id()
    )))
}

/// `write_synced_temp` 的 sync 开关变体：`sync=false` 保留调用方（MCP/pet 的
/// best-effort 持久化路径）「不 fsync」的历史行为（issue #228 批次D 收敛时点名保留）。
fn write_temp_sibling(
    path: &Path,
    kind: &str,
    content: &[u8],
    sync: bool,
) -> Result<PathBuf, std::io::Error> {
    let temp = unique_sibling(path, kind)?;
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

/// 写 sync 过的临时文件（config 域 `.bak` 备份等显式组合原语的调用方使用）。
pub fn write_synced_temp(
    path: &Path,
    kind: &str,
    content: &[u8],
) -> Result<PathBuf, std::io::Error> {
    write_temp_sibling(path, kind, content, true)
}

/// 通用原子写选项（issue #228 批次D：非 agent-config 域的原子写收敛到正身单实现）。
///
/// 字段用于显式表达各调用方**历史行为差异**（不设 Default，强制调用方具名选择），
/// 收敛时行为零变化；差异本身是否合理见批次D 报告，不在收敛时悄悄改写。
#[derive(Debug, Clone, Copy)]
pub struct AtomicWriteOptions {
    /// rename 前 sync 临时文件内容（掉电时已确认写入不丢）。
    pub sync_temp: bool,
    /// 写入前 create_dir_all 父目录（config 域父目录必然存在，故为 false）。
    pub create_parents: bool,
    /// rename 后 sync 父目录（仅 Unix 有实现；Windows 恒 no-op）。
    pub sync_parent_dir: bool,
}

impl AtomicWriteOptions {
    /// 持久化数据文件语义：fsync 临时文件 + 创建父目录，不 fsync 父目录
    /// （gateway instance_store / credentials 的历史行为）。
    pub fn synced_data_file() -> Self {
        Self {
            sync_temp: true,
            create_parents: true,
            sync_parent_dir: false,
        }
    }

    /// 尽力而为（best-effort）数据文件语义：不 fsync 临时文件、创建父目录
    /// （lifecycle MCP / pet 的历史行为：写失败只告警不阻断主流程）。
    pub fn best_effort_data_file() -> Self {
        Self {
            sync_temp: false,
            create_parents: true,
            sync_parent_dir: false,
        }
    }
}

/// 通用原子写入口（正身）：见模块文档的序列说明。
pub fn write_file_atomically(
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

/// 原子替换：Windows 走 `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`（替换 +
/// 落盘语义一条原语完成）；Unix 走 `rename`。
#[cfg(windows)]
pub fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
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

/// 原子替换（非 Windows）：`rename`。
#[cfg(not(windows))]
pub fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::rename(source, target)
}

/// sync 父目录（仅 Unix 有实现；Windows 恒 no-op）。
#[cfg(unix)]
pub fn sync_parent(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

/// sync 父目录（非 Unix：no-op）。
#[cfg(not(unix))]
pub fn sync_parent(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pylon-foundations-atomic-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// 正身语义：替换既有目标、失败清理临时文件、原文件不动（#317 批次二 ③）。
    #[test]
    fn write_file_atomically_replaces_existing_target_and_cleans_temps() {
        let dir = temp_dir("replace");
        let target = dir.join("data.json");
        std::fs::write(&target, b"v1").expect("seed target");
        write_file_atomically(&target, b"v2", AtomicWriteOptions::synced_data_file())
            .expect("atomic write");
        assert_eq!(std::fs::read(&target).expect("read"), b"v2");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".data.json.")
            })
            .collect();
        assert!(leftovers.is_empty(), "临时文件必须清理：{leftovers:?}");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// best_effort 档位创建父目录（调用方目录缺失时的既有语义）。
    #[test]
    fn best_effort_option_creates_missing_parents() {
        let dir = temp_dir("parents");
        let target = dir.join("nested/dir/data.json");
        write_file_atomically(&target, b"x", AtomicWriteOptions::best_effort_data_file())
            .expect("atomic write with parents");
        assert_eq!(std::fs::read(&target).expect("read"), b"x");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    /// replace_file 语义：目标已存在时覆盖（Windows MOVEFILE_REPLACE_EXISTING /
    /// Unix rename 同义），这是 workspace 弱实现 remove+rename 丢失窗口的消除依据。
    #[test]
    fn replace_file_overwrites_existing_target() {
        let dir = temp_dir("overwrite");
        let source = dir.join("src.tmp");
        let target = dir.join("target.txt");
        std::fs::write(&source, b"new").expect("seed source");
        std::fs::write(&target, b"old").expect("seed target");
        replace_file(&source, &target).expect("replace");
        assert_eq!(std::fs::read(&target).expect("read"), b"new");
        assert!(!source.exists(), "source must be consumed by replace");
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
