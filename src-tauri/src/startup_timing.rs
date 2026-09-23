//! 启动相位打点与时间线合并（#269）。
//!
//! 观测性旁路：`mark` 把进程相位追加进进程级相位表并 `tracing::info!` 一条
//! `startup_phase`（hub 注册前的 event 被 RuntimeLogLayer 丢弃，属预期——权威
//! 出口是 ready 时 `report_startup_timing` 合并出的那条 source="startup" 日志）。
//! t0 = `origin()` 首次调用点（main 入口首行经 lib::startup_mark 落在最早处）。
//! 任何路径都不参与控制流：锁中毒等异常一律静默降级，绝不阻断启动。

use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 进程侧单个启动相位。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupPhase {
    pub phase: String,
    /// 自进程 t0 的毫秒数。
    pub elapsed_ms: u64,
    /// 相位时刻的 Unix epoch 毫秒（与前端 epochMs 同钟，便于跨端对齐）。
    pub epoch_ms: u64,
}

/// 前端上报的单个相位（wire 契约：camelCase）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendPhase {
    pub phase: String,
    pub elapsed_ms: u64,
    pub epoch_ms: u64,
}

fn origin() -> &'static (Instant, SystemTime) {
    static ORIGIN: OnceLock<(Instant, SystemTime)> = OnceLock::new();
    ORIGIN.get_or_init(|| (Instant::now(), SystemTime::now()))
}

fn ledger() -> &'static Mutex<Vec<StartupPhase>> {
    static LEDGER: OnceLock<Mutex<Vec<StartupPhase>>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(Vec::new()))
}

fn epoch_millis(instant: SystemTime) -> u64 {
    instant
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 当前 Unix epoch 毫秒（report 接收时刻等）。
pub fn epoch_millis_now() -> u64 {
    epoch_millis(SystemTime::now())
}

/// 记录一个启动相位：追加进程相位表 + tracing 打点。
pub fn mark(phase: &str) {
    let (instant, _) = origin();
    let record = StartupPhase {
        phase: phase.to_string(),
        elapsed_ms: instant.elapsed().as_millis() as u64,
        epoch_ms: epoch_millis_now(),
    };
    if let Ok(mut ledger) = ledger().lock() {
        ledger.push(record.clone());
    }
    tracing::info!(
        phase = record.phase.as_str(),
        elapsed_ms = record.elapsed_ms,
        "startup_phase"
    );
}

/// 进程相位表快照（合并输出用）。
pub fn process_phases() -> Vec<StartupPhase> {
    ledger()
        .lock()
        .map(|ledger| ledger.clone())
        .unwrap_or_default()
}

/// 合并时间线 fields（纯函数）：进程相位 + 前端相位 + 接收时刻。
pub fn build_timeline_fields(
    process: Vec<StartupPhase>,
    frontend: &[FrontendPhase],
    received_epoch_ms: u64,
) -> serde_json::Map<String, serde_json::Value> {
    serde_json::json!({
        "process": process,
        "frontend": frontend,
        "receivedEpochMs": received_epoch_ms,
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_phase_wire_is_camel_case() {
        let phase = FrontendPhase {
            phase: "ready".to_string(),
            elapsed_ms: 12,
            epoch_ms: 345,
        };
        let value = serde_json::to_value(&phase).unwrap();
        assert_eq!(value["phase"], "ready");
        assert_eq!(value["elapsedMs"], 12);
        assert_eq!(value["epochMs"], 345);
    }

    #[test]
    fn timeline_fields_merge_process_frontend_and_receipt() {
        let process = vec![StartupPhase {
            phase: "run_entry".to_string(),
            elapsed_ms: 1,
            epoch_ms: 100,
        }];
        let frontend = vec![FrontendPhase {
            phase: "ready".to_string(),
            elapsed_ms: 2,
            epoch_ms: 101,
        }];
        let fields = build_timeline_fields(process, &frontend, 999);
        let value = serde_json::to_value(&fields).unwrap();
        assert_eq!(value["process"][0]["phase"], "run_entry");
        assert_eq!(value["process"][0]["elapsedMs"], 1);
        assert_eq!(value["frontend"][0]["phase"], "ready");
        assert_eq!(value["frontend"][0]["epochMs"], 101);
        assert_eq!(value["receivedEpochMs"], 999);
    }

    #[test]
    fn timeline_fields_survives_empty_sides() {
        let fields = build_timeline_fields(Vec::new(), &[], 7);
        let value = serde_json::to_value(&fields).unwrap();
        assert!(value["process"].as_array().unwrap().is_empty());
        assert!(value["frontend"].as_array().unwrap().is_empty());
        assert_eq!(value["receivedEpochMs"], 7);
    }

    #[test]
    fn mark_appends_phases_in_call_order() {
        // 全局相位表无复位缝（进程级单例）：用纳秒级唯一名断言「同线程先后两次
        // mark 在表中保持相对次序」，不依赖表的初始状态，天然并行安全。
        let nonce = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let first = format!("t{nonce}_a");
        let second = format!("t{nonce}_b");
        mark(&first);
        mark(&second);
        let phases = process_phases();
        let index_of = |name: &str| {
            phases
                .iter()
                .position(|phase| phase.phase == name)
                .unwrap_or_else(|| panic!("phase {name} must be recorded"))
        };
        assert!(index_of(&first) < index_of(&second));
    }
}
