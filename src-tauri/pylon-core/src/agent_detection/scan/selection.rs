//! 段1：detector 筛选与未知 detector 诊断（#486 项6 自 scan 长函数拆出，行为不变）。
use crate::agent_catalog::AgentDetectionProfile;

use crate::agent_detection::{scan_diagnostic, AgentDetectionDiagnostic};
use std::collections::HashSet;

/// 校验请求的 detector_ids（未知 id 记 `unknown_detector_id` 诊断）并筛出本轮
/// 参与扫描的 catalog 规则；未请求时全量入选。语句次序与原长函数 :31-61 一致。
pub(crate) fn select_rules(
    rules: &[AgentDetectionProfile],
    requested: Option<&Vec<String>>,
    diagnostics: &mut Vec<AgentDetectionDiagnostic>,
) -> Vec<AgentDetectionProfile> {
    let available = rules
        .iter()
        .map(|rule| rule.detector_id.as_str())
        .collect::<HashSet<_>>();
    if let Some(requested) = requested {
        let mut seen = HashSet::new();
        for detector_id in requested.iter().filter(|id| seen.insert(id.as_str())) {
            if !available.contains(detector_id.as_str()) {
                diagnostics.push(scan_diagnostic(
                    "selection",
                    Some(detector_id.clone()),
                    "unknown_detector_id",
                    format!("未知 Agent detector: {detector_id}"),
                    false,
                ));
            }
        }
    }
    let enabled: Option<HashSet<String>> = requested.map(|ids| ids.iter().cloned().collect());
    rules
        .iter()
        .filter(|rule| {
            enabled
                .as_ref()
                .map(|ids| ids.contains(&rule.detector_id))
                .unwrap_or(true)
        })
        .cloned()
        .collect::<Vec<_>>()
}
