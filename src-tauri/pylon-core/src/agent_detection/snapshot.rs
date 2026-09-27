//! DetectionSnapshot（不可变证据快照）/ DetectionOutcome TTL 三态 / 组装与搜索指纹。
use super::locate::{controlled_roots, path_key};
use super::types::AgentDetectionReport;
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;

// ── B0：DetectionSnapshot（不可变证据快照）与缓存策略 ──

/// Immutable detection evidence for one completed scan.
///
/// A snapshot merges everything the settings page needs to reason about a
/// provider — candidates, version probes, wrapper/native/shared-config
/// evidence, and the preflight verdicts derived from them — and stamps it with
/// the time it was taken plus the catalog revision it was recorded against.
/// Consumers treat it as read-only evidence; nothing may mutate a snapshot
/// after assembly, which is what makes caching by identity safe.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectionSnapshot {
    /// Unix epoch milliseconds at assembly time.
    pub taken_at_ms: u64,
    /// Content revision of the catalog the scan ran against (see
    /// [`crate::agent_catalog::catalog_revision`]).
    pub catalog_revision: String,
    /// Fingerprint of the search roots the scan used (see
    /// [`search_roots_fingerprint`]).
    pub search_fingerprint: String,
    #[serde(flatten)]
    pub report: AgentDetectionReport,
    /// One preflight verdict per selected provider, computed by the same
    /// `from_detection` mapping the `pylon-detect` CLI uses — a snapshot
    /// consumer never re-derives it, so panel and CLI cannot disagree.
    pub preflight: Vec<crate::agent_preflight::PreflightResult>,
}

/// How trustworthy a completed scan is, which decides how long its snapshot
/// may be served from cache.
///
/// Three states, not two: a scan that errored (`Failure`) and a scan that
/// completed but degraded — truncated, or carrying retryable diagnostics such
/// as a version-probe timeout (`Unknown`) — must both be re-attempted far
/// sooner than a clean scan, but they are different facts and are reported as
/// different facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectionOutcome {
    Success,
    Failure,
    Unknown,
}

impl DetectionOutcome {
    pub fn classify(result: &Result<AgentDetectionReport, String>) -> Self {
        match result {
            Err(_) => Self::Failure,
            Ok(report) => {
                if report.truncated || report.diagnostics.iter().any(|d| d.retryable) {
                    Self::Unknown
                } else {
                    Self::Success
                }
            }
        }
    }

    /// Failures are cached briefly (retry soon), clean results longer, degraded
    /// ones in between. Codeg caches only passing checks; this keeps that
    /// intent while adding the expiry Codeg never had.
    pub fn ttl(self) -> Duration {
        match self {
            Self::Success => Duration::from_secs(600),
            Self::Unknown => Duration::from_secs(60),
            Self::Failure => Duration::from_secs(15),
        }
    }
}

/// Fingerprint the roots a scan would search: the same controlled-root
/// derivation the scan itself uses (so a fingerprint hit implies the scan
/// really saw these roots), hashed in order — root order affects candidate
/// priority, so two orderings of the same roots are not the same search. The
/// NUL separator keeps adjacent roots from aliasing into one another.
pub fn search_roots_fingerprint(search_roots: Option<&[PathBuf]>) -> String {
    let mut input = String::new();
    for root in controlled_roots(search_roots) {
        input.push_str(&path_key(&root));
        input.push('\u{0}');
    }
    crate::fnv1a::fnv1a_64_prefixed(input.as_bytes())
}

/// Unix epoch milliseconds right now; the caller-visible timestamp half of a
/// snapshot. Kept separate from the monotonic clock the cache layer uses so
/// tests can pin either one independently.
pub fn unix_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// Assemble the immutable snapshot for one completed scan. The preflight
/// verdicts are computed here — by the shared `from_detection` mapping — so
/// every consumer of a snapshot sees the same conclusions. `search_roots` must
/// be the same value the scan was given, so the fingerprint describes the
/// search that actually ran.
pub fn assemble_detection_snapshot(
    report: AgentDetectionReport,
    taken_at_ms: u64,
    search_roots: Option<&[PathBuf]>,
) -> DetectionSnapshot {
    let preflight = report
        .providers
        .iter()
        .filter_map(|evidence| {
            crate::agent_preflight::from_detection(evidence, &report.candidates).ok()
        })
        .collect();
    DetectionSnapshot {
        taken_at_ms,
        catalog_revision: crate::agent_catalog::catalog_revision().to_string(),
        search_fingerprint: search_roots_fingerprint(search_roots),
        report,
        preflight,
    }
}
