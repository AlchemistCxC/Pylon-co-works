//! Upstream filesystem runtime limits and path-policy constants.
//! Execution remains owned by the existing Pylon permission/runtime boundary.

use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MAX_CONCURRENT_OPS: usize = 8;
pub const IO_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_FILE_SIZE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_READ_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
pub const SLOW_OPERATION_MS: u128 = 200;

/// Codeg's strict host policy: both read and write operations are confined to
/// the canonical workspace root.  Runtime execution remains owned by the
/// existing Pylon boundary; this type carries only the upstream policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsAccessPolicy {
    read_roots: Vec<PathBuf>,
    write_roots: Vec<PathBuf>,
}

impl FsAccessPolicy {
    pub fn from_roots(roots: Vec<PathBuf>) -> Self {
        Self {
            read_roots: roots.clone(),
            write_roots: roots,
        }
    }

    pub fn strict(workspace_root: &Path) -> Result<Self, String> {
        let root = std::fs::canonicalize(workspace_root)
            .map_err(|e| format!("cannot access {}: {e}", workspace_root.display()))?;
        Ok(Self {
            read_roots: vec![root.clone()],
            write_roots: vec![root],
        })
    }

    /// Codeg's explicit unrestricted policy. Empty roots are intentional: the
    /// shared containment function treats them as an unrestricted direction.
    pub fn unrestricted() -> Self {
        Self {
            read_roots: Vec::new(),
            write_roots: Vec::new(),
        }
    }

    pub fn confines_reads(&self) -> bool {
        !self.read_roots.is_empty()
    }

    pub fn read_roots(&self) -> &[PathBuf] {
        &self.read_roots
    }

    pub fn write_roots(&self) -> &[PathBuf] {
        &self.write_roots
    }

    pub fn check_read(&self, path: &Path) -> Result<(), FsFailure> {
        if !self.confines_reads() {
            return Ok(());
        }
        ensure_path_allowed(path, self.read_roots(), false)
    }

    pub fn check_write(&self, path: &Path) -> Result<(), FsFailure> {
        ensure_path_allowed(path, self.write_roots(), true)
    }
}

pub fn read_size_allowed(size: u64) -> bool {
    size <= MAX_FILE_SIZE_BYTES
}
pub fn write_size_allowed(size: usize) -> bool {
    size <= MAX_WRITE_BYTES
}

/// #354：fs 负路径的三分类。wire 语义由宿主边界（dispatcher）映射——本 crate
/// 不依赖 wire 码：`NotFound` → `-32002` + `data:{uri}`；`SandboxDenied` →
/// `-32602` + `sandbox:` 稳定前缀；`Other` 维持既有 `-32602` 裸消息（超时/超限/
/// 其余 IO，wire 输出不变）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsFailure {
    /// 请求的文件/目录不存在（含新写目标的父目录缺失）。`uri` 是请求方传入的
    /// 原路径（官方 `resource_not_found` 的 `data.uri` 载荷）。
    NotFound { uri: String },
    /// 沙箱拒绝：路径在允许的 read/write roots 之外。消息文本沿用既有措辞。
    SandboxDenied { message: String },
    /// 其余失败（超时、大小超限、非 NotFound 的 IO 错误等）。
    Other(String),
}

impl FsFailure {
    pub fn message(&self) -> String {
        match self {
            Self::NotFound { uri } => format!("resource not found: {uri}"),
            Self::SandboxDenied { message } => message.clone(),
            Self::Other(message) => message.clone(),
        }
    }
}

/// Codeg `ensure_path_allowed` adapted to Pylon's error boundary. Empty roots
/// are explicitly unrestricted; non-empty roots compare canonical components,
/// including the canonical parent for a new write target. #354：失败按
/// [`FsFailure`] 分类，且**先沙箱判定、后存在性判定**——对最深存在祖先做
/// canonical 包含检查，roots 之外恒为 `SandboxDenied`（不泄漏沙箱外路径的
/// 存在性，杜绝探测预言机）；确认在 roots 内之后，目标自身缺失才是 `NotFound`。
pub fn ensure_path_allowed(
    path: &Path,
    roots: &[PathBuf],
    for_write: bool,
) -> Result<(), FsFailure> {
    if roots.is_empty() {
        return Ok(());
    }
    let path_uri = path.to_string_lossy().into_owned();
    let not_found = || FsFailure::NotFound {
        uri: path_uri.clone(),
    };
    // 从目标自身向上找最深的存在祖先并 canonical 化：目标存在即目标本身，
    // 目标缺失即其存在父目录（读缺文件 / 写新文件统一处理）。
    let mut ancestor = path;
    let canonical = loop {
        match std::fs::canonicalize(ancestor) {
            Ok(resolved) => break resolved,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or_else(|| {
                    FsFailure::Other(format!(
                        "cannot determine parent directory: {}",
                        path.display()
                    ))
                })?;
            }
            Err(e) => {
                return Err(FsFailure::Other(format!(
                    "cannot access {}: {e}",
                    ancestor.display()
                )))
            }
        }
    };
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(FsFailure::SandboxDenied {
            message: format!(
                "path is outside allowed {} roots: {}",
                if for_write { "write" } else { "read" },
                path.display()
            ),
        });
    }
    // 沙箱内才回答存在性：
    // - 目标存在 → Ok；
    // - 读缺失目标 → NotFound；
    // - 写缺失目标：仅允许目标自身缺失（立即父目录存在，新文件合法创建），
    //   向上走的祖先越过立即父目录（中间目录缺失）→ NotFound。
    if std::fs::canonicalize(path).is_ok() {
        return Ok(());
    }
    let immediate_parent_present =
        for_write && path.parent().is_some_and(|parent| ancestor == parent);
    if immediate_parent_present {
        Ok(())
    } else {
        Err(not_found())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upstream_limits_are_stable() {
        assert_eq!(MAX_CONCURRENT_OPS, 8);
        assert_eq!(IO_TIMEOUT, Duration::from_secs(30));
        assert!(read_size_allowed(MAX_FILE_SIZE_BYTES));
        assert!(!read_size_allowed(MAX_FILE_SIZE_BYTES + 1));
        assert!(write_size_allowed(MAX_WRITE_BYTES));
        assert!(!write_size_allowed(MAX_WRITE_BYTES + 1));
        assert_eq!(MAX_READ_RESPONSE_BYTES, 2 * 1024 * 1024);
    }

    #[test]
    fn path_policy_uses_component_containment_and_parent_for_new_writes() {
        let root = std::env::temp_dir().join(format!("pylon-fs-policy-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let allowed = std::fs::canonicalize(&root).unwrap();
        let file = root.join("new.txt");
        assert!(ensure_path_allowed(&file, std::slice::from_ref(&allowed), true).is_ok());
        assert!(
            ensure_path_allowed(&root.join("sibling"), &[allowed.join("not-root")], true).is_err()
        );
        assert!(ensure_path_allowed(&file, &[], true).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strict_policy_uses_one_canonical_workspace_root_for_reads_and_writes() {
        let root = std::env::temp_dir().join(format!("pylon-fs-strict-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let policy = FsAccessPolicy::strict(&root).unwrap();
        assert_eq!(policy.read_roots(), policy.write_roots());
        assert!(policy.check_write(&root.join("new.txt")).is_ok());
        assert!(policy.check_read(&root).is_ok());
        let outside = root.with_file_name(format!(
            "{}-outside",
            root.file_name().unwrap().to_string_lossy()
        ));
        assert!(policy.check_write(&outside.join("new.txt")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unrestricted_policy_has_no_read_or_write_roots() {
        let policy = FsAccessPolicy::unrestricted();
        assert!(!policy.confines_reads());
        assert!(policy.read_roots().is_empty());
        assert!(policy.write_roots().is_empty());
    }

    /// #354：负路径三分类。沙箱判定先于存在性判定——roots 外的路径无论存在
    /// 与否都是 SandboxDenied（不向 agent 泄漏沙箱外路径的存在性）；确认在
    /// roots 内之后，缺失目标（含新写目标的中间目录）才是 NotFound。
    #[test]
    fn failures_classify_not_found_denied_and_never_probe_outside_roots() {
        let root = std::env::temp_dir().join(format!(
            "pylon-fs-policy-class-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let allowed = std::fs::canonicalize(&root).unwrap();
        let roots = std::slice::from_ref(&allowed);

        // roots 内缺失目标（读）→ NotFound，uri 为请求原路径。
        let missing_read = root.join("missing.txt");
        assert_eq!(
            ensure_path_allowed(&missing_read, roots, false),
            Err(FsFailure::NotFound {
                uri: missing_read.to_string_lossy().into_owned()
            })
        );
        // roots 内新写目标且中间目录缺失 → NotFound。
        let nested_write = root.join("no-such-parent").join("new.txt");
        assert!(matches!(
            ensure_path_allowed(&nested_write, roots, true),
            Err(FsFailure::NotFound { .. })
        ));
        // roots 外且目标不存在 → 恒为 SandboxDenied（存在性不外泄）。
        let outside_missing = root.with_file_name(format!(
            "{}-outside-missing",
            root.file_name().unwrap().to_string_lossy()
        ));
        for probe in [false, true] {
            assert!(matches!(
                ensure_path_allowed(&outside_missing.join("x.txt"), roots, probe),
                Err(FsFailure::SandboxDenied { .. })
            ));
        }
        // roots 外（temp 目录本身在 root 之外）→ SandboxDenied，文案保留既有措辞。
        let outside = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        match ensure_path_allowed(&outside.join("x.txt"), roots, true) {
            Err(FsFailure::SandboxDenied { message }) => {
                assert!(message.starts_with("path is outside allowed write roots"));
            }
            other => panic!("expected sandbox denial, got {other:?}"),
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
