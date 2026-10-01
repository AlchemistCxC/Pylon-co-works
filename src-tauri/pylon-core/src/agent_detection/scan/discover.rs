//! 段2+3：spawn_blocking 根扫描（总预算内）与发现结果的稳定排序、上限截断
//! （#486 项6 自 scan 长函数拆出，行为不变）。
use crate::agent_catalog::AgentDetectionProfile;

use super::super::evidence::{config_evidence, find_rule, provider_evidence};
use super::super::locate::{path_key, LocatedRuntime};
use super::super::probe::scan_diagnostic;
use super::super::types::{
    AgentDetectionDiagnostic, AgentDetectionEvidence, AgentProviderEvidence,
};
use std::path::PathBuf;
use std::time::Duration;

/// 单条发现：命中规则 + 定位结果 + 配置证据（原长函数闭包产出的三元组）。
pub(crate) type Discovered = (
    AgentDetectionProfile,
    LocatedRuntime,
    Vec<AgentDetectionEvidence>,
);

/// 根扫描的终态：完成 / 扫描任务失败（JoinError）/ 总预算耗尽。
pub(crate) enum ScanOutcome {
    Completed(Vec<Discovered>, Vec<AgentProviderEvidence>),
    TaskFailed(String),
    BudgetExhausted,
}

/// spawn_blocking 内做只读根扫描（规则定位 + 配置证据 + provider 双侧证据），
/// 外层 `tokio::time::timeout` 以剩余总预算封顶。语句次序与原长函数 :68-90 一致。
pub(crate) async fn scan_roots(
    selected_rules: Vec<AgentDetectionProfile>,
    search_roots: Option<Vec<PathBuf>>,
    home_dir: Option<PathBuf>,
    scan_budget: Duration,
) -> ScanOutcome {
    let scanned = tokio::time::timeout(
        scan_budget,
        tokio::task::spawn_blocking(move || {
            let mut discovered = Vec::new();
            let mut providers = Vec::new();
            for rule in selected_rules {
                let located = find_rule(&rule, search_roots.as_deref());
                let config = config_evidence(&rule, home_dir.as_deref());
                providers.push(provider_evidence(
                    &rule,
                    search_roots.as_deref(),
                    home_dir.as_deref(),
                ));
                discovered.extend(
                    located
                        .into_iter()
                        .map(|located| (rule.clone(), located, config.clone())),
                );
            }
            (discovered, providers)
        }),
    )
    .await;
    match scanned {
        Ok(Ok((discovered, providers))) => ScanOutcome::Completed(discovered, providers),
        Ok(Err(error)) => ScanOutcome::TaskFailed(error.to_string()),
        Err(_) => ScanOutcome::BudgetExhausted,
    }
}

/// 稳定优先级排序 + `max_candidates` 截断（version probe 之前的那次）。返回
/// 是否发生截断（后续「已按稳定优先级截断」诊断要据此让位，见 rank 段）。
/// 语句次序与原长函数 :111-143 一致。
pub(crate) fn sort_and_truncate(
    discovered: &mut Vec<Discovered>,
    max_candidates: usize,
    diagnostics: &mut Vec<AgentDetectionDiagnostic>,
) -> bool {
    discovered.sort_by(|left, right| {
        let left_config = left
            .2
            .iter()
            .any(|evidence| evidence.kind == "config-fields");
        let right_config = right
            .2
            .iter()
            .any(|evidence| evidence.kind == "config-fields");
        right
            .0
            .priority
            .cmp(&left.0.priority)
            .then(right_config.cmp(&left_config))
            .then(left.1.alias_index.cmp(&right.1.alias_index))
            .then((left.1.source != "path").cmp(&(right.1.source != "path")))
            .then(path_key(&left.1.executable).cmp(&path_key(&right.1.executable)))
            .then(left.1.args.cmp(&right.1.args))
    });
    let truncated = discovered.len() > max_candidates;
    if truncated {
        diagnostics.push(scan_diagnostic(
            "selection",
            None,
            "candidate_limit_reached",
            format!(
                "Agent 候选超过上限 {}，已在 version probe 前按稳定优先级截断",
                max_candidates
            ),
            false,
        ));
        discovered.truncate(max_candidates);
    }
    truncated
}
