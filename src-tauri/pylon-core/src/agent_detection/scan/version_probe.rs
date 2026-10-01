//! 段4：并发版本探测——每条探测只拿剩余总预算，排队任务无法在 deadline 之后
//! 继续拉长发现面（#486 项6 自 scan 长函数拆出，行为不变）。
use super::super::locate::LocatedRuntime;
use super::super::probe::VersionProbeOutcome;
use super::super::probe_cache::version_probe;
use super::super::types::{AgentDetectionEvidence, AgentDetectionLimits};
use crate::agent_catalog::AgentDetectionProfile;
use futures_util::StreamExt;
use std::time::Instant;

/// 探测完成的一条记录：发现三元组 + 版本探测结果（原长函数 :158 的四元组）。
pub(crate) type Probed = (
    AgentDetectionProfile,
    LocatedRuntime,
    Vec<AgentDetectionEvidence>,
    VersionProbeOutcome,
);

/// Version commands are independent but bounded. Each probe receives only
/// the remaining total budget, so queued work cannot extend discovery
/// indefinitely after the deadline.
/// 语句次序与原长函数 :145-163 一致。
pub(crate) async fn probe_versions(
    discovered: Vec<super::discover::Discovered>,
    limits: &AgentDetectionLimits,
    deadline: Instant,
) -> Vec<Probed> {
    futures_util::stream::iter(discovered)
        .map(|(rule, located, config)| {
            let path = located.executable.clone();
            let detector_id = rule.detector_id.clone();
            let probe_budget = limits
                .version_probe_budget
                .min(deadline.saturating_duration_since(Instant::now()));
            async move {
                let probe =
                    version_probe(&detector_id, path, &rule.version_args, probe_budget).await;
                (rule, located, config, probe)
            }
        })
        .buffer_unordered(limits.max_concurrent_probes.max(1))
        .collect::<Vec<_>>()
        .await
}
