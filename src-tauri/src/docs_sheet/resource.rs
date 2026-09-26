//! `pylon-docs://` 资源协议：离线文档站（VitePress dist）的磁盘解析与响应（#371）。
//!
//! 与 `pylon-plugin` 先例的两处刻意差异：
//! - **root 是 bundle 资源目录**（`resource_dir()/docs-site`），不是用户数据目录——
//!   插件装进用户数据，文档站随包分发；
//! - **clean URL 回退**：VitePress 站内链接无 `.html` 后缀（SPA 客户端路由不发起
//!   请求，但初始加载/刷新/历史恢复会），按 exact → +".html" → +"/index.html"
//!   逐级解析。
//!
//! 无 Range 支持：文档站无媒体流需求，全量读取即可；哈希资产靠 immutable 缓存头。

use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DocsResourceError {
    BadRequest(&'static str),
    NotFound,
}

/// 资源根：发行包内 `resources/docs-site/`。Tauri 的资源拷贝在打包态落 exe 旁、
/// dev 态落 target 目录，`resource_dir()` 两者兼顾。
pub(crate) fn docs_site_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|dir| dir.join("docs-site"))
        .map_err(|e| format!("resource dir unavailable: {e}"))
}

/// percent-decode 单个路径段序列。拒绝编码后的分隔符与 NUL——它们只该以原始
/// 字节出现在路径里，编码形态即绕过段级校验的尝试。
fn decode_path(request_path: &str) -> Result<String, DocsResourceError> {
    let bytes = request_path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .ok_or(DocsResourceError::BadRequest("bad percent encoding"))?;
            let pair = std::str::from_utf8(hex)
                .map_err(|_| DocsResourceError::BadRequest("bad percent encoding"))?;
            let byte = u8::from_str_radix(pair, 16)
                .map_err(|_| DocsResourceError::BadRequest("bad percent encoding"))?;
            if matches!(byte, b'/' | b'\\' | 0) {
                return Err(DocsResourceError::BadRequest("encoded separator rejected"));
            }
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| DocsResourceError::BadRequest("non-UTF-8 path"))
}

/// 解析请求路径到 dist 内的文件。`request_path` 带 `/` 前缀（`request.uri().path()`，
/// 不含 query）。段级拒绝 `..`、反斜杠与空段（目录穿越确定性报错，canonicalize 只兜底）。
pub(crate) fn resolve_docs_asset(
    root: &Path,
    request_path: &str,
) -> Result<PathBuf, DocsResourceError> {
    let decoded = decode_path(request_path)?;
    let relative = decoded.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };
    let relative = relative.trim_end_matches('/');
    if relative.is_empty() {
        return Err(DocsResourceError::BadRequest("empty path segment"));
    }
    let segments: Vec<&str> = relative.split('/').collect();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "..")
    {
        return Err(DocsResourceError::BadRequest("path traversal rejected"));
    }
    if relative.contains('\\') {
        return Err(DocsResourceError::BadRequest("backslash rejected"));
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|_| DocsResourceError::NotFound)?;
    let candidates = [
        root.join(relative),
        root.join(format!("{relative}.html")),
        root.join(format!("{relative}/index.html")),
    ];
    for candidate in candidates {
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if canonical.starts_with(&canonical_root) && canonical.is_file() {
            return Ok(canonical);
        }
    }
    Err(DocsResourceError::NotFound)
}

pub(crate) fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn error_response(status: StatusCode, value: impl ToString) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(value.to_string().into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub(crate) fn docs_resource_response_at(
    root: &Path,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    // request.uri().path() 不含 query，本地静态站无需读参数。
    let resource = match resolve_docs_asset(root, request.uri().path()) {
        Ok(path) => path,
        Err(DocsResourceError::BadRequest(reason)) => {
            return error_response(StatusCode::BAD_REQUEST, reason)
        }
        Err(DocsResourceError::NotFound) => {
            return error_response(StatusCode::NOT_FOUND, "docs asset not found")
        }
    };
    let body = match std::fs::File::open(&resource).and_then(|mut file| {
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).map(|_| buffer)
    }) {
        Ok(body) => body,
        Err(e) => return error_response(StatusCode::NOT_FOUND, e),
    };
    // 哈希文件名的构建产物可永久缓存；html/其余入口文件必须每次重验（刷新即新版本）。
    // resource 来自 canonicalize（Windows 下带 \\?\ 前缀），前缀剥离须用同一形态的 root。
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let relative = resource
        .strip_prefix(&canonical_root)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let cache_control = if relative.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime(&resource))
        .header(header::CONTENT_LENGTH, body.len())
        .header(header::CACHE_CONTROL, cache_control)
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub(crate) fn docs_resource_response(
    app: &AppHandle,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    match docs_site_root(app) {
        Ok(root) => docs_resource_response_at(&root, request),
        Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 paths.rs 测试同法的临时夹具：std::env::temp_dir + 进程唯一后缀，
    /// 不引入 tempdir 依赖；夹具整体随测试结束保留（temp 目录由系统清理）。
    fn fixture_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "pylon-docs-site-{tag}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::create_dir_all(dir.join("manual")).unwrap();
        std::fs::write(dir.join("index.html"), "<html>index</html>").unwrap();
        std::fs::write(dir.join("assets/app.a1.js"), "console.log(1)").unwrap();
        std::fs::write(dir.join("manual/release-package.html"), "<html>rp</html>").unwrap();
        std::fs::write(dir.join("manual/index.html"), "<html>manual</html>").unwrap();
        dir
    }

    #[test]
    fn root_serves_index_and_clean_urls_fall_back() {
        let root = fixture_root("clean");
        assert_eq!(
            resolve_docs_asset(&root, "/").unwrap(),
            root.join("index.html").canonicalize().unwrap()
        );
        assert_eq!(
            resolve_docs_asset(&root, "/index.html").unwrap(),
            root.join("index.html").canonicalize().unwrap()
        );
        // clean URL：无后缀链接 → .html
        assert_eq!(
            resolve_docs_asset(&root, "/manual/release-package").unwrap(),
            root.join("manual/release-package.html")
                .canonicalize()
                .unwrap()
        );
        // 目录式路由 → 目录下 index.html
        assert_eq!(
            resolve_docs_asset(&root, "/manual/").unwrap(),
            root.join("manual/index.html").canonicalize().unwrap()
        );
        assert_eq!(
            resolve_docs_asset(&root, "/manual").unwrap(),
            root.join("manual/index.html").canonicalize().unwrap()
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn traversal_and_encoded_separators_are_rejected() {
        let root = fixture_root("traversal");
        for bad in [
            "/../Cargo.toml",
            "/manual/../../etc/passwd",
            "/%2e%2e/Cargo.toml",
            "/manual%2Frelease-package",
            "/manual%5Crelease-package",
            "/..\\Cargo.toml",
            "/manual//release-package",
        ] {
            let resolved = resolve_docs_asset(&root, bad);
            assert!(resolved.is_err(), "{bad} 必须被拒绝");
            if let Err(reason) = resolved {
                assert_ne!(
                    reason,
                    DocsResourceError::NotFound,
                    "{bad} 应属 400 而非 404"
                );
            }
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unknown_asset_is_not_found() {
        let root = fixture_root("notfound");
        assert_eq!(
            resolve_docs_asset(&root, "/no-such-page"),
            Err(DocsResourceError::NotFound)
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mime_covers_docs_site_types() {
        assert_eq!(mime(Path::new("a/index.html")), "text/html; charset=utf-8");
        assert_eq!(
            mime(Path::new("a/app.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(mime(Path::new("a/s.svg")), "image/svg+xml");
        assert_eq!(mime(Path::new("a/f.woff2")), "font/woff2");
        assert_eq!(mime(Path::new("a/x.bin")), "application/octet-stream");
    }

    #[test]
    fn response_sets_cache_policy_by_asset_kind() {
        let root = fixture_root("cache");
        let hashed = docs_resource_response_at(
            &root,
            Request::builder()
                .uri("/assets/app.a1.js")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(hashed.status(), StatusCode::OK);
        assert_eq!(
            hashed.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            hashed.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/javascript; charset=utf-8"
        );

        let entry =
            docs_resource_response_at(&root, Request::builder().uri("/").body(Vec::new()).unwrap());
        assert_eq!(
            entry.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
