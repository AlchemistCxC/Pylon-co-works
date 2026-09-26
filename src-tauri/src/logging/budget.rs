//! 每日字节预算：给落盘 sink 加一道「一天最多写多少」的闸门。
//!
//! 没有闸门时，一条刷屏的日志路径能在下一次轮转之前把用户的盘写满。
//!
//! **关键细节是「从既有文件尺寸续算」。** appender 以 append 模式重开当日文件，
//! 若每次启动都从零计数，则每次重启都会重新发一份全额额度；崩溃循环（自动重启、
//! 自更新、监督进程）会把同一个文件撑到任意大——Codeg 记录过 34 GB / 8.8 小时的
//! 实例。所以启动时必须把当日文件的现有长度种进计数器。
//!
//! 判定按 **UTC 日**，与本模块的文件名生成同源（`%Y-%m-%d`）。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 每日子节上限默认值（512 MiB）。
pub const DEFAULT_MAX_BYTES_PER_DAY: u64 = 512 * 1024 * 1024;

/// 覆盖每日上限的环境变量；`"0"` 取消上限。
pub const MAX_BYTES_ENV: &str = "PYLON_LOG_MAX_BYTES";

const SECS_PER_DAY: i64 = 86_400;

/// 当日已写字节数超出上限后的处理：**丢弃**，不截断、不做部分写。
///
/// 截断会把一条 JSON/文本行切成半个，破坏「一行一条」的可解析性；部分写则会让
/// 计数与文件内容脱钩。丢弃在调用方看来是一次成功写入。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Write,
    Drop,
}

/// 通报：只在**状态跃迁**时产出，不给每条被丢弃的行发通报（否则通报自己就是刷屏源）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    /// 本日额度用尽（跃迁那一次）。
    Exhausted { limit: u64, written: u64 },
    /// 跨日重开：上一日丢了这么多（昨日无损失则不产出）。
    Reopened {
        previous_day: i32,
        dropped_lines: u64,
        dropped_bytes: u64,
    },
}

/// UTC 日序号（自 epoch 起的整数天）。用于跨日判定。
pub fn unix_day(now: SystemTime) -> i32 {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    unix_day_from_secs(secs)
}

/// 由 Unix 秒得 UTC 日序号。
pub fn unix_day_from_secs(secs: i64) -> i32 {
    secs.div_euclid(SECS_PER_DAY) as i32
}

/// 当日的日志文件名。**本模块独占这一格式**：panic hook 与轮转 writer 必须落到
/// 同一个文件上，所以文件名不能由两处各自推导。
pub fn daily_file_name(prefix: &str, suffix: &str, day: i32) -> String {
    let date = chrono::DateTime::from_timestamp(i64::from(day) * SECS_PER_DAY, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| format!("day-{day}"));
    format!("{prefix}.{date}.{suffix}")
}

/// 从当日既有文件长度读出「已经写了多少」，作为预算的起点。
///
/// 文件不存在（首次运行 / 已在别的日子轮转过）返回 0。读不到元数据也返回 0——
/// 预算只是闸门，宁可少算一次也不能让日志初始化失败。
pub fn resume_point(dir: &Path, prefix: &str, suffix: &str, day: i32) -> u64 {
    std::fs::metadata(dir.join(daily_file_name(prefix, suffix, day)))
        .map(|meta| meta.len())
        .unwrap_or(0)
}

/// 读每日上限：env 覆盖 → 默认。`"0"` 表示不限（返回 `None`）；非法值回退默认。
pub fn configured_max_bytes_per_day() -> Option<u64> {
    match std::env::var(MAX_BYTES_ENV) {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed == "0" {
                return None;
            }
            match trimmed.parse::<u64>() {
                Ok(value) => Some(value),
                Err(_) => Some(DEFAULT_MAX_BYTES_PER_DAY),
            }
        }
        Err(_) => Some(DEFAULT_MAX_BYTES_PER_DAY),
    }
}

/// 每日预算状态机：纯逻辑、无 IO、无时钟（日与长度都由调用方喂）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayBudget {
    limit: Option<u64>,
    day: Option<i32>,
    written: u64,
    exhausted: bool,
    dropped_lines: u64,
    dropped_bytes: u64,
}

impl DayBudget {
    /// 从零开始。生产入口一律走 [`DayBudget::resuming`]（当日文件的既有长度必须先
    /// 算进去），所以这个构造只服务测试与「同一天内换文件」的显式场景。
    #[cfg(test)]
    pub fn new(limit: Option<u64>, day: i32) -> Self {
        Self {
            limit,
            day: Some(day),
            written: 0,
            exhausted: false,
            dropped_lines: 0,
            dropped_bytes: 0,
        }
    }

    /// 从既有文件的 `already_written` 字节续算（生产入口）。
    ///
    /// 若续算值已越限，第一条就会被丢——这正是想要的：重复重启不得再发额度。
    pub fn resuming(limit: Option<u64>, day: i32, already_written: u64) -> Self {
        Self {
            limit,
            day: Some(day),
            written: already_written,
            exhausted: false,
            dropped_lines: 0,
            dropped_bytes: 0,
        }
    }

    /// 本日已写字节（测试读数；生产侧用 [`Notice::Exhausted`] 里的快照）。
    #[cfg(test)]
    pub fn written(&self) -> u64 {
        self.written
    }

    /// 本日已丢弃字节（测试读数；生产侧用 [`Notice::Reopened`] 里的汇总）。
    #[cfg(test)]
    pub fn dropped_bytes(&self) -> u64 {
        self.dropped_bytes
    }

    /// 记入一行：返回处置与（最多两条）通报。
    ///
    /// 越过上限的判定用 `written + len > limit`（而不是先写后判），这样单条超长
    /// 行也跳不过闸门。越限**锁死当日**（`exhausted`），不会放进"还塞得下的部分"。
    pub fn admit(&mut self, day: i32, len: usize) -> (Verdict, Vec<Notice>) {
        let mut notices = Vec::new();
        if self.day != Some(day) {
            if self.dropped_lines > 0 {
                notices.push(Notice::Reopened {
                    previous_day: self.day.unwrap_or(day),
                    dropped_lines: self.dropped_lines,
                    dropped_bytes: self.dropped_bytes,
                });
            }
            self.day = Some(day);
            self.written = 0;
            self.exhausted = false;
            self.dropped_lines = 0;
            self.dropped_bytes = 0;
        }
        let over = match self.limit {
            Some(limit) => self.exhausted || self.written.saturating_add(len as u64) > limit,
            None => false,
        };
        if over {
            let first = !self.exhausted;
            self.exhausted = true;
            self.dropped_lines += 1;
            self.dropped_bytes = self.dropped_bytes.saturating_add(len as u64);
            if first {
                notices.push(Notice::Exhausted {
                    limit: self.limit.unwrap_or(0),
                    written: self.written,
                });
            }
            return (Verdict::Drop, notices);
        }
        self.written = self.written.saturating_add(len as u64);
        (Verdict::Write, notices)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_point_reads_todays_file_length() {
        let dir = std::env::temp_dir().join(format!("pylon-budget-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let day = 20_000;
        let path = dir.join(daily_file_name("pylon", "log", day));
        std::fs::write(&path, vec![b'x'; 4096]).expect("write");
        assert_eq!(resume_point(&dir, "pylon", "log", day), 4096);
        // 别的日子没有文件 → 0（不是 panic，也不用猜格式）
        assert_eq!(resume_point(&dir, "pylon", "log", day + 1), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn budget_below_the_limit_writes_and_counts() {
        let mut budget = DayBudget::new(Some(100), 7);
        assert_eq!(budget.admit(7, 40), (Verdict::Write, vec![]));
        assert_eq!(budget.admit(7, 60), (Verdict::Write, vec![]));
        assert_eq!(budget.written(), 100);
    }

    #[test]
    fn a_single_oversized_line_cannot_jump_the_limit() {
        let mut budget = DayBudget::new(Some(100), 7);
        let (verdict, notices) = budget.admit(7, 101);
        assert_eq!(verdict, Verdict::Drop);
        assert_eq!(
            notices,
            vec![Notice::Exhausted {
                limit: 100,
                written: 0
            }]
        );
    }

    #[test]
    fn exceeding_the_limit_drops_and_latches_with_one_notice() {
        let mut budget = DayBudget::new(Some(10), 7);
        assert_eq!(budget.admit(7, 10), (Verdict::Write, vec![]));
        let (verdict, notices) = budget.admit(7, 1);
        assert_eq!(verdict, Verdict::Drop);
        assert_eq!(
            notices,
            vec![Notice::Exhausted {
                limit: 10,
                written: 10
            }]
        );
        // 锁死当日：后续行不再产出通报，只累计丢弃量
        assert_eq!(budget.admit(7, 1), (Verdict::Drop, vec![]));
        assert_eq!(budget.dropped_bytes(), 2);
    }

    #[test]
    fn resumed_counter_does_not_reissue_a_fresh_quota() {
        // 当日文件已经有 900 字节，上限 1000 → 只剩 100 字节额度。
        let mut budget = DayBudget::resuming(Some(1000), 7, 900);
        assert_eq!(budget.admit(7, 100), (Verdict::Write, vec![]));
        assert_eq!(budget.admit(7, 1).0, Verdict::Drop);
    }

    #[test]
    fn resumed_counter_already_over_the_limit_drops_from_the_first_line() {
        let mut budget = DayBudget::resuming(Some(100), 7, 100_000);
        assert_eq!(budget.admit(7, 1).0, Verdict::Drop);
    }

    #[test]
    fn day_rollover_resets_and_reports_the_closed_day_losses() {
        let mut budget = DayBudget::new(Some(10), 7);
        assert_eq!(budget.admit(7, 10), (Verdict::Write, vec![]));
        assert_eq!(budget.admit(7, 5).0, Verdict::Drop);
        let (verdict, notices) = budget.admit(8, 3);
        assert_eq!(verdict, Verdict::Write);
        assert_eq!(
            notices,
            vec![Notice::Reopened {
                previous_day: 7,
                dropped_lines: 1,
                dropped_bytes: 5
            }]
        );
        assert_eq!(budget.dropped_bytes(), 0);
    }

    #[test]
    fn day_rollover_without_losses_reports_nothing() {
        let mut budget = DayBudget::new(Some(10), 7);
        budget.admit(7, 1);
        assert_eq!(budget.admit(8, 1), (Verdict::Write, vec![]));
    }

    #[test]
    fn unlimited_budget_never_drops() {
        let mut budget = DayBudget::new(None, 7);
        let huge = 8 * 1024 * 1024;
        for _ in 0..4 {
            assert_eq!(budget.admit(7, huge), (Verdict::Write, vec![]));
        }
        assert_eq!(budget.dropped_bytes(), 0);
    }

    #[test]
    fn daily_file_name_is_stable_and_date_shaped() {
        // day 0 = 1970-01-01
        assert_eq!(daily_file_name("pylon", "log", 0), "pylon.1970-01-01.log");
        assert_eq!(
            daily_file_name("pylon", "log", 20_000),
            "pylon.2024-10-04.log"
        );
    }
}
