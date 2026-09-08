//! Filesystem request runtime adapted from codeg's file_system_runtime.rs.
//! All operations are bounded and routed through the existing FsAccessPolicy.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Semaphore;

use super::fs_policy::{
    ensure_path_allowed, IO_TIMEOUT, MAX_CONCURRENT_OPS, MAX_FILE_SIZE_BYTES,
    MAX_READ_RESPONSE_BYTES, MAX_WRITE_BYTES,
};

#[derive(Clone)]
pub struct FileSystemRuntime {
    roots: Arc<Vec<PathBuf>>,
    operations: Arc<Semaphore>,
}

impl FileSystemRuntime {
    pub fn new(roots: Vec<PathBuf>) -> Self {
        Self {
            roots: Arc::new(roots),
            operations: Arc::new(Semaphore::new(MAX_CONCURRENT_OPS)),
        }
    }

    pub async fn read_text_file(&self, path: &Path) -> Result<String, String> {
        ensure_path_allowed(path, &self.roots, false)?;
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
        if metadata.len() > MAX_FILE_SIZE_BYTES {
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
        Ok(content)
    }

    pub async fn write_text_file(&self, path: &Path, content: &str) -> Result<(), String> {
        ensure_path_allowed(path, &self.roots, true)?;
        if content.len() > MAX_WRITE_BYTES {
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
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("pylon-fs-runtime-{}", std::process::id()));
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
