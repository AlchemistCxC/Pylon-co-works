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

    pub fn check_read(&self, path: &Path) -> Result<(), String> {
        ensure_path_allowed(path, &self.read_roots, false)
    }

    pub fn check_write(&self, path: &Path) -> Result<(), String> {
        ensure_path_allowed(path, &self.write_roots, true)
    }
}

pub fn read_size_allowed(size: u64) -> bool {
    size <= MAX_FILE_SIZE_BYTES
}
pub fn write_size_allowed(size: usize) -> bool {
    size <= MAX_WRITE_BYTES
}

/// Codeg `ensure_path_allowed` adapted to Pylon's error boundary. Empty roots
/// are explicitly unrestricted; non-empty roots compare canonical components,
/// including the canonical parent for a new write target.
pub fn ensure_path_allowed(path: &Path, roots: &[PathBuf], for_write: bool) -> Result<(), String> {
    if roots.is_empty() {
        return Ok(());
    }
    let target = if !for_write || path.exists() {
        std::fs::canonicalize(path).map_err(|e| format!("cannot access {}: {e}", path.display()))?
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| format!("cannot determine parent directory: {}", path.display()))?;
        if !parent.exists() {
            return Err(format!(
                "parent directory does not exist: {}",
                parent.display()
            ));
        }
        std::fs::canonicalize(parent)
            .map_err(|e| format!("cannot access {}: {e}", parent.display()))?
    };
    if roots.iter().any(|root| target.starts_with(root)) {
        Ok(())
    } else {
        Err(format!(
            "path is outside allowed {} roots: {}",
            if for_write { "write" } else { "read" },
            path.display()
        ))
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
}
