//! panic hook：**同步**写盘的那一条。
//!
//! release profile 是 `panic = "abort"`（`src-tauri/Cargo.toml`）：进程直接终止，没有
//! unwind 兜底，Windows 上只留一个 WER 桶。日志若只走 `tracing_appender::non_blocking`，
//! 那条记录只是被**投进队列**——而 abort 之前 worker 线程很可能再也不被调度，于是最该
//! 留下的那条恰好丢掉。所以这里绕过 non_blocking，直接 append 到当日文件并 flush。
//!
//! 设计约束：
//! - **绝不 `unwrap`**：hook 里再 panic 一次会变成 double-panic / abort。
//! - 文件按需重开（同一当日文件，append）：writer 可能还没轮到打开它。
//! - 有自己的一条小额度（[`MAX_APPEND_BYTES`]）：panic 风暴能绕过每日预算，因为它走的
//!   正是预算 metering 之前的那一侧。
//! - 记完之后**再**发一条 `tracing::error!`（target = `pylon::panic`），让 stderr、ring
//!   buffer 与 live tail 也拿到。文件 sink 侧对该 target 做等值去重（panic hook 已经
//!   同步写过那一行），订阅侧仍能看到。

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::SystemTime;

use super::budget::{daily_file_name, unix_day};
use super::file_sink::LogFileSpec;
use super::{log_file_spec, PANIC_TARGET};

/// 本进程 panic 记录允许同步写盘的总字节上限（1 MiB）。
///
/// 只约束 hook 自己这条同步路径；正常日志仍走每日预算。
const MAX_APPEND_BYTES: usize = 1024 * 1024;

/// 单条记录的 payload / backtrace 截断上限。
const MAX_PAYLOAD_BYTES: usize = 4 * 1024;
const MAX_BACKTRACE_BYTES: usize = 16 * 1024;

static INSTALLED: OnceLock<()> = OnceLock::new();
static APPENDED_BYTES: AtomicUsize = AtomicUsize::new(0);

/// 安装 hook。幂等——重复调用（子进程重建 subscriber）不会叠加 hook。
pub fn install() {
    if INSTALLED.set(()).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_panic_record(info);
        // 标准输出仍然保留（原来的 `thread '...' panicked at ...` 一行）。
        previous(info);
    }));
}

/// 字节上限的预留：`fetch_add` 让并发 panic 的线程各自拿到不重叠的区段。
enum Reservation {
    Granted,
    /// 这次刚好用掉最后一段——写一条「额度用尽」，之后不再写。
    Last,
    Refused,
}

fn reserve(len: usize) -> Reservation {
    let before = APPENDED_BYTES.fetch_add(len, Ordering::Relaxed);
    if before >= MAX_APPEND_BYTES {
        // 夹住，防止溢出后绕回一份新额度。
        APPENDED_BYTES.store(MAX_APPEND_BYTES, Ordering::Relaxed);
        return Reservation::Refused;
    }
    if before.saturating_add(len) >= MAX_APPEND_BYTES {
        Reservation::Last
    } else {
        Reservation::Granted
    }
}

/// 按 char 边界截断，附总长度标注。
fn truncate_on_char_boundary(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n... [已截断，实际 {max_bytes} 字节上限 / 共 {} 字节]",
        &text[..end],
        text.len()
    )
}

fn panic_payload(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(text) = info.payload().downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = info.payload().downcast_ref::<String>() {
        return text.clone();
    }
    "<非字符串 panic 载荷>".to_string()
}

fn panic_location(info: &std::panic::PanicHookInfo<'_>) -> String {
    info.location()
        .map(|location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        })
        .unwrap_or_else(|| "<未知位置>".to_string())
}

fn thread_label() -> String {
    let current = std::thread::current();
    let name = current.name().unwrap_or("<未命名>").to_string();
    format!("{name} ({:?})", current.id())
}

/// 组装记录文本。写成**一个块**，由一次 `write_all` 落盘：每日预算按「行」计数，
/// 一条 panic 记录应当只消耗一次额度。
fn render_record(payload: &str, location: &str, thread: &str, backtrace: &str, day: i32) -> String {
    let timestamp = chrono::DateTime::<chrono::Utc>::from(SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    format!(
        "{} ERROR {} thread={} location={} version={} day={}\npayload: {}\nbacktrace:\n{}\n",
        timestamp,
        PANIC_TARGET,
        thread,
        location,
        env!("CARGO_PKG_VERSION"),
        day,
        truncate_on_char_boundary(payload, MAX_PAYLOAD_BYTES),
        truncate_on_char_boundary(backtrace, MAX_BACKTRACE_BYTES),
    )
}

/// panic hook 的落盘侧（单独暴露以便单测直接驱动，不真的 panic）。
pub fn write_panic_record(info: &std::panic::PanicHookInfo<'_>) {
    let payload = panic_payload(info);
    let location = panic_location(info);
    let thread = thread_label();
    // force_capture：不依赖 RUST_BACKTRACE，发行构建下也一定有。
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    let day = unix_day(SystemTime::now());
    let line = render_record(&payload, &location, &thread, &backtrace, day);
    if let Some(spec) = log_file_spec() {
        append_panic_line(spec, day, &line);
    }
    emit_tracing_record(&payload, &location, &thread, &backtrace);
}

/// 同步落盘一条 panic 记录（真实路径；`write_panic_record` 与单测共用）。
///
/// 自成一条额度（[`MAX_APPEND_BYTES`]）：panic 风暴走的是每日预算 **metering 之前**
/// 的那一侧，不能让它们绕开闸门写满盘。
fn append_panic_line(spec: &LogFileSpec, day: i32, line: &str) {
    match reserve(line.len()) {
        Reservation::Refused => {}
        verdict => {
            let path: PathBuf = spec
                .dir
                .join(daily_file_name(&spec.prefix, &spec.suffix, day));
            // 目录缺失时 create_dir_all 兜一次（writer 可能还没跑过）。
            let _ = std::fs::create_dir_all(&spec.dir);
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = file.write_all(line.as_bytes());
                let _ = file.flush();
            }
            if matches!(verdict, Reservation::Last) {
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .and_then(|mut file| {
                        file.write_all(
                            format!(
                                "{} WARN {} panic 同步写盘额度已用尽（{MAX_APPEND_BYTES} 字节），后续 panic 记录不再落盘\n",
                                chrono::DateTime::<chrono::Utc>::from(SystemTime::now())
                                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                                PANIC_TARGET,
                            )
                            .as_bytes(),
                        )
                    });
            }
        }
    }
}

/// 让 stderr / ring buffer / live tail 也拿到这条（target 与文件 sink 的过滤谓词对齐）。
fn emit_tracing_record(payload: &str, location: &str, thread: &str, backtrace: &str) {
    tracing::error!(
        target: PANIC_TARGET,
        thread = %thread,
        location = %location,
        backtrace = %backtrace,
        "panic: {payload}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_path(spec: &LogFileSpec) -> PathBuf {
        spec.dir.join(daily_file_name(
            &spec.prefix,
            &spec.suffix,
            unix_day(SystemTime::now()),
        ))
    }

    #[test]
    fn rendered_record_carries_thread_location_payload_and_backtrace() {
        let text = render_record(
            "boom",
            "src/main.rs:10:5",
            "main (ThreadId(1))",
            "   0: std::panicking",
            42,
        );
        assert!(text.contains("ERROR pylon::panic"));
        assert!(text.contains("thread=main (ThreadId(1))"));
        assert!(text.contains("location=src/main.rs:10:5"));
        assert!(text.contains("payload: boom"));
        assert!(text.contains("backtrace:"));
        assert!(text.contains("0: std::panicking"));
        assert!(text.contains(&format!("version={}", env!("CARGO_PKG_VERSION"))));
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        // 多字节字符恰好跨越截断点时必须回退到边界上，不能切出非法 UTF-8。
        let text = "中".repeat(10);
        let truncated = truncate_on_char_boundary(&text, 7);
        assert!(truncated.starts_with("中"), "{truncated}");
        assert!(truncated.contains("已截断"));
        assert!(truncated.is_char_boundary(0));
        // 短文本原样返回
        assert_eq!(truncate_on_char_boundary("abc", 16), "abc");
    }

    #[test]
    fn reservation_refuses_beyond_the_budget_and_never_wraps() {
        // 直接驱动计数器：先耗尽，再确认后续预留全部被拒（而不是绕回新额度）。
        let before = APPENDED_BYTES.swap(MAX_APPEND_BYTES, Ordering::Relaxed);
        assert!(matches!(reserve(1), Reservation::Refused));
        assert_eq!(APPENDED_BYTES.load(Ordering::Relaxed), MAX_APPEND_BYTES);
        APPENDED_BYTES.store(before, Ordering::Relaxed);
    }

    #[test]
    fn last_reservation_fires_once_then_refuses() {
        let before = APPENDED_BYTES.swap(MAX_APPEND_BYTES - 1, Ordering::Relaxed);
        assert!(matches!(reserve(4), Reservation::Last));
        assert!(matches!(reserve(1), Reservation::Refused));
        APPENDED_BYTES.store(before, Ordering::Relaxed);
    }

    /// 落盘路径端到端：真的走 `append_panic_line`（开文件 → append → flush），
    /// 四个字段都必须在当日文件里。**不是**自己 `fs::write` 一遍再读回来。
    #[test]
    fn append_writes_the_record_to_todays_file_with_all_four_fields() {
        let dir = std::env::temp_dir().join(format!(
            "pylon-panic-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let spec = LogFileSpec::new(dir.clone());
        // 目录故意不预建：append 路径自己建（首次写发生在启动兜底路径的情形）。
        let day = unix_day(SystemTime::now());
        let line = render_record(
            "assertion failed: expected 1 got 2",
            "src/foo.rs:3:9",
            "worker (ThreadId(7))",
            "   0: backtrace_frame",
            day,
        );
        append_panic_line(&spec, day, &line);
        let content = std::fs::read_to_string(record_path(&spec)).expect("当日文件必须存在");
        for needle in [
            "payload: assertion failed: expected 1 got 2",
            "location=src/foo.rs:3:9",
            "thread=worker (ThreadId(7))",
            "0: backtrace_frame",
        ] {
            assert!(content.contains(needle), "缺少 {needle:?}：{content}");
        }
        // 第二条必须是追加而不是覆盖（崩溃循环里同日多次 panic 都要留证）。
        append_panic_line(&spec, day, &line);
        let content = std::fs::read_to_string(record_path(&spec)).expect("read");
        assert_eq!(
            content.matches("payload: assertion").count(),
            2,
            "两次 panic 必须都留在同一文件里：{content}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
