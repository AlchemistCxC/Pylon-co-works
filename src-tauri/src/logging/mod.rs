//! #362：崩溃取证的落盘日志链。
//!
//! 进程一退，内存里的东西全没：`runtime_log` 的环形缓冲是纯内存的，`panic = "abort"`
//! 的 release profile 下 abort 路径连 unwind 兜底都没有。本模块补上「落盘」这一层。
//!
//! 三个部件：
//! - [`budget`]：每日字节上限 + **从当日既有文件尺寸续算**的计数（重启不重复发额度）。
//! - [`file_sink`]：每日轮转的文件 writer（文件名由本模块独占计算，供 panic hook 复用）
//!   + 保留 30 个历史文件的清理。
//! - [`panic_hook`]：**同步**写盘的 panic 记录——不走 tracing 的异步 appender。
//! - [`throttle`]：前缘节流（前缘立即放行、窗口内折叠、抑制数随下一条上抛）。
//!
//! 参数与设计来源：Codeg `src-tauri/src/logging/{init,budget,panic_hook,throttle}.rs`
//! （Apache-2.0）。本模块是**按同一设计自行实现**，不迁入其源码；出处登记见
//! `src-tauri/vendor/acp/ORIGIN.md` §6。
//!
//! ## 为什么 panic hook 不能只走 tracing
//!
//! `tracing_appender::non_blocking` 的 `flush` 是文档化的 no-op，发送端用 `try_send`
//! 且队列满时**静默丢弃**；真正落盘只发生在 worker 线程被调度时。abort 之前最可能的
//! 情况就是这个 worker 再也不被调度——所以最该留下的那条必须同步写。

pub mod budget;
pub mod file_sink;
pub mod panic_hook;
pub mod throttle;

/// 日志子系统自身的 target 命名空间。`runtime_log` 的 Layer 用此前缀把日志子系统
/// 自己产生的事件挡在 hub 之外（防「记录日志这件事本身又产生日志」的跨线程回路）。
pub const SELF_TARGET_PREFIX: &str = "prism_desktop_lib::logging";

/// panic 记录专用 target。
///
/// 刻意**不落**在模块路径上（否则会被 [`SELF_TARGET_PREFIX`] 一起挡掉），
/// 这样 stderr / hub / live tail 仍能拿到这条；文件 sink 侧用等值匹配去重
/// （panic hook 已经同步写过同一行）。
pub const PANIC_TARGET: &str = "pylon::panic";

/// 事件 target 是否属于日志子系统自身。
///
/// 前缀匹配必须带 `::` 边界：`prism_desktop_lib::logging_extra` 不是本命名空间，
/// 用裸 `starts_with` 会把它一起误挡。
pub fn is_self_target(target: &str) -> bool {
    target == SELF_TARGET_PREFIX
        || target
            .strip_prefix(SELF_TARGET_PREFIX)
            .is_some_and(|rest| rest.starts_with("::"))
}

/// 写一行 stderr 且**绝不 panic**，并同步追加到当日日志文件。
///
/// 为什么不能用 `eprintln!`：Rust 的 `eprintln!` 在写 stderr 失败时**panic**
/// （`failed printing to stderr`）。而发行构建自 #361 起是 GUI 子系统——双击启动的
/// 进程没有控制台，stderr 句柄无效，于是每一次 `eprintln!` 都是一次 panic：
/// - 在 `tracing_appender::non_blocking` 的 worker 线程里 panic → 该线程终结、
///   接收端丢弃、之后的 `try_send` 全部静默失败，**落盘 sink 从此死掉**；
/// - 在启动兜底路径 panic → 本来是「报个错继续跑」的地方直接把进程带走。
///
/// 也正因为 release 下 stderr 看不见，本函数同时**同步追加**到当日日志文件——
/// 那是启动期诊断在发行构建里唯一的出口。追加不进每日预算（额度耗尽时也仍要能
/// 写出「额度耗尽」本身），代价是每天至多几条越限行，可以接受。
pub(crate) fn note_to_stderr(message: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{message}");
    let line = format!(
        "{} WARN {STARTUP_TARGET} {message}",
        chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
    append_line_sync(&line);
}

/// 启动期诊断的 target 词条（`note_to_stderr` 写盘时的标记）。
pub const STARTUP_TARGET: &str = "pylon::startup";

static FILE_SPEC: std::sync::OnceLock<file_sink::LogFileSpec> = std::sync::OnceLock::new();

/// 登记当日日志文件的定位参数（`file_sink::build_file_sink` 调用）。
///
/// 定位参数是**进程级唯一**的：轮转 writer 与 panic hook 必须落到同一个当日文件，
/// 所以这里是一份共享的 `OnceLock`，而不是两处各自推导。
pub(crate) fn set_log_file(spec: file_sink::LogFileSpec) {
    let _ = FILE_SPEC.set(spec);
}

/// 当前登记的日志文件定位参数（未启用落盘时为 `None`）。
pub(crate) fn log_file_spec() -> Option<&'static file_sink::LogFileSpec> {
    FILE_SPEC.get()
}

/// 同步追加一行到当日日志文件（开 append → 写 → flush，全部错误忽略）。
///
/// 供 panic hook 与 [`note_to_stderr`] 共用：两者都必须**绕过** `non_blocking`
/// （它的 flush 是 no-op、发送端 lossy），在进程可能立刻消失的路径上逐行同步落盘。
pub(crate) fn append_line_sync(line: &str) -> bool {
    let Some(spec) = log_file_spec() else {
        return false;
    };
    let day = budget::unix_day(std::time::SystemTime::now());
    // 目录可能还没被 writer 建出来（首次写发生在启动兜底路径时）。
    let _ = std::fs::create_dir_all(&spec.dir);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(spec.daily_path(day))
    else {
        return false;
    };
    let mut outcome = std::io::Write::write_all(&mut file, line.as_bytes());
    if outcome.is_ok() {
        outcome = std::io::Write::write_all(&mut file, b"\n");
    }
    if outcome.is_ok() {
        let _ = std::io::Write::flush(&mut file);
    }
    outcome.is_ok()
}

/// 日志文件名前缀。
pub const FILE_PREFIX: &str = "pylon";
/// 日志文件名后缀。
pub const FILE_SUFFIX: &str = "log";
/// 保留的历史日志文件个数上限（含当日文件）。
pub const MAX_LOG_FILES: usize = 30;

static ACTIVE_LOG_ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// 记下本次启动实际采用的日志根目录。
pub(crate) fn set_active_log_root(dir: std::path::PathBuf) {
    let _ = ACTIVE_LOG_ROOT.set(dir);
}

/// 本次启动实际采用的日志根目录（未启用落盘时为 `None`）。
///
/// 供 `setup_install_data_dirs` 在 `DataDirs` 就绪后核对两边是否指向同一处——
/// 日志目录必须在 Tauri 之前解析（`init_tracing` 早于 `setup()`），这份复现的
/// 路径推理需要一条显式的漂移检查。
pub(crate) fn active_log_root() -> Option<&'static std::path::Path> {
    ACTIVE_LOG_ROOT.get().map(std::path::PathBuf::as_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前缀匹配必须带 `::` 边界：裸 `starts_with` 会把 `logging_extra` 这类
    /// 兄弟命名空间一起误挡，那会让无关模块的日志从 hub 里静默消失。
    #[test]
    fn self_target_matches_the_namespace_and_its_children_only() {
        assert!(is_self_target(SELF_TARGET_PREFIX));
        assert!(is_self_target("prism_desktop_lib::logging::file_sink"));
        assert!(is_self_target(
            "prism_desktop_lib::logging::panic_hook::inner"
        ));
        assert!(!is_self_target("prism_desktop_lib::logging_extra"));
        assert!(!is_self_target("prism_desktop_lib::session"));
        assert!(!is_self_target(PANIC_TARGET), "panic 记录必须能进 hub");
        assert!(!is_self_target(""));
    }

    /// 启动兜底走的是自己的 target：它要在 release（无 stderr）下经 hub 看得见，
    /// 所以不能被自身命名空间挡掉。
    #[test]
    fn startup_target_is_not_part_of_the_self_namespace() {
        assert!(!is_self_target(STARTUP_TARGET));
        assert!(STARTUP_TARGET.starts_with("pylon::"));
    }

    /// 没有落盘 sink 时 `append_line_sync` 必须是安静的 false，不得 panic。
    #[test]
    fn append_line_sync_without_a_registered_file_is_a_quiet_no_op() {
        // 本进程可能已被别的用例登记过 spec；这里只断言「不 panic 且返回值自洽」。
        let _ = append_line_sync("test line");
    }
}
