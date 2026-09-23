//! ACP stderr drain（A1c：从 transport.rs 抽出——两后端共用，legacy 删除后保留）。

use std::io::{BufRead, BufReader};
use std::sync::Arc;

/// 结构化判据（#258：每行只解析一次）——合法 JSON **object** 才算结构化；
/// 非 JSON 或非 object（数组/标量）一律 None，与「解析失败」同走非结构化分支。
fn stderr_fields(line: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    match serde_json::from_str::<serde_json::Value>(line.trim()) {
        Ok(serde_json::Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// 结构化分支的 level 判定：`level` 字段权威（字符串 + pino 数字）。
/// 无 `level` 或类型不可辨时返回 None——调用方落回非结构化整行扫描（原实现即此语义）。
fn level_from_fields(map: &serde_json::Map<String, serde_json::Value>) -> Option<&'static str> {
    let lv = map.get("level")?;
    if let Some(s) = lv.as_str() {
        return Some(match s.to_ascii_lowercase().as_str() {
            "error" | "fatal" | "critical" | "panic" => "error",
            "warn" | "warning" => "warn",
            "debug" | "trace" => "debug",
            _ => "info",
        });
    }
    if let Some(n) = lv.as_u64() {
        // CR-103：pino 数字 level（10/20→debug，30→info，40→warn，50/60→error）。
        return Some(match n {
            10 | 20 => "debug",
            30 => "info",
            40 => "warn",
            50 | 60 => "error",
            _ => "info",
        });
    }
    None
}

/// 非结构化行：致命信号否定式先排除（CR-101——"non-fatal" 可辩驳，不得因含
/// "fatal" 子串误升 error），再匹配不可辩驳致命信号（不依赖 "ERROR" 字样）。
fn unstructured_level(line: &str) -> &'static str {
    let lower = line.to_ascii_lowercase();
    const NON_FATAL_MARKERS: [&str; 3] = ["non-fatal", "nonfatal", "not fatal"];
    if NON_FATAL_MARKERS.iter().any(|m| lower.contains(m)) {
        return "info";
    }
    const FATAL_MARKERS: [&str; 6] = [
        "panic",
        "fatal",
        "uncaught exception",
        "aborting",
        "segmentation fault",
        "core dumped",
    ];
    if FATAL_MARKERS.iter().any(|m| lower.contains(m)) {
        return "error";
    }
    // 普通 stderr 输出 → info（不再默认 error）
    "info"
}

pub fn classify_stderr_level(line: &str) -> &'static str {
    if let Some(level) = stderr_fields(line).as_ref().and_then(level_from_fields) {
        return level;
    }
    unstructured_level(line)
}

/// code 只来自结构化 object 的顶层 `code`（agent 自报码），非结构化行恒 None。
fn code_from_fields(map: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    let code = map.get("code")?.as_str()?.trim();
    if code.is_empty() {
        return None;
    }
    Some(code.to_string())
}

pub fn extract_stderr_code(line: &str) -> Option<String> {
    code_from_fields(&stderr_fields(line)?)
}

pub fn spawn_stderr_reader(
    stderr: std::process::ChildStderr,
    agent_name: &str,
    runtime_logs: &Option<Arc<dyn crate::runtime_sink::RuntimeLogSink>>,
    correlation: Option<pylon_core::correlation::RuntimeCorrelation>,
    stderr_tail: Arc<super::StderrTail>,
) {
    let agent_name_stderr = agent_name.to_string();
    let stderr_logs = runtime_logs.clone();
    std::thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !l.is_empty() {
                stderr_tail.push(&l);
                let safe = pylon_foundations::sanitize::sanitize_message(&l);
                // LOG-01：stderr 行回声只作 console/外部日志出口（fmt layer），
                // target 专属标记让 RuntimeLogLayer 跳过——hub 唯一归属下方显式 push，
                // 同一行只进 hub 一次（方案书 §5.14，原 A/B 双写）。
                // LOG-02 同步：echo 级别跟随 classify_stderr_level——agent（Hermes 等）
                // 的 INFO 日志走 stderr，不得顶着 ERROR 帽子；只有真实致命信号才 ERROR。
                // 原实现硬编码 tracing::error! 导致满屏 ERROR agent_stderr_echo（2026-08-19）。
                // 注意：tracing::event! / 各 level 宏的 target 与 level 都进 static callsite，
                // 必须是编译期常量（E0435）——target 用 const 路径、level 用 match 分支。
                // #258：level/code 共用同一份解析结果——每行一次 JSON 解析、一次等级判定。
                let fields = stderr_fields(&l);
                let level = fields
                    .as_ref()
                    .and_then(level_from_fields)
                    .unwrap_or_else(|| unstructured_level(&l));
                match level {
                    "error" => tracing::error!(
                        target: AGENT_STDERR_ECHO_TARGET,
                        "{} stderr: {}",
                        agent_name_stderr,
                        safe
                    ),
                    "warn" => tracing::warn!(
                        target: AGENT_STDERR_ECHO_TARGET,
                        "{} stderr: {}",
                        agent_name_stderr,
                        safe
                    ),
                    _ => tracing::info!(
                        target: AGENT_STDERR_ECHO_TARGET,
                        "{} stderr: {}",
                        agent_name_stderr,
                        safe
                    ),
                }
                if let Some(hub) = &stderr_logs {
                    // LOG-03：增量字段——category=stderr（监控窗口可独立筛选原始 stderr，
                    // 与结构化后端日志分离，§5.14"原始 stderr 不应和结构化错误混在默认
                    // 错误列表"）；code=结构化 JSON 顶层 code（agent 自报码，与 DEL-05
                    // wire_code 词汇分离，不发明新码）；rawAvailable=true（真实行文本承载
                    // 于 message，区别于历史 B 型占位符"Agent stderr output"）。
                    hub.push_with_context(
                        pylon_foundations::time::Timestamp::now(),
                        level.to_string(),
                        "agent-stderr".to_string(),
                        None,
                        safe,
                        serde_json::Map::from_iter([(
                            "agent".to_string(),
                            serde_json::Value::String(agent_name_stderr.clone()),
                        )]),
                        correlation.clone(),
                        pylon_core::log_context::RuntimeLogContext {
                            code: fields.as_ref().and_then(code_from_fields),
                            category: Some(
                                pylon_core::log_context::LOG_CATEGORY_STDERR.to_string(),
                            ),
                            recoverable: None,
                            user_action_required: None,
                            raw_available: Some(true),
                        },
                    );
                }
            }
        }
    });
}

/// LOG-01：agent stderr 行回声的 tracing target（RuntimeLogLayer 据此跳过，hub 唯一归属显式 push）。
pub const AGENT_STDERR_ECHO_TARGET: &str = "agent_stderr_echo";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_string_levels_map_to_canonical_levels() {
        assert_eq!(classify_stderr_level(r#"{"level":"error"}"#), "error");
        assert_eq!(classify_stderr_level(r#"{"level":"FATAL"}"#), "error");
        assert_eq!(classify_stderr_level(r#"{"level":"Critical"}"#), "error");
        assert_eq!(classify_stderr_level(r#"{"level":"panic"}"#), "error");
        assert_eq!(classify_stderr_level(r#"{"level":"warn"}"#), "warn");
        assert_eq!(classify_stderr_level(r#"{"level":"WARNING"}"#), "warn");
        assert_eq!(classify_stderr_level(r#"{"level":"debug"}"#), "debug");
        assert_eq!(classify_stderr_level(r#"{"level":"trace"}"#), "debug");
        assert_eq!(classify_stderr_level(r#"{"level":"info"}"#), "info");
        // 可辨类型但词表外 → info
        assert_eq!(classify_stderr_level(r#"{"level":"verbose"}"#), "info");
    }

    #[test]
    fn structured_numeric_pino_levels_map() {
        assert_eq!(classify_stderr_level(r#"{"level":10}"#), "debug");
        assert_eq!(classify_stderr_level(r#"{"level":20}"#), "debug");
        assert_eq!(classify_stderr_level(r#"{"level":30}"#), "info");
        assert_eq!(classify_stderr_level(r#"{"level":40}"#), "warn");
        assert_eq!(classify_stderr_level(r#"{"level":50}"#), "error");
        assert_eq!(classify_stderr_level(r#"{"level":60}"#), "error");
        assert_eq!(classify_stderr_level(r#"{"level":70}"#), "info");
    }

    #[test]
    fn object_without_usable_level_falls_through_to_marker_scan() {
        // CR-101 语义钉子：对象存在但 level 缺失/类型不可辨 ⇒ 落回整行致命信号扫描。
        assert_eq!(
            classify_stderr_level(r#"{"msg":"process core dumped"}"#),
            "error"
        );
        assert_eq!(
            classify_stderr_level(r#"{"msg":"non-fatal hiccup"}"#),
            "info"
        );
        assert_eq!(classify_stderr_level(r#"{"msg":"hello"}"#), "info");
        assert_eq!(
            classify_stderr_level(r#"{"level":true,"msg":"aborting"}"#),
            "error"
        );
    }

    #[test]
    fn non_object_json_goes_through_marker_scan() {
        assert_eq!(classify_stderr_level("[1,2,3]"), "info");
        // 合法 JSON 标量不是 object → 整行扫描（钉住原实现的字面语义）
        assert_eq!(classify_stderr_level(r#""fatal string""#), "error");
        assert_eq!(classify_stderr_level("42"), "info");
    }

    #[test]
    fn unstructured_lines_use_marker_tables() {
        assert_eq!(classify_stderr_level("thread panic: blew up"), "error");
        assert_eq!(
            classify_stderr_level("segmentation fault (core dumped)"),
            "error"
        );
        assert_eq!(
            classify_stderr_level("operation failed but non-fatal"),
            "info"
        );
        assert_eq!(classify_stderr_level("not fatal: recovered"), "info");
        assert_eq!(classify_stderr_level("just an info line"), "info");
        assert_eq!(classify_stderr_level(""), "info");
    }

    #[test]
    fn code_extraction_only_from_structured_objects() {
        assert_eq!(
            extract_stderr_code(r#"{"code":"ECONN"}"#),
            Some("ECONN".to_string())
        );
        // code 取 trim 后非空值
        assert_eq!(
            extract_stderr_code(r#"  {"code":"  E2  "}  "#),
            Some("E2".to_string())
        );
        assert_eq!(extract_stderr_code(r#"{"code":""}"#), None);
        assert_eq!(extract_stderr_code(r#"{"code":42}"#), None);
        assert_eq!(extract_stderr_code(r#"{"msg":"no code"}"#), None);
        assert_eq!(extract_stderr_code("plain line"), None);
    }

    #[test]
    fn parse_once_derivation_matches_public_helpers() {
        // #258 重构钉子：spawn 循环「一次解析派生 level/code」与公开入口逐行一致。
        let lines = [
            r#"{"level":"warn","code":"W1"}"#,
            r#"{"level":50,"code":"E50"}"#,
            r#"{"level":true,"msg":"aborting"}"#,
            r#"{"msg":"core dumped"}"#,
            "fatal: plain",
            "regular output",
            "[1,2]",
            r#""fatal string""#,
            "",
        ];
        for line in lines {
            let fields = stderr_fields(line);
            let level = fields
                .as_ref()
                .and_then(level_from_fields)
                .unwrap_or_else(|| unstructured_level(line));
            assert_eq!(level, classify_stderr_level(line), "level diverged: {line}");
            assert_eq!(
                fields.as_ref().and_then(code_from_fields),
                extract_stderr_code(line),
                "code diverged: {line}"
            );
        }
    }
}
