//! 只读工作区访问：所有路径先经过 containment 校验，再执行文件系统操作。

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const DEFAULT_PREVIEW_BYTES: usize = 256 * 1024;
pub const MAX_PREVIEW_BYTES: usize = 1024 * 1024;
pub const MAX_DIRECTORY_ENTRIES: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceError {
    AbsolutePathRejected,
    TraversalRejected,
    OutsideRoot,
    NotFound,
    NotReadable,
    NotFile,
    BinaryFile,
    TooManyEntries,
    Io(String),
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (code, message) = match self {
            Self::AbsolutePathRejected => ("absolute_path_rejected", "不允许使用绝对路径"),
            Self::TraversalRejected => ("traversal_rejected", "不允许路径穿越"),
            Self::OutsideRoot => ("outside_root", "路径位于工作区之外"),
            Self::NotFound => ("not_found", "路径不存在"),
            Self::NotReadable => ("not_readable", "路径不可读取"),
            Self::NotFile => ("not_file", "路径不是文件"),
            Self::BinaryFile => ("binary_file", "文件不是可预览的 UTF-8 文本"),
            Self::TooManyEntries => ("too_many_entries", "目录条目超过限制"),
            Self::Io(_) => ("io_error", "工作区 I/O 操作失败"),
        };
        write!(f, "{code}: {message}")
    }
}

impl std::error::Error for WorkspaceError {}

fn normalize_relative(relative: &str) -> Result<PathBuf, WorkspaceError> {
    if relative.trim().is_empty() {
        return Ok(PathBuf::from("."));
    }
    let normalized = relative.replace('\\', "/");
    if normalized.starts_with('/') || normalized.starts_with("//") {
        return Err(WorkspaceError::AbsolutePathRejected);
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." { continue; }
        if part == ".." { return Err(WorkspaceError::TraversalRejected); }
        if part.contains(':') { return Err(WorkspaceError::AbsolutePathRejected); }
        parts.push(part);
    }
    if parts.is_empty() { Ok(PathBuf::from(".")) } else { Ok(parts.iter().collect()) }
}

/// 解析并校验工作区内的现有路径。不存在路径统一返回 NotFound。
pub fn resolve_workspace_path(root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError> {
    let relative = normalize_relative(relative)?;
    let canonical_root = root.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { WorkspaceError::NotFound } else { WorkspaceError::NotReadable }
    })?;
    let candidate = canonical_root.join(relative);
    let canonical = candidate.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { WorkspaceError::NotFound } else { WorkspaceError::NotReadable }
    })?;
    if canonical == canonical_root || canonical.starts_with(&canonical_root) {
        Ok(canonical)
    } else {
        Err(WorkspaceError::OutsideRoot)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoot {
    pub source: String,
    pub path: String,
    pub exists: bool,
    pub readable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<u128>,
    pub hidden: bool,
    pub expandable: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTextPreview {
    pub relative_path: String,
    pub content: String,
    pub bytes_read: usize,
    pub total_bytes: usize,
    pub truncated: bool,
    pub encoding: String,
}

fn is_ignored(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "dist" | "build" | "target" | ".next" | ".vite" | "coverage")
}

fn entry_kind(metadata: &fs::Metadata) -> (&'static str, bool) {
    if metadata.is_dir() { ("directory", true) }
    else if metadata.is_file() { ("file", false) }
    else if metadata.file_type().is_symlink() { ("symlink", false) }
    else { ("other", false) }
}

pub fn list_entries(root: &Path, relative: &str, include_hidden: bool) -> Result<Vec<WorkspaceEntry>, WorkspaceError> {
    let directory = resolve_workspace_path(root, relative)?;
    if !directory.is_dir() { return Err(WorkspaceError::NotFile); }
    let mut entries = Vec::new();
    for item in fs::read_dir(&directory).map_err(|e| WorkspaceError::Io(e.to_string()))? {
        let item = item.map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if is_ignored(&name) || (!include_hidden && name.starts_with('.')) { continue; }
        let metadata = fs::symlink_metadata(item.path()).map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let (kind, expandable) = entry_kind(&metadata);
        let mut safe = true;
        if metadata.file_type().is_symlink() {
            safe = resolve_workspace_path(root, &format!("{}/{}", relative.trim_end_matches(['/', '\\']), name)).is_ok();
        }
        if !safe { continue; }
        let modified_at = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis());
        let relative_path = if relative == "." || relative.is_empty() { name.clone() } else { format!("{}/{}", relative.replace('\\', "/").trim_end_matches('/'), name) };
        entries.push(WorkspaceEntry { name: name.clone(), relative_path, kind: kind.to_string(), size: metadata.len(), modified_at, hidden: name.starts_with('.'), expandable });
        if entries.len() > MAX_DIRECTORY_ENTRIES { return Err(WorkspaceError::TooManyEntries); }
    }
    entries.sort_by(|a, b| {
        let rank = |kind: &str| match kind { "directory" => 0, "file" => 1, "symlink" => 2, _ => 3 };
        rank(&a.kind).cmp(&rank(&b.kind)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

pub fn read_text(root: &Path, relative: &str, max_bytes: Option<usize>) -> Result<WorkspaceTextPreview, WorkspaceError> {
    let path = resolve_workspace_path(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if !metadata.is_file() { return Err(WorkspaceError::NotFile); }
    let total_bytes = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    let limit = max_bytes.unwrap_or(DEFAULT_PREVIEW_BYTES).min(MAX_PREVIEW_BYTES);
    let mut file = fs::File::open(&path).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    let mut bytes = Vec::with_capacity(total_bytes.min(limit.saturating_add(1)));
    let mut limited = file.by_ref().take(limit as u64 + 1);
    limited.read_to_end(&mut bytes).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if bytes.contains(&0) { return Err(WorkspaceError::BinaryFile); }
    let truncated = bytes.len() > limit;
    let slice = &bytes[..bytes.len().min(limit)];
    let content = std::str::from_utf8(slice).map_err(|_| WorkspaceError::BinaryFile)?.to_string();
    Ok(WorkspaceTextPreview { relative_path: relative.replace('\\', "/"), content, bytes_read: slice.len(), total_bytes, truncated, encoding: "utf-8".to_string() })
}

pub fn workspace_root(source: String, root: &Path) -> WorkspaceRoot {
    match root.canonicalize() {
        Ok(path) => WorkspaceRoot { source, path: path.to_string_lossy().into_owned(), exists: true, readable: fs::read_dir(&path).is_ok() },
        Err(_) => WorkspaceRoot { source, path: root.to_string_lossy().into_owned(), exists: false, readable: false },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for TempDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn fixture() -> (TempDir, PathBuf) {
        let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("pylon-workspace-test-{id}"));
        let root = dir.join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "hello").unwrap();
        (TempDir(dir), root)
    }

    #[test]
    fn path_rejects_traversal_and_drive_prefix() {
        let (_dir, root) = fixture();
        assert_eq!(resolve_workspace_path(&root, "../secret"), Err(WorkspaceError::TraversalRejected));
        assert_eq!(resolve_workspace_path(&root, "C:\\Windows\\win.ini"), Err(WorkspaceError::AbsolutePathRejected));
        assert!(resolve_workspace_path(&root, "./src\\main.ts").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_outside_root_is_rejected() {
        use std::os::unix::fs::symlink;
        let (dir, root) = fixture();
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, "secret").unwrap();
        symlink(&outside, root.join("link.txt")).unwrap();
        assert_eq!(resolve_workspace_path(&root, "link.txt"), Err(WorkspaceError::OutsideRoot));
    }

    #[test]
    fn list_sorts_and_ignores_defaults() {
        let (_dir, root) = fixture();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::create_dir(root.join("z-dir")).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        let result = list_entries(&root, ".", false).unwrap();
        assert_eq!(result.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["src", "z-dir", "a.txt"]);
    }

    #[test]
    fn text_preview_is_limited_and_rejects_nul() {
        let (_dir, root) = fixture();
        fs::write(root.join("long.txt"), "1234567890").unwrap();
        let preview = read_text(&root, "long.txt", Some(4)).unwrap();
        assert_eq!(preview.content, "1234");
        assert_eq!(preview.bytes_read, 4);
        assert_eq!(preview.total_bytes, 10);
        assert!(preview.truncated);
        fs::write(root.join("binary.bin"), [1u8, 0, 2]).unwrap();
        assert_eq!(read_text(&root, "binary.bin", None), Err(WorkspaceError::BinaryFile));
    }
}
