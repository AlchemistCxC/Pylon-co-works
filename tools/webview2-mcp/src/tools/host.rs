//! Tauri 宿主观测工具。
//!
//! 全部走同一条通道：`Runtime.evaluate` 调用页面里的
//! `window.__TAURI_INTERNALS__.invoke`。这条通道由 `tauri/scripts/init.js`
//! 无条件注入（与 `withGlobalTauri` 无关），因此**不需要**在 app 里加任何代码，
//! 也不需要把 app 改成 dev 构建。

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::args::Args;
use crate::cdp::session::EvalOptions;
use crate::error::{Error, Result};
use crate::jsscript;
use crate::tools::{resolve_scan, Context, ToolResult, DEFAULT_LIMIT};

pub async fn invoke(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("tauri_invoke", args);
    let command = a.required_str("command")?;
    let invoke_args = a.raw().get("args").cloned().unwrap_or_else(|| json!({}));
    if !invoke_args.is_object() {
        return Err(Error::bad_args(
            "tauri_invoke",
            "args 必须是对象（Tauri 命令的参数按名字传）",
        ));
    }

    let script = jsscript::tauri_invoke(command, &invoke_args);
    let outcome = cx
        .cdp
        .evaluate(a.str("target")?, &script, EvalOptions::default())
        .await?;

    let ok = outcome.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if ok {
        return Ok(ToolResult::json(&json!({
            "command": command,
            "ok": true,
            "value": outcome.get("value").cloned().unwrap_or(Value::Null),
        })));
    }

    // 命令失败是「操作失败」，不是「工具失败」：内容里带上原因，
    // 同时把 isError 置起来，让 agent 不必先解析 JSON 才知道失败了。
    let mut result = ToolResult::json(&json!({
        "command": command,
        "ok": false,
        "error": outcome.get("error").cloned().unwrap_or(Value::Null),
        "errorRaw": outcome.get("errorRaw").cloned().unwrap_or(Value::Null),
        "hint": "命令名不带 plugin: 前缀时即为 #[tauri::command] 的函数名。若报权限类错误，检查 src-tauri/capabilities/default.json 是否放开了对应权限。",
    }));
    result.is_error = true;
    Ok(result)
}

pub async fn events(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("tauri_events", args);
    let target_arg = a.str("target")?;
    let names = a.str_list("events")?;
    let since = a.u64("since_seq")?;
    let limit = a.u64_or("limit", DEFAULT_LIMIT as u64)? as usize;
    let scan = resolve_scan(a.u64("scan")?, limit);
    let reset = a.bool_or("reset", false)?;
    // 上界防止把页内缓冲撑到影响被测应用本身的内存占用。
    let buffer_size = a.u64_or("buffer_size", 500)?.clamp(10, 20_000) as usize;

    let event_target = match a.str("target_kind")?.unwrap_or("Any") {
        "Any" => json!({ "kind": "Any" }),
        "AnyLabel" => {
            let label = a.str("target_label")?.ok_or_else(|| {
                Error::bad_args(
                    "tauri_events",
                    "target_kind=AnyLabel 需要同时给出 target_label",
                )
            })?;
            json!({ "kind": "AnyLabel", "label": label })
        }
        other => {
            return Err(Error::bad_args(
                "tauri_events",
                format!("target_kind 只支持 Any / AnyLabel，收到 {other:?}"),
            ))
        }
    };

    // 只有「要订阅」或「要 reset」时才注入订阅脚本，避免每次读增量都往页面里塞代码。
    let subscription = if names.is_empty() && !reset {
        None
    } else {
        Some(
            cx.cdp
                .evaluate(
                    target_arg,
                    &jsscript::events_subscribe(&names, &event_target, buffer_size, reset),
                    EvalOptions::default(),
                )
                .await?,
        )
    };

    let drained = cx
        .cdp
        .evaluate(
            target_arg,
            &jsscript::events_drain(since, scan, limit),
            EvalOptions {
                await_promise: false,
                ..EvalOptions::default()
            },
        )
        .await?;

    let not_tauri = subscription
        .as_ref()
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        == Some(false);

    let mut result = ToolResult::json(&json!({
        "subscription": subscription,
        "entries": drained.get("entries").cloned().unwrap_or(json!([])),
        "returned": drained.get("entries").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "scanned": drained.get("scanned").cloned().unwrap_or(json!(0)),
        "cursor": drained.get("cursor").cloned().unwrap_or(json!(0)),
        "latestSeq": drained.get("latestSeq").cloned().unwrap_or(json!(0)),
        "evicted": drained.get("evicted").cloned().unwrap_or(json!(0)),
        "subscribedEvents": drained.get("subscribed").cloned().unwrap_or(json!([])),
        "subscriptionErrors": drained.get("errors").cloned().unwrap_or(json!({})),
        "installed": drained.get("installed").cloned().unwrap_or(json!(false)),
        "explicitSinceSeq": since,
        "reloadNote": "页面 reload 会清空页内订阅与缓冲；下次调用本工具会自动重新订阅（订阅是幂等的），但 reload 期间的事件无法补回。",
        "discoveryNote": "事件名必须显式给出。tauri 的 __TAURI_INTERNALS__.invoke 用不可配置的 defineProperty 定义，无法包装，因此做不到全量事件旁路捕获。用 tauri_event_catalog 从源码扫出事件名。",
    }));
    result.is_error = not_tauri;
    Ok(result)
}

// ─────────────────────── 事件名静态扫描 ───────────────────────

const DEFAULT_ROOTS: [&str; 2] = ["src", "src-tauri/src"];

const SKIP_DIRECTORIES: [&str; 10] = [
    "node_modules",
    "target",
    "dist",
    "dist-plugin-devkit",
    "dist-plugin-sdk",
    ".git",
    "coverage",
    "release",
    "artifacts",
    ".cache",
];

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const MAX_LINE_CHARS: usize = 4000;

/// (needle, 这是发出方还是接收方, 事件名是第几个参数)
type Needle = (&'static str, &'static str, usize);

/// 扫描目标。
///
/// 刻意**不**为 `emit(` 另设 `.emit(` 变体：`emit(` 本身就能命中 `app.emit(`，
/// 两者共存只会让同一次调用被记两遍。前面是否带 `.` 由标识符边界检查处理。
/// `emit_to(` / `emitTo(` 排在 `emit(` 之前是为了「先匹配更长者」这个不变式，
/// 免得日后改名字时出现前缀歧义。
const NEEDLES: [Needle; 6] = [
    ("emit_to(", "emit_to", 1),
    ("emitTo(", "emitTo", 1),
    ("emit(", "emit", 0),
    ("listenOnce(", "listenOnce", 0),
    ("listen(", "listen", 0),
    ("once(", "once", 0),
];

pub fn event_catalog(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("tauri_event_catalog", args);
    let roots = {
        let requested = a.str_list("roots")?;
        if requested.is_empty() {
            DEFAULT_ROOTS.iter().map(|s| s.to_string()).collect()
        } else {
            requested
        }
    };
    let pattern = a.string("pattern")?.map(|text| text.to_lowercase());

    let mut hits: Vec<Hit> = Vec::new();
    let mut scanned_files = 0usize;
    let mut skipped_roots: Vec<String> = Vec::new();
    let mut dynamic_sites = 0usize;
    let budget = ScanBudget::new(MAX_FILES);

    for root in &roots {
        let path = cx.cwd.join(root);
        if !path.is_dir() {
            skipped_roots.push(format!("{root}（不是目录）"));
            continue;
        }
        walk(&path, &cx.cwd, 0, &budget, &mut |file, relative| {
            scanned_files += 1;
            if let Ok(text) = std::fs::read_to_string(file) {
                scan_source(&text, relative, &mut hits, &mut dynamic_sites);
            }
        });
        if budget.stopped.get() {
            break;
        }
    }

    // 按事件名归组：一个事件名往往有多个发出点与多个接收点，
    // 摊平成行会让 agent 自己再聚合一遍。
    let mut grouped: BTreeMap<String, Vec<&Hit>> = BTreeMap::new();
    for hit in &hits {
        if let Some(pattern) = &pattern {
            if !hit.event.to_lowercase().contains(pattern) {
                continue;
            }
        }
        grouped.entry(hit.event.clone()).or_default().push(hit);
    }

    let events: Vec<Value> = grouped
        .iter()
        .map(|(name, sites)| {
            json!({
                "event": name,
                "emitters": sites.iter().filter(|s| is_emitter(s.kind)).map(|s| site_json(s)).collect::<Vec<_>>(),
                "listeners": sites.iter().filter(|s| !is_emitter(s.kind)).map(|s| site_json(s)).collect::<Vec<_>>(),
            })
        })
        .collect();

    Ok(ToolResult::json(&json!({
        "roots": roots,
        "scannedFiles": scanned_files,
        "skippedRoots": skipped_roots,
        "eventCount": events.len(),
        "events": events,
        "dynamicSites": dynamic_sites,
        "limitations": [
            "静态扫描：用变量、拼接或模板字符串构造的事件名扫不到（见 dynamicSites 计数）。",
            "只扫描给定的 roots，默认 src 与 src-tauri/src；插件目录或生成代码需另外传入。",
            "同名事件可能来自不同生命周期；这里的 file:line 只用于定位，不表达语义。",
        ],
        "nextStep": "把要用的事件名列进 tauri_events 的 events 参数即可开始采集。tauri:// 前缀的内置窗口事件（如 tauri://resize）同样可直接订阅。",
    })))
}

fn is_emitter(kind: &str) -> bool {
    matches!(kind, "emit" | "emit_to" | "emitTo")
}

fn site_json(hit: &Hit) -> Value {
    json!({ "file": hit.file, "line": hit.line, "kind": hit.kind, "context": hit.context })
}

struct Hit {
    event: String,
    kind: &'static str,
    file: String,
    line: usize,
    context: String,
}

/// 目录遍历的共享预算：剩余可扫描文件数（归零即提前终止）。
struct ScanBudget {
    remaining: std::cell::Cell<usize>,
    stopped: std::cell::Cell<bool>,
}

impl ScanBudget {
    fn new(max_files: usize) -> Self {
        Self {
            remaining: std::cell::Cell::new(max_files),
            stopped: std::cell::Cell::new(false),
        }
    }

    fn consume(&self) {
        let remaining = self.remaining.get().saturating_sub(1);
        self.remaining.set(remaining);
        if remaining == 0 {
            self.stopped.set(true);
        }
    }
}

/// 单次扫描的最深目录层数。配 [`ScanBudget`] 一起兜住病态目录树，
/// 防止恶意或异常的 roots 把 `tauri_event_catalog` 拖死。
const MAX_WALK_DEPTH: usize = 48;

fn walk(
    dir: &Path,
    root: &Path,
    depth: usize,
    budget: &ScanBudget,
    visit: &mut impl FnMut(&Path, &str),
) {
    if budget.stopped.get() || depth > MAX_WALK_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if budget.stopped.get() {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // `DirEntry::file_type` 不跟随符号链接：junction / 软链目录直接跳过，
        // 否则环状链接会让递归无限展开。显式传入的 root 不受此限（用户自己的选择）。
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if SKIP_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            walk(&path, root, depth + 1, budget, visit);
            continue;
        }
        let Some(extension) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !matches!(
            extension,
            "rs" | "ts" | "tsx" | "js" | "jsx" | "mts" | "mjs"
        ) {
            continue;
        }
        if entry
            .metadata()
            .map(|meta| meta.len() > MAX_FILE_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        visit(&path, &relative);
        budget.consume();
    }
}

fn scan_source(text: &str, relative: &str, hits: &mut Vec<Hit>, dynamic: &mut usize) {
    for (index, line) in text.lines().enumerate() {
        if line.len() > MAX_LINE_CHARS {
            continue;
        }
        // 整行注释直接跳过：注释里的示例代码不该出现在事件清单里。
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*") {
            continue;
        }
        for (needle, kind, argument_index) in NEEDLES {
            let mut search_from = 0usize;
            while let Some(found) = line[search_from..].find(needle) {
                let position = search_from + found;
                search_from = position + needle.len();
                // 左边必须是标识符边界：否则 `reemit(`、`anonce(`、`$emit(`
                // 这类同后缀标识符会被当成事件调用，把清单塞满噪声。
                if is_inside_identifier(line, position) {
                    continue;
                }
                let open_paren = position + needle.len() - 1;
                let Some(arguments) = arguments_at(line, open_paren) else {
                    continue;
                };
                let Some(argument) = arguments.get(argument_index) else {
                    continue;
                };
                match literal_value(argument.trim()) {
                    Some(event) => hits.push(Hit {
                        event,
                        kind,
                        file: relative.to_string(),
                        line: index + 1,
                        context: trimmed.chars().take(160).collect(),
                    }),
                    None => {
                        // 第 N 个参数不是字面量：要么是动态拼接，要么是别的东西
                        // （例如 `emit(` 出现在非 Tauri 的 EventEmitter 上）。
                        // 只统计真正像事件名的位置，避免噪声淹没计数。
                        if looks_like_event_argument(argument) {
                            *dynamic += 1;
                        }
                    }
                }
            }
        }
    }
}

/// 匹配位置是否落在更大的标识符内部。
///
/// `$` 也算标识符字符：`$emit(` 在 Vue 里是组件实例的自定义事件，
/// 不是 Tauri 的 emit，扫进来只会造成误报。
fn is_inside_identifier(line: &str, position: usize) -> bool {
    line[..position]
        .chars()
        .next_back()
        .map(|previous| previous.is_alphanumeric() || previous == '_' || previous == '$')
        .unwrap_or(false)
}

fn looks_like_event_argument(argument: &str) -> bool {
    let trimmed = argument.trim();
    trimmed.starts_with('`') || trimmed.contains("event") || trimmed.contains("Event")
}

/// 取出 `(` 到配对 `)` 之间的参数列表（顶层逗号切分）。
fn arguments_at(text: &str, open_paren: usize) -> Option<Vec<&str>> {
    let bytes = text.as_bytes();
    if bytes.get(open_paren) != Some(&b'(') {
        return None;
    }
    let mut depth = 0i32;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    let mut end = None;

    for (offset, &byte) in bytes[open_paren..].iter().enumerate() {
        let position = open_paren + offset;
        if let Some(active) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active {
                quote = None;
            }
            continue;
        }
        match byte {
            b'"' | b'\'' | b'`' => quote = Some(byte),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(position);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end?;
    let inner = &text[open_paren + 1..end];

    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut depth = 0i32;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    for (offset, &byte) in inner.as_bytes().iter().enumerate() {
        if let Some(active) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active {
                quote = None;
            }
            continue;
        }
        match byte {
            b'"' | b'\'' | b'`' => quote = Some(byte),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&inner[start..offset]);
                start = offset + 1;
            }
            _ => {}
        }
    }
    parts.push(&inner[start..]);
    Some(parts)
}

/// 只接受**纯字面量**字符串。带 `${` 的模板串是动态的，返回 None。
fn literal_value(argument: &str) -> Option<String> {
    let bytes = argument.as_bytes();
    let quote = *bytes.first()?;
    if !matches!(quote, b'"' | b'\'' | b'`') {
        return None;
    }
    if bytes.len() < 2 || bytes[bytes.len() - 1] != quote {
        return None;
    }
    let body = &argument[1..argument.len() - 1];
    if body.contains("${") {
        return None;
    }
    // 字符串里出现未转义的同类引号说明我们切错了边界。
    let mut escaped = false;
    for byte in body.bytes() {
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == quote {
            return None;
        }
    }
    if body.is_empty() {
        return None;
    }
    Some(body.replace("\\\"", "\"").replace("\\'", "'"))
}

// ─────────────────────── 窗口状态与后端日志 ───────────────────────

pub async fn window_state(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("tauri_window_state", args);
    // 兜底 label：Tauri 未显式配置 label 时默认是 "main"
    // （tauri-utils 的 default_window_label）。
    let label = a.str("label")?.unwrap_or("main");
    let value = cx
        .cdp
        .evaluate(
            a.str("target")?,
            &jsscript::window_state(label),
            EvalOptions::default(),
        )
        .await?;

    let host_errors = value.get("tauriHostErrors").cloned().unwrap_or(json!({}));
    let host_error_count = host_errors.as_object().map(Map::len).unwrap_or(0);

    Ok(ToolResult::json(&json!({
        "window": value,
        "hostErrors": host_errors,
        "hostErrorCount": host_error_count,
        "hostErrorNote": if host_error_count == 0 {
            "宿主侧命令全部成功。".to_string()
        } else {
            format!(
                "有 {host_error_count} 个宿主侧命令失败。常见原因是 src-tauri/capabilities/default.json 未放开对应权限\
                 （core:window:default 已覆盖全部只读窗口命令），或该命令在 Windows 平台不支持。"
            )
        },
    })))
}

pub async fn backend_logs(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("tauri_backend_logs", args);
    let mut query = Map::new();
    if let Some(level) = a.str("level")? {
        query.insert("level".into(), json!(level));
    }
    if let Some(source) = a.str("source")? {
        query.insert("source".into(), json!(source));
    }
    if let Some(session) = a.str("session")? {
        query.insert("session".into(), json!(session));
    }
    if let Some(search) = a.str("search")? {
        query.insert("search".into(), json!(search));
    }
    let limit = a.u64_or("limit", 100)?;
    query.insert("limit".into(), json!(limit));

    // `list_runtime_logs` 的形状见 src-tauri/src/logs_cmds.rs:8 —— 唯一参数名是 `query`，
    // 且 RuntimeLogQuery 是 camelCase（src-tauri/src/runtime_log.rs:99）。
    let script = jsscript::tauri_invoke("list_runtime_logs", &json!({ "query": query }));
    let outcome = cx
        .cdp
        .evaluate(a.str("target")?, &script, EvalOptions::default())
        .await?;

    let ok = outcome.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !ok {
        let mut result = ToolResult::json(&json!({
            "ok": false,
            "query": query,
            "error": outcome.get("error").cloned().unwrap_or(Value::Null),
            "hint": "该工具依赖 Pylon 的 list_runtime_logs 命令（#[tauri::command]，src-tauri/src/logs_cmds.rs）。命令不存在或被拒时后端日志改从 stderr 或 RuntimeSheet 读取。",
        }));
        result.is_error = true;
        return Ok(result);
    }

    let entries = outcome
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(ToolResult::json(&json!({
        "ok": true,
        "query": query,
        "returned": entries.len(),
        "entries": entries,
        "note": "返回顺序与 RuntimeLogHub::list 一致（最新在前）。日志由 ringbuffer 持有，容量有限，历史条目可能已被覆盖。",
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_of(source: &str) -> (Vec<(String, &'static str, usize)>, usize) {
        let mut hits = Vec::new();
        let mut dynamic = 0;
        scan_source(source, "test.ts", &mut hits, &mut dynamic);
        (
            hits.into_iter()
                .map(|hit| (hit.event, hit.kind, hit.line))
                .collect(),
            dynamic,
        )
    }

    #[test]
    fn finds_emit_listen_and_listen_once_sites() {
        let (hits, _) = catalog_of(
            r#"
            await emit('session://updated', payload);
            appWindow.listen('tauri://resize', handler);
            once('pet://tick', callback);
            "#,
        );
        let names: Vec<&str> = hits.iter().map(|(name, _, _)| name.as_str()).collect();
        assert!(names.contains(&"session://updated"), "{names:?}");
        assert!(names.contains(&"tauri://resize"), "{names:?}");
        assert!(names.contains(&"pet://tick"), "{names:?}");
    }

    #[test]
    fn emit_to_uses_the_second_argument_not_the_target() {
        let (hits, _) = catalog_of(r#"emit_to('main', 'session://updated', payload);"#);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "session://updated");
        assert_eq!(hits[0].1, "emit_to");
    }

    #[test]
    fn emit_to_is_counted_exactly_once() {
        // `.emitTo(` 与 `emitTo(` 曾经是两个 needle，同一次调用会被记两遍。
        let (hits, _) = catalog_of(r#"emitTo('main', 'x://y', p);"#);
        let events: Vec<&str> = hits.iter().map(|(name, _, _)| name.as_str()).collect();
        assert_eq!(events, vec!["x://y"], "同一次调用不该被记两遍");

        // 带接收者的写法同理，只算一次。
        let (hits, _) = catalog_of(r#"app.emitTo('main', 'x://y', p);"#);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn dynamic_event_names_are_counted_not_invented() {
        let (hits, dynamic) = catalog_of(r#"emit(`session://${kind}`, payload);"#);
        assert!(hits.is_empty(), "模板串不该被当成字面量事件名：{hits:?}");
        assert_eq!(dynamic, 1);
    }

    #[test]
    fn variable_event_names_are_not_reported() {
        let (hits, _) = catalog_of(r#"emit(eventName, payload);"#);
        assert!(hits.is_empty());
    }

    #[test]
    fn commented_out_emit_sites_are_ignored() {
        let (hits, _) = catalog_of(
            r#"
            // await emit('commented://out', x);
             * emit('also://commented', x);
            "#,
        );
        assert!(hits.is_empty(), "{hits:?}");
    }

    #[test]
    fn nested_calls_in_arguments_do_not_break_argument_splitting() {
        let (hits, _) =
            catalog_of(r#"emit('real://event', makePayload({ a: [1, 2] }, fn(x, y)));"#);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "real://event");
    }

    #[test]
    fn record_line_numbers_are_one_based_and_accurate() {
        let (hits, _) = catalog_of("line one\nlet a = 1;\nemit('at://three', x);\n");
        assert_eq!(hits[0].2, 3);
    }

    #[test]
    fn quoted_string_containing_commas_stays_one_argument() {
        let arguments = arguments_at("f('a,b', \"c,d\", 1)", 1).unwrap();
        assert_eq!(arguments.len(), 3);
        assert_eq!(arguments[0].trim(), "'a,b'");
        assert_eq!(arguments[1].trim(), "\"c,d\"");
    }

    #[test]
    fn literal_value_rejects_unquoted_and_unterminated_input() {
        assert_eq!(literal_value("'ok'"), Some("ok".to_string()));
        assert_eq!(literal_value("\"ok\""), Some("ok".to_string()));
        assert_eq!(literal_value("`ok`"), Some("ok".to_string()));
        assert_eq!(literal_value("variable"), None);
        assert_eq!(literal_value("'unterminated"), None);
        assert_eq!(literal_value("''"), None);
        assert_eq!(literal_value(""), None);
    }

    #[test]
    fn literal_value_unwraps_escaped_quotes() {
        assert_eq!(literal_value(r#""it\"s""#), Some("it\"s".to_string()));
    }

    #[test]
    fn arguments_at_returns_none_when_the_paren_never_closes() {
        assert!(arguments_at("f(a, b", 1).is_none());
        assert!(arguments_at("f(", 1).is_none());
    }

    #[test]
    fn emit_with_a_receiver_is_detected_once() {
        let (hits, _) = catalog_of("app.emit('x://y');");
        assert_eq!(hits.len(), 1, "app.emit( 应命中且只命中一次：{hits:?}");
        assert_eq!(hits[0].0, "x://y");
    }

    #[test]
    fn identifiers_merely_ending_in_a_needle_are_not_event_calls() {
        // 没有标识符边界检查时，这些全会被当成事件调用。
        let (hits, _) = catalog_of(
            r#"
            reemit('nope://1', x);
            anonce('nope://2', x);
            $emit('nope://3', x);
            some_listen('nope://4', x);
            "#,
        );
        assert!(
            hits.is_empty(),
            "这些不是 Tauri 事件调用，却出现在清单里：{hits:?}"
        );
    }

    #[test]
    fn emit_after_a_parenthesis_or_operator_is_still_reported() {
        // 边界规则只看前一个字符是不是标识符字符，不能把正常的调用形态误伤。
        let (hits, _) = catalog_of("return { onTick: () => emit('ok://1', x) };");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0].0, "ok://1");
    }
}
