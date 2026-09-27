//! 落盘 sink：每日轮转的 log writer + 历史文件清理 + 通报出口。
//!
//! 文件名**由本模块独占计算**（[`super::budget::daily_file_name`]）：panic hook 必须
//! 落到同一个当日文件上，两处各自推导格式迟早会分叉。
//!
//! writer 自身实现 [`std::io::Write`]，交给 `tracing_appender::non_blocking` 在
//! 独立 worker 线程上跑——所以它内部**不需要锁**（单持有），也不要在这里做会
//! 重新进 tracing 的事。
//!
//! 通报（额度用尽 / 跨日重开）刻意**不走 tracing**：这段代码就跑在 subscriber 的
//! file sink 里，回灌会形成回路。出口是 `logging::note_to_stderr`（**不是** `eprintln!`
//! ——release 是 GUI 子系统，stderr 无效时 `eprintln!` 会 panic，而这里正是
//! `non_blocking` 的 worker 线程，panic 等于永久关掉落盘）+ 直接推一条合成 WARN 进
//! `runtime_log` hub——后者是 release 下唯一还看得见的地方。

use std::io::{self, Write};
use std::path::PathBuf;
use std::time::SystemTime;

use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};

use super::budget::{
    configured_max_bytes_per_day, daily_file_name, resume_point, unix_day, DayBudget, Notice,
    Verdict,
};
use super::{FILE_PREFIX, FILE_SUFFIX, MAX_LOG_FILES};

/// 一个日志目录的定位参数（writer 与 panic hook 共用）。
#[derive(Debug, Clone)]
pub struct LogFileSpec {
    pub dir: PathBuf,
    pub prefix: String,
    pub suffix: String,
    pub max_files: usize,
}

impl LogFileSpec {
    /// 生产默认：`<logs_root>/pylon.<date>.log`，保留 [`MAX_LOG_FILES`] 个。
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            prefix: FILE_PREFIX.to_string(),
            suffix: FILE_SUFFIX.to_string(),
            max_files: MAX_LOG_FILES,
        }
    }

    /// 当日文件路径。
    pub fn daily_path(&self, day: i32) -> PathBuf {
        self.dir
            .join(daily_file_name(&self.prefix, &self.suffix, day))
    }
}

/// 打开（必要时创建）当日文件，append 模式。
///
/// append 是刻意的：进程可能因崩溃循环反复重启，同日重开必须续写而不是覆盖——
/// 覆盖会把上一次崩溃前的现场抹掉，那正是要保留的东西。
pub fn open_daily(spec: &LogFileSpec, day: i32) -> io::Result<std::fs::File> {
    std::fs::create_dir_all(&spec.dir)?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(spec.daily_path(day))
}

/// 清理历史文件：只保留按名字（日期形）排序后的最后 `max_files` 个。
///
/// 名字形如 `pylon.2026-09-26.log`，字典序即时间序，故不需要解析日期。清理失败
/// 只记一条 stderr——保留策略不是正确性的一部分，不能反过来让日志初始化失败。
pub fn prune_history(spec: &LogFileSpec) {
    let Ok(entries) = std::fs::read_dir(&spec.dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(&format!("{}.", spec.prefix))
                        && name.ends_with(&format!(".{}", spec.suffix))
                })
        })
        .collect();
    if files.len() <= spec.max_files {
        return;
    }
    files.sort();
    let excess = files.len() - spec.max_files;
    for path in files.into_iter().take(excess) {
        if let Err(error) = std::fs::remove_file(&path) {
            super::note_to_stderr(&format!(
                "[logging] 清理历史日志失败 {}: {error}",
                path.display()
            ));
        }
    }
}

/// 通报出口：stderr + 合成一条 hub 记录（不经过 `tracing`）。
fn report(notice: Notice) {
    let message = match notice {
        Notice::Exhausted { limit, written } => format!(
            "日志今日额度用尽（上限 {limit} 字节，已写 {written} 字节）：本日后续行被丢弃，次日自动恢复。可用 {} 调整。",
            super::budget::MAX_BYTES_ENV
        ),
        Notice::Reopened {
            previous_day,
            dropped_lines,
            dropped_bytes,
        } => format!(
            "日志跨日重开（上一日 day={previous_day}）：该日共丢弃 {dropped_lines} 行 / {dropped_bytes} 字节。"
        ),
    };
    super::note_to_stderr(&format!("[logging] {message}"));
    crate::runtime_log::push_synthetic_warn(super::SELF_TARGET_PREFIX, &message);
}

/// 每日轮转 + 每日预算的 writer（`tracing_appender::non_blocking` 的 `W`）。
pub struct DailyRotatingWriter {
    spec: LogFileSpec,
    budget: DayBudget,
    current: Option<(i32, std::fs::File)>,
}

impl DailyRotatingWriter {
    /// 构造：预算从当日既有文件尺寸**续算**（见 [`super::budget`] 的模块说明）。
    pub fn new(spec: LogFileSpec) -> Self {
        let day = unix_day(SystemTime::now());
        let already_written = resume_point(&spec.dir, &spec.prefix, &spec.suffix, day);
        Self {
            budget: DayBudget::resuming(configured_max_bytes_per_day(), day, already_written),
            spec,
            current: None,
        }
    }

    /// 确保当前文件是 `day` 的那一个；跨日时轮转并清理历史。
    fn ensure_day(&mut self, day: i32) -> io::Result<&mut std::fs::File> {
        let rotate = match &self.current {
            Some((current_day, _)) => *current_day != day,
            None => true,
        };
        if rotate {
            self.current = Some((day, open_daily(&self.spec, day)?));
            prune_history(&self.spec);
        }
        Ok(&mut self.current.as_mut().expect("刚写入").1)
    }
}

impl Write for DailyRotatingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let day = unix_day(SystemTime::now());
        let (verdict, notices) = self.budget.admit(day, buf.len());
        for notice in notices {
            report(notice);
        }
        match verdict {
            // 丢弃必须**看起来像一次干净写入**：报错会让 tracing 打印自己的写失败，
            // 那又是一条日志——正是额度耗尽时最不该发生的事。
            Verdict::Drop => Ok(buf.len()),
            Verdict::Write => self.ensure_day(day)?.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match &mut self.current {
            Some((_, file)) => file.flush(),
            None => Ok(()),
        }
    }
}

/// 组装落盘 sink。目录不可用时返回 `None` —— **日志初始化绝不能让应用起不来**。
pub fn build_file_sink(spec: LogFileSpec) -> Option<(NonBlocking, WorkerGuard)> {
    if let Err(error) = std::fs::create_dir_all(&spec.dir) {
        super::note_to_stderr(&format!(
            "[logging] 日志目录不可用，落盘 sink 关闭 {}: {error}",
            spec.dir.display()
        ));
        return None;
    }
    // panic hook 与 writer 共用同一份定位参数：两者必须落到同一个当日文件。
    super::set_log_file(spec.clone());
    super::set_active_log_root(spec.dir.clone());
    Some(tracing_appender::non_blocking(DailyRotatingWriter::new(
        spec,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_spec(name: &str) -> LogFileSpec {
        let dir =
            std::env::temp_dir().join(format!("pylon-log-sink-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        LogFileSpec::new(dir)
    }

    #[test]
    fn writes_lines_and_appends_across_reopen() {
        let spec = temp_spec("append");
        let day = unix_day(SystemTime::now());
        {
            let mut writer = DailyRotatingWriter::new(spec.clone());
            writer.write_all(b"first\n").expect("write");
            writer.flush().expect("flush");
        }
        {
            let mut writer = DailyRotatingWriter::new(spec.clone());
            writer.write_all(b"second\n").expect("write");
            writer.flush().expect("flush");
        }
        let content = std::fs::read_to_string(spec.daily_path(day)).expect("read");
        assert_eq!(content, "first\nsecond\n");
        let _ = std::fs::remove_dir_all(&spec.dir);
    }

    /// #362 的关键细节：重启后**不得**重新发一份当天额度。
    ///
    /// 端到端穿过 writer（构造 → resume 种子 → admit → 丢弃），而不是只断言
    /// `resume_point` 的读数——issue 点名的正是「从既有文件尺寸 resume 计数」这条链。
    #[test]
    fn reopened_writer_over_a_used_file_does_not_get_a_fresh_quota() {
        let spec = temp_spec("resume");
        let day = unix_day(SystemTime::now());
        std::fs::create_dir_all(&spec.dir).expect("mkdir");
        std::fs::write(spec.daily_path(day), vec![b'x'; 8192]).expect("seed");
        assert_eq!(
            resume_point(&spec.dir, &spec.prefix, &spec.suffix, day),
            8192,
            "续算必须读到既有长度"
        );

        let mut writer = DailyRotatingWriter::new(spec.clone());
        // 把额度收窄到「已经用掉」：重启的实例必须一条都写不进去。
        writer.budget = DayBudget::resuming(Some(8192), day, 8192);
        assert_eq!(writer.write(b"after restart\n").expect("丢弃不是错误"), 14);
        let content = std::fs::read_to_string(spec.daily_path(day)).expect("read");
        assert_eq!(content.len(), 8192, "既有文件不得增长");
        assert!(writer.current.is_none(), "丢弃路径不该打开文件");
        let _ = std::fs::remove_dir_all(&spec.dir);
    }

    /// 跨日：writer 换到新文件、计数归零、历史清理同轮完成。
    #[test]
    fn writer_rotates_to_a_new_file_when_the_day_changes() {
        let mut spec = temp_spec("rotate");
        spec.max_files = 2;
        let day = unix_day(SystemTime::now());
        std::fs::create_dir_all(&spec.dir).expect("mkdir");
        // 造两个更早的日子，把保留上限占满
        for older in [day - 2, day - 1] {
            std::fs::write(spec.daily_path(older), b"x").expect("seed");
        }
        let mut writer = DailyRotatingWriter::new(spec.clone());
        // 直接驱动跨日：把预算的 day 推到昨天，下一次 write 就会轮转。
        writer.budget = DayBudget::resuming(Some(1_000), day, 0);
        assert_eq!(writer.write(b"today\n").expect("write"), 6);
        let content = std::fs::read_to_string(spec.daily_path(day)).expect("当日文件");
        assert_eq!(content, "today\n");
        // 保留上限 2：最老的那天必须被清掉，当日与前一天留下
        assert!(!spec.daily_path(day - 2).exists(), "最旧文件必须被清理");
        assert!(spec.daily_path(day).exists());
        let _ = std::fs::remove_dir_all(&spec.dir);
    }

    #[test]
    fn prune_history_keeps_only_the_newest_files() {
        let mut spec = temp_spec("prune");
        spec.max_files = 3;
        std::fs::create_dir_all(&spec.dir).expect("mkdir");
        for day in 0..6 {
            std::fs::write(spec.daily_path(day), b"x").expect("seed");
        }
        // 不匹配命名规则的文件必须原样保留（不是我们的日志）
        std::fs::write(spec.dir.join("other.txt"), b"x").expect("other");
        prune_history(&spec);
        let remaining: Vec<String> = std::fs::read_dir(&spec.dir)
            .expect("read_dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(remaining.len(), 4, "3 个日志 + 1 个无关文件：{remaining:?}");
        assert!(remaining.contains(&"other.txt".to_string()));
        assert!(remaining.contains(&daily_file_name("pylon", "log", 5)));
        assert!(!remaining.contains(&daily_file_name("pylon", "log", 0)));
        let _ = std::fs::remove_dir_all(&spec.dir);
    }

    #[test]
    fn drops_beyond_the_budget_look_like_successful_writes() {
        let spec = temp_spec("drop");
        let mut writer = DailyRotatingWriter::new(spec.clone());
        // 把额度封到 0：这是「已耗尽」的最短路径，不需要真的写满 512MiB。
        writer.budget = DayBudget::new(Some(0), unix_day(SystemTime::now()));
        assert_eq!(writer.write(b"anything\n").expect("丢弃不是错误"), 9);
        assert!(writer.current.is_none(), "被丢弃的行不该创建文件");
        let _ = std::fs::remove_dir_all(&spec.dir);
    }
}
