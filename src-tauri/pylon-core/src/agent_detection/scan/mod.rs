//! 扫描管线编排（#486 项6 自 388 行单函数拆分为段模块；行为不变——段间数据流、
//! 语句次序与诊断产出顺序逐行保留）。
//!
//! 段位（原 `detect_agent_runtime_candidates_inner` 七段一线）：
//! selection（规则筛选与未知 detector 诊断）→ discover（spawn_blocking 根扫描 +
//! 排序截断）→ version_probe（并发版本探测）→ rank（候选组装 + 身份合并 + 排序
//! 截断）→ tools（node/uv/path_gap 工具证据 + 版本下限 gate）。本文件只保留
//! 编排与两条早退路径（catalog 加载失败 / 扫描预算耗尽）。
use super::probe_cache::ConfiguredRuntimes;
use super::types::{AgentDetectionOptions, AgentDetectionReport};
use std::time::Instant;

mod discover;
mod rank;
mod selection;
mod tools;
mod version_probe;

pub async fn detect_agent_runtime_candidates_inner(
    options: AgentDetectionOptions,
    configured: &ConfiguredRuntimes,
) -> Result<AgentDetectionReport, String> {
    let started = Instant::now();
    let limits = options.limits.clone();
    let deadline = started + limits.total_budget;
    let rules = crate::agent_catalog::detection_profiles()
        .map_err(|error| format!("Agent Catalog: {error}"))?;
    let mut diagnostics = Vec::new();
    let selected_rules =
        selection::select_rules(&rules, options.detector_ids.as_ref(), &mut diagnostics);
    let search_roots = options.search_roots.clone();
    // The runtime-tool probe runs after the scan, so it needs its own handle on
    // the roots (the scan closure takes ownership of the original).
    let tool_roots = search_roots.clone();
    let home_dir = options.home_dir.clone();
    let scan_budget = deadline.saturating_duration_since(Instant::now());
    let (mut discovered, mut providers) =
        match discover::scan_roots(selected_rules, search_roots, home_dir, scan_budget).await {
            discover::ScanOutcome::Completed(discovered, providers) => (discovered, providers),
            discover::ScanOutcome::TaskFailed(error) => {
                return Err(format!("Agent detection scan task failed: {error}"))
            }
            discover::ScanOutcome::BudgetExhausted => {
                diagnostics.push(crate::agent_detection::scan_diagnostic(
                    "scan",
                    None,
                    "detection_budget_exhausted",
                    "Agent discovery 扫描超过总预算".into(),
                    true,
                ));
                return Ok(AgentDetectionReport {
                    candidates: Vec::new(),
                    providers: Vec::new(),
                    diagnostics,
                    elapsed_ms: elapsed_ms(started),
                    truncated: true,
                });
            }
        };
    let discovered_truncated =
        discover::sort_and_truncate(&mut discovered, limits.max_candidates, &mut diagnostics);
    let probed = version_probe::probe_versions(discovered, &limits, deadline).await;
    let ranked_candidates = rank::assemble_candidates(probed, configured, &mut diagnostics);
    let (candidates, candidates_truncated) = rank::merge_rank_and_truncate(
        ranked_candidates,
        &limits,
        discovered_truncated,
        &mut diagnostics,
    );
    tools::attach_tool_evidence(
        &rules,
        &mut providers,
        &candidates,
        &limits,
        deadline,
        tool_roots,
        &mut diagnostics,
    )
    .await;
    Ok(AgentDetectionReport {
        candidates,
        providers,
        diagnostics,
        elapsed_ms: elapsed_ms(started),
        truncated: discovered_truncated || candidates_truncated,
    })
}

/// 原函数内出现两处的同一表达式单点化（`elapsed` 的 u128→u64 饱和收窄）。
fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

/// Shared library entry used by the standalone detector. GUI-specific
/// imported-agent matching stays in the Tauri adapter below.
pub async fn detect_agent_runtime_candidates(
    options: AgentDetectionOptions,
) -> Result<AgentDetectionReport, String> {
    detect_agent_runtime_candidates_inner(
        options,
        &crate::agent_detection::ConfiguredRuntimes::new(),
    )
    .await
}
