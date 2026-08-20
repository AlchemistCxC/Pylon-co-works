//! Gateway 实例配置持久化（ISSUE-12 W4：重启加载实例）。
//!
//! 只持久化**非敏感**配置（id/platform/label/enabled/auto_start）——凭据走
//! credentials.rs 加密存储，状态/错误是运行时数据不落盘（重启后统一置 Stopped）。
//!
//! 契约：
//! - versioned envelope `{ version: 1, instances: [...] }`，JSON 单文件。
//! - 原子写：临时文件 + flush/sync + rename（写失败不残留半文件，原文件不动）。
//! - 损坏文件 → 结构化错误（可见上报），**保留原文件不覆盖**（诊断/恢复现场）；
//!   文件缺失 → 空列表（首启）。
//! - 校验：id/platform 非空；重复 id → 损坏（应用自写文件出现重复 = 外部破坏）。

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// 实例配置快照文件版本（新增字段时 bump；读取未知版本 → 损坏）。
pub(crate) const INSTANCE_STORE_VERSION: u32 = 1;

/// 非敏感实例配置（DTO 级；不含凭据值/运行状态——见模块头）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredInstance {
    pub(crate) id: String,
    pub(crate) platform: String,
    pub(crate) label: String,
    pub(crate) enabled: bool,
    pub(crate) auto_start: bool,
}

/// 持久化文件 envelope。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceStoreSnapshot {
    version: u32,
    instances: Vec<StoredInstance>,
}

/// 实例配置存储错误：损坏（不覆盖原文件）与 IO（路径/写失败）。
#[derive(Debug, thiserror::Error)]
pub(crate) enum InstanceStoreError {
    #[error("实例配置文件损坏：{0}")]
    Corrupt(String),
    #[error("实例配置读写失败：{0}")]
    Io(String),
}

impl InstanceStoreError {
    /// 机器可读错误码（稳定）。
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Corrupt(_) => "instance_store_corrupt",
            Self::Io(_) => "instance_store_io",
        }
    }
}

fn now_path_suffix() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_default()
}

/// 校验实例列表：id/platform 非空、id 不重复。非法 → 损坏错误。
pub(crate) fn validate_stored_instances(
    instances: &[StoredInstance],
) -> Result<(), InstanceStoreError> {
    let mut seen = std::collections::HashSet::new();
    for instance in instances {
        if instance.id.trim().is_empty() {
            return Err(InstanceStoreError::Corrupt("实例 id 为空".to_string()));
        }
        if instance.platform.trim().is_empty() {
            return Err(InstanceStoreError::Corrupt(format!(
                "实例 '{}' 的 platform 为空",
                instance.id
            )));
        }
        if !seen.insert(instance.id.as_str()) {
            return Err(InstanceStoreError::Corrupt(format!(
                "重复的实例 id: {}",
                instance.id
            )));
        }
    }
    Ok(())
}

/// 从磁盘加载实例配置；文件缺失 → 空列表；损坏 → Err（原文件保留）。
pub(crate) fn load_instances(path: &Path) -> Result<Vec<StoredInstance>, InstanceStoreError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(InstanceStoreError::Io(error.to_string())),
    };
    let snapshot: InstanceStoreSnapshot = serde_json::from_str(&raw)
        .map_err(|error| InstanceStoreError::Corrupt(format!("JSON 解析失败: {error}")))?;
    if snapshot.version != INSTANCE_STORE_VERSION {
        return Err(InstanceStoreError::Corrupt(format!(
            "未知 envelope version {}（当前支持 {}）",
            snapshot.version, INSTANCE_STORE_VERSION
        )));
    }
    validate_stored_instances(&snapshot.instances)?;
    Ok(snapshot.instances)
}

/// 原子写实例配置：临时文件 + flush/sync + rename（同一目录，保证 rename 原子）。
/// 失败返回 Err，原文件保持不动（无半写入残留）。
pub(crate) fn persist_instances(
    path: &Path,
    instances: &[StoredInstance],
) -> Result<(), InstanceStoreError> {
    validate_stored_instances(instances)?;
    let snapshot = InstanceStoreSnapshot {
        version: INSTANCE_STORE_VERSION,
        instances: instances.to_vec(),
    };
    let serialized = serde_json::to_string_pretty(&snapshot)
        .map_err(|error| InstanceStoreError::Io(format!("序列化失败: {error}")))?;
    let parent = path
        .parent()
        .ok_or_else(|| InstanceStoreError::Io(format!("无法解析父目录: {}", path.display())))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| InstanceStoreError::Io(format!("创建目录失败: {error}")))?;
    let temp_path = path.with_extension(format!(
        "json.tmp-{}-{}",
        std::process::id(),
        now_path_suffix()
    ));
    let result = (|| -> Result<(), InstanceStoreError> {
        let file = File::create(&temp_path)
            .map_err(|error| InstanceStoreError::Io(format!("创建临时文件失败: {error}")))?;
        let mut writer = BufWriter::new(file);
        writer
            .write_all(serialized.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| InstanceStoreError::Io(format!("写临时文件失败: {error}")))?;
        writer
            .get_ref()
            .sync_all()
            .map_err(|error| InstanceStoreError::Io(format!("sync 临时文件失败: {error}")))?;
        drop(writer);
        std::fs::rename(&temp_path, path)
            .map_err(|error| InstanceStoreError::Io(format!("rename 到目标失败: {error}")))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_path() -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "pylon-gateway-instances-test-{}-{}-{}.json",
            std::process::id(),
            n,
            nanos
        ))
    }

    fn instance(id: &str, platform: &str) -> StoredInstance {
        StoredInstance {
            id: id.into(),
            platform: platform.into(),
            label: format!("label-{id}"),
            enabled: true,
            auto_start: false,
        }
    }

    #[test]
    fn roundtrip_persist_and_load() {
        let path = unique_temp_path();
        let instances = vec![instance("a", "qq"), instance("b", "wechat")];
        persist_instances(&path, &instances).expect("persist");
        assert_eq!(load_instances(&path).expect("load"), instances);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_file_loads_empty() {
        let path = unique_temp_path();
        let instances = load_instances(&path).expect("load");
        assert!(instances.is_empty());
    }

    #[test]
    fn corrupt_file_errors_and_preserves_original() {
        let path = unique_temp_path();
        persist_instances(&path, &[instance("a", "qq")]).expect("persist");
        let original = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, "{ not valid json").unwrap();
        let error = load_instances(&path).expect_err("must error");
        assert_eq!(error.code(), "instance_store_corrupt");
        // 原文件保留（未被覆盖）
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not valid json");
        let _ = std::fs::remove_file(&path);
        let _ = original;
    }

    #[test]
    fn unknown_version_is_corrupt() {
        let path = unique_temp_path();
        std::fs::write(
            &path,
            r#"{"version": 99, "instances": [{"id":"a","platform":"qq","label":"l","enabled":true,"autoStart":false}]}"#,
        )
        .unwrap();
        let error = load_instances(&path).expect_err("must error");
        assert_eq!(error.code(), "instance_store_corrupt");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn duplicate_id_is_corrupt() {
        let path = unique_temp_path();
        std::fs::write(
            &path,
            r#"{"version": 1, "instances": [
                {"id":"a","platform":"qq","label":"l","enabled":true,"autoStart":false},
                {"id":"a","platform":"qq","label":"l2","enabled":false,"autoStart":false}
            ]}"#,
        )
        .unwrap();
        let error = load_instances(&path).expect_err("must error");
        assert_eq!(error.code(), "instance_store_corrupt");
        assert!(error.to_string().contains("重复"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn empty_id_or_platform_is_corrupt_on_persist() {
        let path = unique_temp_path();
        let bad = StoredInstance {
            id: String::new(),
            platform: "qq".into(),
            label: "l".into(),
            enabled: true,
            auto_start: false,
        };
        let error = persist_instances(&path, &[bad]).expect_err("must error");
        assert_eq!(error.code(), "instance_store_corrupt");
        // 校验失败不落盘（无文件残留）
        assert!(!path.exists());
    }

    #[test]
    fn atomic_persist_leaves_no_temp_files() {
        let path = unique_temp_path();
        persist_instances(&path, &[instance("a", "qq")]).expect("persist");
        // 只检查本测试文件族的临时残留（全局 temp 目录有其他并发测试的 .tmp- 文件，
        // 不得误判）
        let parent = path.parent().unwrap();
        let stem = path.file_name().unwrap().to_string_lossy().into_owned();
        let leftovers: Vec<_> = std::fs::read_dir(parent)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.contains(&stem) && name.contains(".tmp-")
            })
            .collect();
        assert!(leftovers.is_empty(), "不得残留临时文件");
        let _ = std::fs::remove_file(&path);
    }
}
