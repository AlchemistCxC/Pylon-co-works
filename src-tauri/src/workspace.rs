//! 只读工作区访问：所有路径先经过 containment 校验，再执行文件系统操作。

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const DEFAULT_PREVIEW_BYTES: usize = 256 * 1024;
pub const MAX_PREVIEW_BYTES: usize = 1024 * 1024;
pub const MAX_DIRECTORY_ENTRIES: usize = 1000;
/// I08-A-FE-02：可编辑保存的文件大小上限——与 DEFAULT_PREVIEW_BYTES 一致：
/// 能完整预览（未 truncated）的文本文件才可编辑保存；更大的文件保持只读。
pub const MAX_SAVE_BYTES: usize = DEFAULT_PREVIEW_BYTES;

/// R5b：Display/Error 改 thiserror derive（与手写 impl 文案逐字一致——
/// 每个变体输出 `code: message`，`Io` 变体**保留原行为**：内部 String 不参与
/// Display（wire 文案恒为 "io_error: 工作区 I/O 操作失败"），勿改成 {0}）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkspaceError {
    #[error("absolute_path_rejected: 不允许使用绝对路径")]
    AbsolutePathRejected,
    #[error("traversal_rejected: 不允许路径穿越")]
    TraversalRejected,
    #[error("outside_root: 路径位于工作区之外")]
    OutsideRoot,
    #[error("not_found: 路径不存在")]
    NotFound,
    #[error("not_readable: 路径不可读取")]
    NotReadable,
    #[error("not_file: 路径不是文件")]
    NotFile,
    #[error("binary_file: 文件不是可预览的 UTF-8 文本")]
    BinaryFile,
    #[error("too_many_entries: 目录条目超过限制")]
    TooManyEntries,
    /// I08-A-FE-02：保存基线冲突——磁盘内容已在基线之后被外部修改，拒绝静默覆盖。
    #[error("conflict: 磁盘文件已被外部修改，保存已拒绝")]
    Conflict,
    /// I08-A-FE-02：文件过大，编辑保存超出安全上限（保持只读）。
    #[error("too_large: 文件过大，无法编辑保存")]
    TooLarge,
    #[error("io_error: 工作区 I/O 操作失败")]
    Io(String),
}

fn normalize_relative(relative: &str) -> Result<PathBuf, WorkspaceError> {
    // O30：NUL 字节在 Windows 上必然导致 I/O 失败，入口即拒（按绝对路径类处理）。
    if relative.contains('\0') {
        return Err(WorkspaceError::AbsolutePathRejected);
    }
    if relative.trim().is_empty() {
        return Ok(PathBuf::from("."));
    }
    let normalized = relative.replace('\\', "/");
    // O30：starts_with('/') 已覆盖 "//" 前缀，死分支移除。
    if normalized.starts_with('/') {
        return Err(WorkspaceError::AbsolutePathRejected);
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(WorkspaceError::TraversalRejected);
        }
        // O30：盘符/冒号判定仅在 Windows 上生效——Linux 上合法冒号文件名不再误拒。
        #[cfg(windows)]
        if part.contains(':') {
            return Err(WorkspaceError::AbsolutePathRejected);
        }
        parts.push(part);
    }
    if parts.is_empty() {
        Ok(PathBuf::from("."))
    } else {
        Ok(parts.iter().collect())
    }
}

/// 解析并校验工作区内的现有路径。不存在路径统一返回 NotFound。
/// O29：返回 (canonical_root, canonical_path) 二元组——canonical root 只解析一次，
/// 调用方不再重复 root.canonicalize()。
fn resolve_workspace_path(
    root: &Path,
    relative: &str,
) -> Result<(PathBuf, PathBuf), WorkspaceError> {
    let relative = normalize_relative(relative)?;
    let canonical_root = root.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    let candidate = canonical_root.join(relative);
    let canonical = candidate.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    if canonical == canonical_root || canonical.starts_with(&canonical_root) {
        Ok((canonical_root, canonical))
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
    matches!(
        name,
        ".git" | "node_modules" | "dist" | "build" | "target" | ".next" | ".vite" | "coverage"
    )
}

fn entry_kind(metadata: &fs::Metadata) -> (&'static str, bool) {
    if metadata.is_dir() {
        ("directory", true)
    } else if metadata.is_file() {
        ("file", false)
    } else if metadata.file_type().is_symlink() {
        ("symlink", false)
    } else {
        ("other", false)
    }
}

pub fn list_entries(
    root: &Path,
    relative: &str,
    include_hidden: bool,
) -> Result<Vec<WorkspaceEntry>, WorkspaceError> {
    let (canonical_root, directory) = resolve_workspace_path(root, relative)?;
    if !directory.is_dir() {
        return Err(WorkspaceError::NotFile);
    }
    // P3 + O29：canonical root 由 resolve 一次解析并复用（不依赖循环变量），
    // symlink 条目 containment 校验直接用之，避免重复 root.canonicalize()。
    let mut entries = Vec::new();
    for item in fs::read_dir(&directory).map_err(|e| WorkspaceError::Io(e.to_string()))? {
        let item = item.map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if is_ignored(&name) || (!include_hidden && name.starts_with('.')) {
            continue;
        }
        let metadata =
            fs::symlink_metadata(item.path()).map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let (kind, expandable) = entry_kind(&metadata);
        let mut safe = true;
        if metadata.file_type().is_symlink() {
            // 与 resolve_workspace_path 相同的 containment 语义：canonical 后必须
            // 落在 root 内；断链/不可解析一律视为不安全。
            safe = directory
                .join(&name)
                .canonicalize()
                .map(|canonical| canonical.starts_with(&canonical_root))
                .unwrap_or(false);
        }
        if !safe {
            continue;
        }
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis());
        let relative_path = if relative == "." || relative.is_empty() {
            name.clone()
        } else {
            format!(
                "{}/{}",
                relative.replace('\\', "/").trim_end_matches('/'),
                name
            )
        };
        entries.push(WorkspaceEntry {
            name: name.clone(),
            relative_path,
            kind: kind.to_string(),
            size: metadata.len(),
            modified_at,
            hidden: name.starts_with('.'),
            expandable,
        });
        if entries.len() > MAX_DIRECTORY_ENTRIES {
            return Err(WorkspaceError::TooManyEntries);
        }
    }
    entries.sort_by(|a, b| {
        let rank = |kind: &str| match kind {
            "directory" => 0,
            "file" => 1,
            "symlink" => 2,
            _ => 3,
        };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// R23：统一的 workspace 内文件打开通道——resolve → metadata 校验 → open →
/// canonicalize 复核（TOCTOU：resolve 与 open 之间路径可能被替换为指向 root 外
/// 的链接）。返回 (已打开文件, canonical 路径)；root 外一律 OutsideRoot。
fn open_workspace_file(root: &Path, relative: &str) -> Result<(fs::File, PathBuf), WorkspaceError> {
    let (canonical_root, path) = resolve_workspace_path(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if !metadata.is_file() {
        return Err(WorkspaceError::NotFile);
    }
    let file = fs::File::open(&path).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    let canonical = path.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    if canonical != canonical_root && !canonical.starts_with(&canonical_root) {
        return Err(WorkspaceError::OutsideRoot);
    }
    Ok((file, canonical))
}

pub fn read_text(
    root: &Path,
    relative: &str,
    max_bytes: Option<usize>,
) -> Result<WorkspaceTextPreview, WorkspaceError> {
    let (mut file, path) = open_workspace_file(root, relative)?;
    let metadata = fs::metadata(&path).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    let total_bytes = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    let limit = max_bytes
        .unwrap_or(DEFAULT_PREVIEW_BYTES)
        .min(MAX_PREVIEW_BYTES);
    let mut bytes = Vec::with_capacity(total_bytes.min(limit.saturating_add(1)));
    let mut limited = file.by_ref().take(limit as u64 + 1);
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if bytes.contains(&0) {
        return Err(WorkspaceError::BinaryFile);
    }
    let truncated = bytes.len() > limit;
    // C3：截断点可能切断多字节 UTF-8 字符——回退到最近字符边界，避免误报 binary。
    // S6：边界判定改为按 from_utf8 前缀可解码，不再用 0x80..=0xBF 续字节规则——
    // GBK 的 lead/trail 大量落此区间（如 啊=B0A1），旧逻辑会把整段回退清空
    // （end==0）而误报 BinaryFile。最大 UTF-8 字符宽 4 字节，至多回退 3 字节；
    // BOM 前缀对边界搜索透明。找不到 UTF-8 边界 = 非 UTF-8 内容，整段交给
    // decode_text 的 1 字节回退（R22），由解码结果判定，不再按字节区间猜测。
    let cut = bytes.len().min(limit);
    let mut end = cut;
    for candidate in (cut.saturating_sub(3)..=cut).rev() {
        if candidate > 0 {
            let prefix = bytes[..candidate]
                .strip_prefix(b"\xEF\xBB\xBF")
                .unwrap_or(&bytes[..candidate]);
            if !prefix.is_empty() && std::str::from_utf8(prefix).is_ok() {
                end = candidate;
                break;
            }
        }
    }
    let slice = &bytes[..end];
    let (content, encoding) = decode_text(slice)?;
    Ok(WorkspaceTextPreview {
        relative_path: relative.replace('\\', "/"),
        content,
        bytes_read: end,
        total_bytes,
        truncated,
        encoding: encoding.to_string(),
    })
}

/// R22：文本编码判定——UTF-8 BOM（剥离）→ 严格 UTF-8 → GBK 回退（encoding_rs）。
/// encoding 字段如实回填（"utf-8"/"gbk"）；三种途径都不可解码时按 binary 拒绝。
/// GBK 为 2 字节字符：截断只会损坏末尾一个字符，解码报错后回退 1 字节重试，
/// 避免误报 binary（GBK 尾字节与 lead 字节区间重叠，只能按解码结果判定）。
fn decode_text(bytes: &[u8]) -> Result<(String, &'static str), WorkspaceError> {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if let Ok(text) = std::str::from_utf8(body) {
        return Ok((text.to_string(), "utf-8"));
    }
    let mut slice = body;
    if body.len() > 1 {
        let (text, _, had_errors) = encoding_rs::GBK.decode(body);
        if !had_errors {
            return Ok((text.into_owned(), "gbk"));
        }
        slice = &body[..body.len() - 1];
    }
    let (text, _, had_errors) = encoding_rs::GBK.decode(slice);
    if had_errors {
        return Err(WorkspaceError::BinaryFile);
    }
    Ok((text.into_owned(), "gbk"))
}

// ── I08-A-FE-02：真实编辑/save vertical slice（write_text，AC-1）──────────────
// 保存语义：
// - 目标必须已存在（保存 = 覆盖已打开的文件），目录目标拒绝。
// - expected_baseline（前端"最近一次成功保存/加载的文本"）与磁盘当前解码文本不一致
//   → Conflict，绝不静默覆盖外部修改；force=true 显式跳过（冲突流程的"覆盖保存"）。
// - 编码 round-trip：UTF-8 BOM 保留；GBK 文件按 GBK 重新编码写回（不悄悄转码）。
// - > MAX_SAVE_BYTES 的文件/内容拒绝（TooLarge）——大文件本轮保持只读。

/// 原子写：同目录临时文件 + rename。Windows rename 不覆盖已存在目标时先移除
/// 再重命名（小窗口，基线冲突守卫已在前置）；失败清理临时文件。
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
    let parent = path.parent().ok_or_else(|| WorkspaceError::Io("无法定位文件目录".into()))?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = parent.join(format!(".{file_name}.pylon-save-{}", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(first)
            if first.kind() == std::io::ErrorKind::AlreadyExists
                || first.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            fs::remove_file(path).map_err(|e| WorkspaceError::Io(e.to_string()))?;
            if let Err(e) = fs::rename(&tmp, path) {
                let _ = fs::remove_file(&tmp);
                return Err(WorkspaceError::Io(e.to_string()));
            }
            Ok(())
        }
        Err(first) => {
            let _ = fs::remove_file(&tmp);
            Err(WorkspaceError::Io(first.to_string()))
        }
    }
}

pub fn write_text(
    root: &Path,
    relative: &str,
    content: &str,
    expected_baseline: Option<&str>,
    force: bool,
) -> Result<WorkspaceTextPreview, WorkspaceError> {
    let relative = normalize_relative(relative)?;
    let canonical_root = root.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    let target = canonical_root.join(&relative);
    if !target.exists() {
        return Err(WorkspaceError::NotFound);
    }
    if target.is_dir() {
        return Err(WorkspaceError::NotFile);
    }
    if content.len() > MAX_SAVE_BYTES {
        return Err(WorkspaceError::TooLarge);
    }
    let bytes = fs::read(&target).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if bytes.len() > MAX_SAVE_BYTES {
        return Err(WorkspaceError::TooLarge);
    }
    // 编码 round-trip：记录磁盘原文的 BOM 与解码编码，写回时保持一致
    let had_bom = bytes.starts_with(b"\xEF\xBB\xBF");
    let (disk_text, encoding) = decode_text(&bytes)?;
    if !force {
        if let Some(expected) = expected_baseline {
            if disk_text != expected {
                return Err(WorkspaceError::Conflict);
            }
        }
    }
    let out_bytes: Vec<u8> = if encoding == "gbk" {
        let (encoded, _, had_errors) = encoding_rs::GBK.encode(content);
        if had_errors {
            return Err(WorkspaceError::Io(
                "内容包含无法以 GBK 编码保存的字符".to_string(),
            ));
        }
        encoded.into_owned()
    } else {
        let mut out = Vec::with_capacity(content.len() + 3);
        if had_bom {
            out.extend_from_slice(b"\xEF\xBB\xBF");
        }
        out.extend_from_slice(content.as_bytes());
        out
    };
    write_atomic(&target, &out_bytes)?;
    // 返回保存后的新 preview：前端以此作为下一次保存的新基线
    let relative_str = relative.to_string_lossy().into_owned();
    read_text(root, &relative_str, None)
}

// ── workspace_search（后端施工计划书 Phase 1 §3）────────────────────────────

pub const SEARCH_MAX_RESULTS: usize = 200;
pub const SEARCH_MAX_FILES: usize = 400;
pub const SEARCH_MAX_BYTES_PER_FILE: usize = 256 * 1024;
pub const SEARCH_MAX_LINE_CHARS: usize = 500;

/// 搜索结果 DTO（wire camelCase：{path, line, lineText}；path 相对 root、`/` 分隔）。
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSearchResult {
    pub path: String,
    pub line: usize,
    pub line_text: String,
}

/// 搜索硬上限（防无界 IO/超大 payload；结果数 max_results 仅允许向下 clamp）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct SearchLimits {
    pub max_results: usize,
    pub max_files: usize,
    pub max_bytes_per_file: usize,
    pub max_line_chars: usize,
}

/// 默认上限：max_results 参数只可向下 clamp 到硬上限 200。
pub(crate) fn default_search_limits(max_results: Option<usize>) -> SearchLimits {
    SearchLimits {
        max_results: max_results.unwrap_or(SEARCH_MAX_RESULTS).min(SEARCH_MAX_RESULTS),
        max_files: SEARCH_MAX_FILES,
        max_bytes_per_file: SEARCH_MAX_BYTES_PER_FILE,
        max_line_chars: SEARCH_MAX_LINE_CHARS,
    }
}

/// 工作区全文行匹配（同步纯函数，command 应经 spawn_blocking 调用）。
/// 规则：空 query → 空列表；逐行大小写不敏感 contains（to_lowercase 折叠，
/// 中文恒等/ASCII 折叠/Unicode 边界由测试锁定）；忽略清单/隐藏过滤沿用
/// list_entries；目录 symlink 仅在 canonical 目标仍在 root 内时进入；文件
/// 打开沿用 open_workspace_file 的 containment 复核（TOCTOU）；GBK 复用
/// decode_text 解码后搜索；命中达 max_results 或扫描文件达 max_files 即停。
pub(crate) fn search(
    root: &Path,
    query: &str,
    limits: SearchLimits,
) -> Result<Vec<WorkspaceSearchResult>, WorkspaceError> {
    let query = query.trim();
    if query.is_empty() || limits.max_results == 0 {
        return Ok(Vec::new());
    }
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
    let mut scanned_files = 0usize;
    // 方案 1D：canonical visited 集合防环——同 canonical 目录只扫描一次，
    // 内部目录 symlink/junction 环（指向自身/祖先）在此截断，避免无限递归。
    let mut visited = std::collections::HashSet::new();
    walk_search(root, root, "", query, &query_lower, limits, &mut results, &mut scanned_files, &mut visited)?;
    results.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(results)
}

fn walk_search(
    root: &Path,
    dir: &Path,
    dir_relative: &str,
    query: &str,
    query_lower: &str,
    limits: SearchLimits,
    results: &mut Vec<WorkspaceSearchResult>,
    scanned_files: &mut usize,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> Result<(), WorkspaceError> {
    if results.len() >= limits.max_results || *scanned_files >= limits.max_files {
        return Ok(());
    }
    let canonical_root = root.canonicalize().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WorkspaceError::NotFound
        } else {
            WorkspaceError::NotReadable
        }
    })?;
    // 方案 1D：目录进入前 canonicalize 去重。注意这里对真实目录与 symlink 目录
    // 一视同仁——real 目录与指向它的 symlink canonical 后同键，只扫一次。
    let canonical_dir = dir.canonicalize().map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if !visited.insert(canonical_dir) {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| WorkspaceError::Io(e.to_string()))?;
    for item in entries {
        if results.len() >= limits.max_results || *scanned_files >= limits.max_files {
            break;
        }
        let item = item.map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if is_ignored(&name) || name.starts_with('.') {
            continue;
        }
        let metadata = fs::symlink_metadata(item.path()).map_err(|e| WorkspaceError::Io(e.to_string()))?;
        let relative = if dir_relative.is_empty() {
            name.clone()
        } else {
            format!("{dir_relative}/{name}")
        };
        if metadata.file_type().is_symlink() {
            // 目录 symlink 仅在 canonical 目标仍在 root 内时进入；断链/外部/文件链接跳过。
            // 进入后由 visited 去重防环（目标已在遍历路径上 → 跳过）。
            let target = item.path().canonicalize().ok();
            if let Some(target) = target {
                if target.starts_with(&canonical_root) && target.is_dir() {
                    walk_search(root, &item.path(), &relative, query, query_lower, limits, results, scanned_files, visited)?;
                }
            }
            continue;
        }
        if metadata.is_dir() {
            walk_search(root, &item.path(), &relative, query, query_lower, limits, results, scanned_files, visited)?;
        } else if metadata.is_file() {
            if *scanned_files >= limits.max_files {
                break;
            }
            *scanned_files += 1;
            search_file(root, &relative, query, query_lower, limits, results)?;
        }
    }
    Ok(())
}

fn search_file(
    root: &Path,
    relative: &str,
    _query: &str,
    query_lower: &str,
    limits: SearchLimits,
    results: &mut Vec<WorkspaceSearchResult>,
) -> Result<(), WorkspaceError> {
    // 沿用 open_workspace_file 的 containment 复核（TOCTOU：walk 与 open 之间
    // 路径可能被替换为指向 root 外的链接）。
    let (file, _) = open_workspace_file(root, relative)?;
    let mut bytes = Vec::with_capacity(limits.max_bytes_per_file.min(64 * 1024));
    file.take(limits.max_bytes_per_file as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| WorkspaceError::Io(e.to_string()))?;
    if bytes.contains(&0) {
        return Ok(()); // 二进制跳过（不参与匹配）
    }
    let (content, _) = match decode_text(&bytes) {
        Ok(decoded) => decoded,
        Err(_) => return Ok(()), // 不可解码跳过
    };
    for (index, raw_line) in content.split('\n').enumerate() {
        if results.len() >= limits.max_results {
            break;
        }
        let line = raw_line.trim_end_matches('\r');
        if line.to_lowercase().contains(query_lower) {
            let mut line_text = line.to_string();
            if line_text.chars().count() > limits.max_line_chars {
                line_text = line_text.chars().take(limits.max_line_chars).collect();
            }
            results.push(WorkspaceSearchResult {
                path: relative.replace('\\', "/"),
                line: index + 1,
                line_text,
            });
        }
    }
    Ok(())
}

pub fn workspace_root(source: String, root: &Path) -> WorkspaceRoot {
    match root.canonicalize() {
        Ok(path) => WorkspaceRoot {
            source,
            path: path.to_string_lossy().into_owned(),
            exists: true,
            readable: fs::read_dir(&path).is_ok(),
        },
        Err(_) => WorkspaceRoot {
            source,
            path: root.to_string_lossy().into_owned(),
            exists: false,
            readable: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TempDir, PathBuf) {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("pylon-workspace-test-{id}"));
        let root = dir.join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "hello").unwrap();
        (TempDir(dir), root)
    }

    #[test]
    fn path_rejects_traversal_and_drive_prefix() {
        let (_dir, root) = fixture();
        assert_eq!(
            resolve_workspace_path(&root, "../secret"),
            Err(WorkspaceError::TraversalRejected)
        );
        assert_eq!(
            resolve_workspace_path(&root, "C:\\Windows\\win.ini"),
            Err(WorkspaceError::AbsolutePathRejected)
        );
        // O30：NUL 字节入口即拒
        assert_eq!(
            resolve_workspace_path(&root, "a\0b.txt"),
            Err(WorkspaceError::AbsolutePathRejected)
        );
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
        assert_eq!(
            resolve_workspace_path(&root, "link.txt"),
            Err(WorkspaceError::OutsideRoot)
        );
    }

    #[test]
    fn list_sorts_and_ignores_defaults() {
        let (_dir, root) = fixture();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::create_dir(root.join("z-dir")).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        let result = list_entries(&root, ".", false).unwrap();
        assert_eq!(
            result.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["src", "z-dir", "a.txt"]
        );
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
        assert_eq!(
            read_text(&root, "binary.bin", None),
            Err(WorkspaceError::BinaryFile)
        );
    }

    #[test]
    fn text_preview_multibyte_truncation_stays_utf8() {
        // C3：256KB+ 中文文件，截断点落在多字节字符中间时回退到字符边界，
        // 不得误报 BinaryFile；内容必须是完整字符序列。
        let (_dir, root) = fixture();
        let content = "中".repeat(100_000);
        fs::write(root.join("zh.txt"), &content).unwrap();
        let preview = read_text(&root, "zh.txt", None).unwrap();
        assert!(preview.truncated);
        assert!(preview.bytes_read > 0);
        assert_eq!(preview.bytes_read % 3, 0, "截断必须停在 UTF-8 字符边界");
        assert_eq!(preview.bytes_read, preview.content.len());
        assert!(preview.content.chars().all(|c| c == '中'));
    }

    #[test]
    fn text_preview_detects_gbk_and_strips_utf8_bom() {
        // R22：GBK 字节文件可预览（encoding 回填 "gbk"）；UTF-8 BOM 剥离。
        let (_dir, root) = fixture();
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4]; // "中文测试"
        fs::write(root.join("gbk.txt"), gbk).unwrap();
        let preview = read_text(&root, "gbk.txt", None).unwrap();
        assert_eq!(preview.content, "中文测试");
        assert_eq!(preview.encoding, "gbk");
        fs::write(root.join("bom.txt"), b"\xEF\xBB\xBFhello").unwrap();
        let preview = read_text(&root, "bom.txt", None).unwrap();
        assert_eq!(preview.content, "hello");
        assert_eq!(preview.encoding, "utf-8");
        assert_eq!(preview.bytes_read, 8);
    }

    #[test]
    fn text_preview_gbk_truncation_backs_off() {
        // R22：GBK 2 字节字符被截断只剩 lead 字节时回退，不误报 binary。
        let (_dir, root) = fixture();
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA]; // "中文测" + 截断的 "试"
        fs::write(root.join("gbk2.txt"), gbk).unwrap();
        let preview = read_text(&root, "gbk2.txt", Some(7)).unwrap();
        assert_eq!(preview.content, "中文测");
        assert_eq!(preview.encoding, "gbk");
    }

    #[test]
    fn text_preview_gbk_repeated_char_truncation_not_binary() {
        // S6：GBK 常用字 lead/trail 字节（啊=B0A1）全落 0x80..=0xBF，旧逻辑按
        // UTF-8 续字节回退会一路退到 end==0 而误报 BinaryFile；修复后整段交给
        // decode_text 的 GBK 1 字节回退，预览成功且 encoding=gbk。
        let (_dir, root) = fixture();
        let gbk: Vec<u8> = (0..=DEFAULT_PREVIEW_BYTES)
            .flat_map(|_| [0xB0u8, 0xA1])
            .collect();
        fs::write(root.join("gbk-rep.txt"), &gbk).unwrap();
        let preview = read_text(&root, "gbk-rep.txt", None).unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.encoding, "gbk");
        assert_eq!(preview.bytes_read, DEFAULT_PREVIEW_BYTES);
        assert_eq!(preview.content, "啊".repeat(DEFAULT_PREVIEW_BYTES / 2));
    }

    // ── workspace_search（Phase 1 §3.3）──

    fn search_fixture() -> (TempDir, PathBuf) {
        let (dir, root) = fixture();
        fs::write(root.join("src/main.ts"), "hello world needle\nHELLO Rust\n中文内容 needle\n").unwrap();
        fs::write(root.join("docs.md"), "needle in docs\nplain\n").unwrap();
        fs::create_dir_all(root.join("src/node_modules")).unwrap();
        fs::write(root.join("src/node_modules/deep.txt"), "needle nested\n").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/pkg.txt"), "needle in node_modules\n").unwrap();
        fs::write(root.join(".hidden.txt"), "needle hidden\n").unwrap();
        fs::write(root.join("gbk.txt"), [0xB2, 0xE2, 0xCE, 0xC4, 0x20, 0x6E, 0x65, 0x65, 0x64, 0x6C, 0x65, 0x0A]).unwrap(); // "中文 needle\n" GBK
        fs::write(root.join("bom.md"), "\u{FEFF}needle bom\n").unwrap();
        fs::write(root.join("binary.bin"), [1u8, 0, 2, b'n', b'e', b'e', b'd', b'l', b'e']).unwrap();
        (dir, root)
    }

    #[test]
    fn search_matches_case_insensitive_and_line_numbers() {
        let (_dir, root) = search_fixture();
        let limits = default_search_limits(None);
        let found = search(&root, "NEEDLE", limits).unwrap();
        // 命中文件：src/main.ts（两行 needle 大小写）、docs.md、gbk.txt、bom.md；
        // 忽略 node_modules / .hidden / src/ignored；binary.bin 含 NUL 跳过
        let paths: Vec<&str> = found.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"src/main.ts"), "UTF-8 必须命中（{paths:?}）");
        assert!(paths.contains(&"docs.md"), "普通文件必须命中");
        assert!(paths.contains(&"gbk.txt"), "GBK 解码后必须命中");
        assert!(paths.contains(&"bom.md"), "BOM 必须命中");
        assert!(!paths.iter().any(|p| p.contains("node_modules")), "忽略目录（含嵌套）不得进入");
        assert!(!paths.iter().any(|p| p.contains(".hidden")), "隐藏文件不得进入");
        assert!(!paths.iter().any(|p| *p == "binary.bin"), "二进制不得命中");
        let main_hits: Vec<_> = found.iter().filter(|r| r.path == "src/main.ts").collect();
        assert_eq!(main_hits.len(), 2, "多行命中逐行计（{main_hits:?}）");
        assert_eq!(main_hits[0].line, 1);
        assert_eq!(main_hits[1].line, 3);
        assert!(main_hits.iter().all(|r| !r.line_text.contains('\r')));
    }

    #[test]
    fn search_empty_query_and_limits() {
        let (_dir, root) = search_fixture();
        assert_eq!(search(&root, "   ", default_search_limits(None)).unwrap(), Vec::new(), "空 query 必须空列表不扫描");
        let tiny = SearchLimits { max_results: 1, max_files: 400, max_bytes_per_file: 256 * 1024, max_line_chars: 500 };
        let found = search(&root, "needle", tiny).unwrap();
        assert!(found.len() <= 1, "max_results 必须截断");
        let clamped = default_search_limits(Some(9999));
        assert_eq!(clamped.max_results, SEARCH_MAX_RESULTS, "max_results 只能向下 clamp");
        let zero = SearchLimits { max_results: 0, max_files: 400, max_bytes_per_file: 256 * 1024, max_line_chars: 500 };
        assert_eq!(search(&root, "needle", zero).unwrap(), Vec::new());
    }

    #[test]
    fn search_truncates_long_lines_and_sorts_stable() {
        let (_dir, root) = search_fixture();
        fs::write(root.join("long.txt"), format!("needle {}\n", "长".repeat(1200))).unwrap();
        let limits = SearchLimits { max_results: 200, max_files: 400, max_bytes_per_file: 256 * 1024, max_line_chars: 500 };
        let found = search(&root, "needle", limits).unwrap();
        let long = found.iter().find(|r| r.path == "long.txt").expect("long.txt 必须命中");
        assert!(long.line_text.chars().count() <= 500, "单行返回必须截断");
        let pairs: Vec<_> = found.iter().map(|r| (r.path.as_str(), r.line)).collect();
        let mut sorted = pairs.clone();
        sorted.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        assert_eq!(pairs, sorted, "输出必须稳定排序");
    }

    #[cfg(unix)]
    #[test]
    fn search_skips_symlinks_outside_root_and_broken() {
        use std::os::unix::fs::symlink;
        let (dir, root) = search_fixture();
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, "needle outside\n").unwrap();
        symlink(&outside, root.join("evil.txt")).unwrap();
        symlink(root.join("missing-target"), root.join("broken-link")).unwrap();
        let found = search(&root, "needle", default_search_limits(None)).unwrap();
        assert!(!found.iter().any(|r| r.path == "evil.txt"), "root 外文件 symlink 不得进入");
        assert!(!found.iter().any(|r| r.path == "broken-link"), "断链必须跳过");
    }

    #[cfg(unix)]
    #[test]
    fn search_terminates_on_internal_directory_cycle() {
        // 方案 1D 测试门：目录内 symlink 指向祖先（环，canonical 仍在 root 内）
        // 必须有限时间返回，不得无限递归/栈溢出。
        use std::os::unix::fs::symlink;
        let (_dir, root) = search_fixture();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/file.txt"), "needle in sub\n").unwrap();
        // sub/loop -> .. 即 root：walk 进入 sub 后再进入 root 会形成环。
        symlink("..", root.join("sub/loop")).unwrap();
        let found = search(&root, "needle", default_search_limits(None)).unwrap();
        assert!(found.iter().any(|r| r.path == "sub/file.txt"), "环内正常文件仍应命中");
    }

    #[cfg(unix)]
    #[test]
    fn search_scans_same_canonical_directory_once() {
        // 方案 1D：同 canonical 目录只扫一次——两个目录 symlink 指向同一真实目录，
        // 命中文件不重复出现。
        use std::os::unix::fs::symlink;
        let (_dir, root) = search_fixture();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/only.txt"), "needle shared\n").unwrap();
        symlink("target", root.join("alias-a")).unwrap();
        symlink("target", root.join("alias-b")).unwrap();
        let found = search(&root, "needle", default_search_limits(None)).unwrap();
        let hits: Vec<&str> = found.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(
            hits.iter().filter(|p| p.contains("only.txt")).count(),
            1,
            "同 canonical 目录只贡献一份结果: {hits:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn search_terminates_on_internal_junction_cycle() {
        // 方案 1D（Windows）：目录 junction 环同样必须有限时间返回。
        // junction/symlink 创建可能因权限不足（需开发者模式/管理员）失败——
        // 此时明确 skip 而非失败（方案标注：Windows junction 权限不满足时明确 skip）。
        use std::os::windows::fs::symlink_dir;
        let (_dir, root) = search_fixture();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/file.txt"), "needle in sub\n").unwrap();
        if symlink_dir("..", root.join("sub/loop")).is_err() {
            eprintln!("skip: 创建 junction/symlink 无权限（需要开发者模式）");
            return;
        }
        let found = search(&root, "needle", default_search_limits(None)).unwrap();
        assert!(found.iter().any(|r| r.path == "sub/file.txt"), "环内正常文件仍应命中");
    }

    #[test]
    fn search_missing_root_reports_not_found() {
        let (_dir, root) = search_fixture();
        let missing = root.join("no-such-dir");
        assert_eq!(
            search(&missing, "needle", default_search_limits(None)),
            Err(WorkspaceError::NotFound)
        );
    }

    #[test]
    fn workspace_error_display_is_stable() {
        // R5b 契约锁定：Display 文案（code: message）与手写 impl 逐字一致。
        assert_eq!(
            WorkspaceError::AbsolutePathRejected.to_string(),
            "absolute_path_rejected: 不允许使用绝对路径"
        );
        assert_eq!(
            WorkspaceError::TraversalRejected.to_string(),
            "traversal_rejected: 不允许路径穿越"
        );
        assert_eq!(
            WorkspaceError::OutsideRoot.to_string(),
            "outside_root: 路径位于工作区之外"
        );
        assert_eq!(
            WorkspaceError::NotFound.to_string(),
            "not_found: 路径不存在"
        );
        assert_eq!(
            WorkspaceError::NotReadable.to_string(),
            "not_readable: 路径不可读取"
        );
        assert_eq!(
            WorkspaceError::NotFile.to_string(),
            "not_file: 路径不是文件"
        );
        assert_eq!(
            WorkspaceError::BinaryFile.to_string(),
            "binary_file: 文件不是可预览的 UTF-8 文本"
        );
        assert_eq!(
            WorkspaceError::TooManyEntries.to_string(),
            "too_many_entries: 目录条目超过限制"
        );
        // Io 变体：内部 String 不参与 Display（历史契约，勿改）
        assert_eq!(
            WorkspaceError::Io("detail".into()).to_string(),
            "io_error: 工作区 I/O 操作失败"
        );
        // I08-A-FE-02：保存域错误码文案锁定（前端按 conflict/too_large 分类）
        assert_eq!(
            WorkspaceError::Conflict.to_string(),
            "conflict: 磁盘文件已被外部修改，保存已拒绝"
        );
        assert_eq!(
            WorkspaceError::TooLarge.to_string(),
            "too_large: 文件过大，无法编辑保存"
        );
    }

    // ── I08-A-FE-02：真实编辑/save vertical slice（write_text L1 证据，AC-1）──
    // 契约：write_text(root, relative, content, expected_baseline, force)
    // - 保存成功更新磁盘内容并返回新 preview（前端以此作新基线）
    // - expected_baseline 与磁盘当前文本不一致 → Conflict（外部修改不得被静默覆盖）
    // - force=true 显式跳过基线检查（冲突流程的"覆盖保存"）
    // - BOM/GBK 编码 round-trip；> MAX_SAVE_BYTES 拒绝（大文件保持只读）

    #[test]
    fn write_text_round_trips_content_and_returns_preview() {
        let (_dir, root) = fixture();
        fs::write(root.join("src/main.ts"), "const a = 1\n").unwrap();
        let preview = write_text(
            &root,
            "src/main.ts",
            "const a = 2\nconst b = 3\n",
            Some("const a = 1\n"),
            false,
        )
        .unwrap();
        assert_eq!(preview.content, "const a = 2\nconst b = 3\n");
        assert!(!preview.truncated);
        assert_eq!(preview.relative_path, "src/main.ts");
        let on_disk = fs::read_to_string(root.join("src/main.ts")).unwrap();
        assert_eq!(on_disk, "const a = 2\nconst b = 3\n", "保存必须真实写盘");
    }

    #[test]
    fn write_text_preserves_utf8_bom() {
        let (_dir, root) = fixture();
        fs::write(root.join("bom.ts"), b"\xEF\xBB\xBFhello\n").unwrap();
        write_text(&root, "bom.ts", "hello world\n", Some("hello\n"), false).unwrap();
        let bytes = fs::read(root.join("bom.ts")).unwrap();
        assert!(
            bytes.starts_with(b"\xEF\xBB\xBF"),
            "UTF-8 BOM 文件保存后必须保留 BOM"
        );
        let preview = read_text(&root, "bom.ts", None).unwrap();
        assert_eq!(preview.content, "hello world\n");
        assert_eq!(preview.encoding, "utf-8");
    }

    #[test]
    fn write_text_round_trips_gbk_encoding() {
        let (_dir, root) = fixture();
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0x0A]; // "中文测试\n"（GBK）
        fs::write(root.join("gbk.txt"), gbk).unwrap();
        write_text(&root, "gbk.txt", "新内容\n", Some("中文测试\n"), false).unwrap();
        let preview = read_text(&root, "gbk.txt", None).unwrap();
        assert_eq!(preview.content, "新内容\n");
        assert_eq!(
            preview.encoding, "gbk",
            "GBK 文件保存后必须仍以 GBK 编码写盘（不悄悄转 UTF-8）"
        );
    }

    #[test]
    fn write_text_rejects_traversal_and_absolute_paths() {
        let (_dir, root) = fixture();
        assert_eq!(
            write_text(&root, "../secret", "x", Some("x"), false),
            Err(WorkspaceError::TraversalRejected)
        );
        assert_eq!(
            write_text(&root, "C:\\Windows\\win.ini", "x", Some("x"), false),
            Err(WorkspaceError::AbsolutePathRejected)
        );
        assert_eq!(
            write_text(&root, "a\0b.txt", "x", Some("x"), false),
            Err(WorkspaceError::AbsolutePathRejected)
        );
    }

    #[test]
    fn write_text_missing_file_returns_not_found() {
        let (_dir, root) = fixture();
        assert_eq!(
            write_text(&root, "nope.txt", "x", Some("x"), false),
            Err(WorkspaceError::NotFound)
        );
    }

    #[test]
    fn write_text_directory_target_returns_not_file() {
        let (_dir, root) = fixture();
        fs::create_dir(root.join("adir")).unwrap();
        assert_eq!(
            write_text(&root, "adir", "x", Some("x"), false),
            Err(WorkspaceError::NotFile)
        );
    }

    #[test]
    fn write_text_detects_external_modification_conflict_without_writing() {
        let (_dir, root) = fixture();
        fs::write(root.join("a.txt"), "v1\n").unwrap();
        // 磁盘内容已在基线之后被外部程序修改
        fs::write(root.join("a.txt"), "external change\n").unwrap();
        let error = write_text(&root, "a.txt", "user edit\n", Some("v1\n"), false)
            .expect_err("基线不匹配必须进入冲突流程");
        assert_eq!(error, WorkspaceError::Conflict);
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "external change\n",
            "冲突时不得静默覆盖磁盘内容"
        );
    }

    #[test]
    fn write_text_force_overwrites_despite_conflict() {
        let (_dir, root) = fixture();
        fs::write(root.join("a.txt"), "external change\n").unwrap();
        let preview = write_text(
            &root,
            "a.txt",
            "user overwrite\n",
            Some("old baseline\n"),
            true,
        )
        .unwrap();
        assert_eq!(preview.content, "user overwrite\n");
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "user overwrite\n"
        );
    }

    #[test]
    fn write_text_without_baseline_skips_conflict_check() {
        let (_dir, root) = fixture();
        fs::write(root.join("a.txt"), "whatever\n").unwrap();
        let preview = write_text(&root, "a.txt", "saved\n", None, false).unwrap();
        assert_eq!(preview.content, "saved\n");
    }

    #[test]
    fn write_text_rejects_oversized_content() {
        let (_dir, root) = fixture();
        fs::write(root.join("big.txt"), "small\n").unwrap();
        let huge = "x".repeat(MAX_SAVE_BYTES + 1);
        assert_eq!(
            write_text(&root, "big.txt", &huge, Some("small\n"), false),
            Err(WorkspaceError::TooLarge)
        );
    }

    #[test]
    fn write_text_rejects_oversized_existing_file() {
        let (_dir, root) = fixture();
        fs::write(root.join("big.txt"), "x".repeat(MAX_SAVE_BYTES + 1)).unwrap();
        assert_eq!(
            write_text(&root, "big.txt", "y", Some("y"), false),
            Err(WorkspaceError::TooLarge)
        );
    }
}
