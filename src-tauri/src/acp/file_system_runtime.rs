//! Filesystem request runtime adapted from codeg's file_system_runtime.rs.
//! All operations are bounded and routed through the existing FsAccessPolicy.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::Semaphore;

use super::fs_policy::{
    FsAccessPolicy, IO_TIMEOUT, MAX_CONCURRENT_OPS, MAX_READ_RESPONSE_BYTES, MAX_WRITE_BYTES,
    SLOW_OPERATION_MS,
};

#[derive(Clone)]
pub struct FileSystemRuntime {
    policy: Arc<FsAccessPolicy>,
    operations: Arc<Semaphore>,
}

impl FileSystemRuntime {
    pub fn new(roots: Vec<PathBuf>) -> Self {
        Self {
            policy: Arc::new(if roots.is_empty() {
                FsAccessPolicy::unrestricted()
            } else {
                // Callers provide already-resolved workspace roots; retain the
                // existing fail-closed behavior if policy construction fails.
                FsAccessPolicy::from_roots(roots)
            }),
            operations: Arc::new(Semaphore::new(MAX_CONCURRENT_OPS)),
        }
    }

    pub async fn read_text_file(&self, path: &Path) -> Result<String, String> {
        self.policy.check_read(path)?;
        let started = Instant::now();
        let permit = self
            .operations
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "filesystem runtime is closed".to_string())?;
        let metadata = tokio::time::timeout(IO_TIMEOUT, tokio::fs::metadata(path))
            .await
            .map_err(|_| "filesystem metadata timed out".to_string())?
            .map_err(|e| e.to_string())?;
        if !super::fs_policy::read_size_allowed(metadata.len()) {
            return Err("file exceeds maximum size".to_string());
        }
        let content = tokio::time::timeout(IO_TIMEOUT, tokio::fs::read_to_string(path))
            .await
            .map_err(|_| "filesystem read timed out".to_string())?
            .map_err(|e| e.to_string())?;
        drop(permit);
        if content.len() > MAX_READ_RESPONSE_BYTES {
            return Err("read response exceeds maximum size".to_string());
        }
        if started.elapsed().as_millis() > SLOW_OPERATION_MS {
            tracing::debug!(path = %path.display(), "slow ACP filesystem read");
        }
        Ok(content)
    }

    pub async fn write_text_file(&self, path: &Path, content: &str) -> Result<(), String> {
        self.policy.check_write(path)?;
        let started = Instant::now();
        if !super::fs_policy::write_size_allowed(content.len()) {
            return Err("write content exceeds maximum size".to_string());
        }
        let permit = self
            .operations
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "filesystem runtime is closed".to_string())?;
        tokio::time::timeout(IO_TIMEOUT, tokio::fs::write(path, content))
            .await
            .map_err(|_| "filesystem write timed out".to_string())?
            .map_err(|e| e.to_string())?;
        drop(permit);
        if started.elapsed().as_millis() > SLOW_OPERATION_MS {
            tracing::debug!(path = %path.display(), "slow ACP filesystem write");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pylon-fs-runtime-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn strict_runtime_reads_writes_and_rejects_outside_root() {
        let root = root();
        let runtime = FileSystemRuntime::new(vec![std::fs::canonicalize(&root).unwrap()]);
        let inside = root.join("inside.txt");
        runtime.write_text_file(&inside, "hello").await.unwrap();
        assert_eq!(runtime.read_text_file(&inside).await.unwrap(), "hello");
        let outside = root.with_file_name(format!(
            "{}-outside",
            root.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        assert!(runtime
            .read_text_file(&outside.join("x.txt"))
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn runtime_enforces_write_limit() {
        let root = root();
        let runtime = FileSystemRuntime::new(Vec::new());
        let content = "x".repeat(MAX_WRITE_BYTES + 1);
        assert!(runtime
            .write_text_file(&root.join("too-large"), &content)
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
