//! B4：统一诊断 cause——封闭 code 词表 × 共用 DTO。
//!
//! 三个失败域此前各有自己的错误形状：preflight 走
//! `pylon_core` 的 cause（level/code/summary，CLI `--diagnose` 与设置页共用）、
//! initialize/session 走 `AgentConnectFailure`（code/message/action）、运行时
//! 退出走 `CrashReason`（as_str）。本模块把后两者映射到与前一个同形的
//! [`DiagnosticCause`] DTO——level/code/summary（+可选 action）——使「同一类
//! 失败」在设置页、连接测试响应与日志里是同一个 code，而不是三套拼法。
//!
//! 词表封闭性由测试锁定：`connect_failure_cause` 与 `crash_reason_cause` 的
//! code 输出集合必须与这里登记的常量集合完全一致（新增 code 必须同步登记）。

use crate::acp::error::AgentConnectFailure;
use crate::acp::CrashReason;

/// 与 preflight cause 同形的统一诊断 DTO（additive：action 可选）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticCause {
    /// `ok | info | warn | fail`（与 `agent_diagnostics` 词表一致）。
    pub level: &'static str,
    /// 封闭 cause code（本模块映射出的失败恒为 `fail` 级）。
    pub code: String,
    /// 用户可读的行动向摘要。
    pub summary: String,
    /// 可行动动作（与连接测试 payload 的 action 词表一致）。
    pub action: Option<&'static str>,
}

fn action_for(failure: &AgentConnectFailure) -> &'static str {
    if failure.code == "agent_executable_missing" {
        "select_executable"
    } else {
        "open-runtime-log"
    }
}

/// initialize/session 握手失败 → 统一 cause（code 词表 =
/// `AgentConnectFailure::code` 的既有封闭集，本函数不发明新 code）。
pub(crate) fn connect_failure_cause(failure: &AgentConnectFailure) -> DiagnosticCause {
    DiagnosticCause {
        level: "fail",
        code: failure.code.clone(),
        summary: failure.message.clone(),
        action: Some(action_for(failure)),
    }
}

/// 运行时退出 → 统一 cause。code 词表 = `CrashReason::as_str` 的四个值。
pub(crate) fn crash_reason_cause(reason: CrashReason) -> DiagnosticCause {
    let summary = match reason {
        CrashReason::WriterFailed => "Agent 进程 stdin 写入失败，连接已按崩溃收敛",
        CrashReason::WriterTimeout => "Agent 进程长时间不读 stdin（写超时），连接已按崩溃收敛",
        CrashReason::StdoutClosed => "Agent 进程已退出（stdout 关闭）",
        CrashReason::PendingLockPoisoned => "内部 pending 状态锁中毒，连接已按崩溃收敛",
    };
    DiagnosticCause {
        level: "fail",
        code: reason.as_str().to_string(),
        summary: summary.to_string(),
        action: Some("open-runtime-log"),
    }
}

/// 反向映射（崩溃 code → 枚举）：dispatcher 收到的 reason 是 `as_str` 字符串，
/// 日志侧据此取回统一 cause。未知 code → None（fail-closed：不猜）。
pub(crate) fn crash_reason_from_code(code: &str) -> Option<CrashReason> {
    match code {
        "writer_failed" => Some(CrashReason::WriterFailed),
        "writer_timeout" => Some(CrashReason::WriterTimeout),
        "stdout_closed" => Some(CrashReason::StdoutClosed),
        "pending_lock_poisoned" => Some(CrashReason::PendingLockPoisoned),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 连接失败 cause 的 code 词表必须仍是 AgentConnectFailure 的封闭集，
    /// action 只有两个值（select_executable / open-runtime-log）。
    #[test]
    fn connect_cause_uses_the_existing_closed_code_vocabulary() {
        let failure = AgentConnectFailure {
            stage: crate::acp::AgentConnectStage::Spawn,
            code: "agent_executable_missing".into(),
            message: "exe 不存在".into(),
            exit_code: None,
            stderr_excerpt: None,
            retryable: false,
            io_kind: None,
            remote_code: None,
            remote_data_summary: None,
        };
        let cause = connect_failure_cause(&failure);
        assert_eq!(cause.level, "fail");
        assert_eq!(cause.code, "agent_executable_missing");
        assert_eq!(cause.action, Some("select_executable"));

        let other = AgentConnectFailure {
            code: "agent_spawn_failed".into(),
            ..failure
        };
        assert_eq!(
            connect_failure_cause(&other).action,
            Some("open-runtime-log")
        );
    }

    /// 崩溃 cause 的 code 词表 = CrashReason 的四个值，且全部 fail 级。
    #[test]
    fn crash_cause_uses_the_crash_reason_vocabulary() {
        let codes: Vec<String> = [
            CrashReason::WriterFailed,
            CrashReason::WriterTimeout,
            CrashReason::StdoutClosed,
            CrashReason::PendingLockPoisoned,
        ]
        .iter()
        .map(|reason| crash_reason_cause(*reason).code)
        .collect();
        assert_eq!(
            codes,
            vec![
                "writer_failed",
                "writer_timeout",
                "stdout_closed",
                "pending_lock_poisoned",
            ],
            "崩溃 cause code 必须与 CrashReason::as_str 一一对应"
        );
        for reason in [
            CrashReason::WriterFailed,
            CrashReason::WriterTimeout,
            CrashReason::StdoutClosed,
            CrashReason::PendingLockPoisoned,
        ] {
            let cause = crash_reason_cause(reason);
            assert_eq!(cause.level, "fail");
            assert_eq!(cause.action, Some("open-runtime-log"));
            assert!(!cause.summary.is_empty());
        }
    }
}
