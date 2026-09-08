//! ACP stderr drain（A1c：从 transport.rs 抽出——两后端共用，legacy 删除后保留）。

use std::io::{BufRead, BufReader};
use std::sync::Arc;

pub(crate) fn classify_stderr_level(line: &str) -> &'static str {
    // 1. 结构化 JSON 优先：`level` 字段权威（字符串 + 数字）
    if let Ok(serde_json::Value::Object(map)) =
        serde_json::from_str::<serde_json::Value>(line.trim())
    {
        if let Some(lv) = map.get("level") {
            if let Some(s) = lv.as_str() {
                return match s.to_ascii_lowercase().as_str() {
                    "error" | "fatal" | "critical" | "panic" => "error",
                    "warn" | "warning" => "warn",
                    "debug" | "trace" => "debug",
                    _ => "info",
                };
            }
            if let Some(n) = lv.as_u64() {
                // CR-103：pino 数字 level（10/20→debug，30→info，40→warn，50/60→error）。
                return match n {
                    10 | 20 => "debug",
                    30 => "info",
                    40 => "warn",
                    50 | 60 => "error",
                    _ => "info",
                };
            }
        }
    }
    // 2. 非结构化行：致命信号否定式先排除（CR-101——"non-fatal" 可辩驳，不得因含
    //    "fatal" 子串误升 error），再匹配不可辩驳致命信号（不依赖 "ERROR" 字样）。
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
    // 3. 普通 stderr 输出 → info（不再默认 error）
    "info"
}

pub(crate) fn extract_stderr_code(line: &str) -> Option<String> {
    if let Ok(serde_json::Value::Object(map)) =
        serde_json::from_str::<serde_json::Value>(line.trim())
    {
        if let Some(code) = map.get("code").and_then(|v| v.as_str()) {
            let code = code.trim();
            if !code.is_empty() {
                return Some(code.to_string());
            }
        }
    }
    None
}

pub(crate) fn spawn_stderr_reader(
    stderr: std::process::ChildStderr,
    agent_name: &str,
    runtime_logs: &Option<Arc<crate::runtime_log::RuntimeLogHub>>,
    correlation: Option<crate::correlation::RuntimeCorrelation>,
    stderr_tail: Arc<super::StderrTail>,
) {
    let agent_name_stderr = agent_name.to_string();
    let stderr_logs = runtime_logs.clone();
    std::thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !l.is_empty() {
                stderr_tail.push(&l);
                let safe = crate::runtime_log::sanitize_message(l.clone());
                // LOG-01：stderr 行回声只作 console/外部日志出口（fmt layer），
                // target 专属标记让 RuntimeLogLayer 跳过——hub 唯一归属下方显式 push，
                // 同一行只进 hub 一次（方案书 §5.14，原 A/B 双写）。
                // LOG-02 同步：echo 级别跟随 classify_stderr_level——agent（Hermes 等）
                // 的 INFO 日志走 stderr，不得顶着 ERROR 帽子；只有真实致命信号才 ERROR。
                // 原实现硬编码 tracing::error! 导致满屏 ERROR agent_stderr_echo（2026-08-19）。
                // 注意：tracing::event! / 各 level 宏的 target 与 level 都进 static callsite，
                // 必须是编译期常量（E0435）——target 用 const 路径、level 用 match 分支。
                match classify_stderr_level(&l) {
                    "error" => tracing::error!(
                        target: crate::runtime_log::AGENT_STDERR_ECHO_TARGET,
                        "{} stderr: {}",
                        agent_name_stderr,
                        safe
                    ),
                    "warn" => tracing::warn!(
                        target: crate::runtime_log::AGENT_STDERR_ECHO_TARGET,
                        "{} stderr: {}",
                        agent_name_stderr,
                        safe
                    ),
                    _ => tracing::info!(
                        target: crate::runtime_log::AGENT_STDERR_ECHO_TARGET,
                        "{} stderr: {}",
                        agent_name_stderr,
                        safe
                    ),
                }
                if let Some(hub) = &stderr_logs {
                    // LOG-02：等级按行解析（结构化 JSON level 优先；非结构化默认 info，
                    // 不依赖 "ERROR" 字样判定严重度）。方案书 §5.14 建议等级。
                    let level = classify_stderr_level(&l);
                    // LOG-03：增量字段——category=stderr（监控窗口可独立筛选原始 stderr，
                    // 与结构化后端日志分离，§5.14"原始 stderr 不应和结构化错误混在默认
                    // 错误列表"）；code=结构化 JSON 顶层 code（agent 自报码，与 DEL-05
                    // wire_code 词汇分离，不发明新码）；rawAvailable=true（真实行文本承载
                    // 于 message，区别于历史 B 型占位符"Agent stderr output"）。
                    hub.push_with_context(
                        crate::time::Timestamp::now(),
                        level,
                        "agent-stderr",
                        None,
                        safe,
                        serde_json::Map::from_iter([(
                            "agent".to_string(),
                            serde_json::Value::String(agent_name_stderr.clone()),
                        )]),
                        correlation.clone(),
                        crate::runtime_log::RuntimeLogContext {
                            code: extract_stderr_code(&l),
                            category: Some(crate::runtime_log::LOG_CATEGORY_STDERR.to_string()),
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
