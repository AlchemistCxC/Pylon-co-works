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
