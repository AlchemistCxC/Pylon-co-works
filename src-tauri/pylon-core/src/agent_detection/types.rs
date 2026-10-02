//! 检测域值类型：证据 / 诊断 / 报告 / 候选 / 预算与选项（D-split 自 agent_detection.rs，机械搬移）。
use crate::agent_preflight::ToolVersion;
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetectionEvidence {
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetectionDiagnostic {
    pub code: String,
    pub stage: String,
    pub detector_id: Option<String>,
    /// 结构化归因：诊断属于哪个候选（对齐 `AgentRuntimeCandidate.candidate_id`）。
    ///
    /// **真正发起了探测**的诊断有值——前端据此把失败原因挂到对应 Agent 卡，而不必再从
    /// `message` 里正则抠路径。选择类诊断（未知 detector、候选截断）没有候选上下文，为 None。
    pub candidate_id: Option<String>,
    /// 结构化归因：被探测的可执行文件绝对路径。
    ///
    /// 同样以「真正发起了探测」为准：预算耗尽这类陈述即便发生在某个候选的探测包装里也不带
    /// 路径——那是对全局预算的陈述，不是关于这个可执行文件的事实。
    pub executable: Option<String>,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetectionReport {
    pub candidates: Vec<AgentRuntimeCandidate>,
    /// Dual ACP/vendor-CLI evidence per selected provider. Present even when a
    /// provider has no ACP candidate, which is what makes `adapterMissing`
    /// observable instead of indistinguishable from "provider absent".
    pub providers: Vec<AgentProviderEvidence>,
    pub diagnostics: Vec<AgentDetectionDiagnostic>,
    pub elapsed_ms: u64,
    pub truncated: bool,
}

/// 候选身份可信度（#425 件5：`Exact`/`Low` 无产生点已裁除——探测面
/// 只产出 High/Medium 两档，词表与实际产出对齐）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IdentityConfidence {
    High,
    Medium,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolAvailability {
    NotTested,
    Verified,
    Failed,
}

/// Evidence that the discovered executable can be started independently of
/// whether it completed an ACP handshake.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Startability {
    NotTested,
    Verified,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeAlternative {
    pub candidate_id: String,
    pub executable: String,
    pub args: Vec<String>,
    pub startability: Startability,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCandidate {
    pub candidate_id: String,
    pub detector_id: String,
    pub provider: String,
    pub suggested_agent_id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
    /// Other discovered launch forms for the same provider; no configuration is written.
    pub alternatives: Vec<AgentRuntimeAlternative>,
    pub evidence: Vec<AgentDetectionEvidence>,
    pub identity_confidence: IdentityConfidence,
    pub startability: Startability,
    pub protocol_availability: ProtocolAvailability,
    pub already_imported_agent_id: Option<String>,
    pub warnings: Vec<String>,
}

/// Standalone detection inputs. Supplying search roots disables platform root
/// expansion and registry lookup, which keeps CLI fixtures deterministic.
#[derive(Debug, Clone)]
pub struct AgentDetectionLimits {
    pub total_budget: Duration,
    pub version_probe_budget: Duration,
    pub max_candidates: usize,
    pub max_concurrent_probes: usize,
}

impl Default for AgentDetectionLimits {
    fn default() -> Self {
        Self {
            total_budget: Duration::from_secs(8),
            version_probe_budget: Duration::from_secs(2),
            max_candidates: 32,
            max_concurrent_probes: 4,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct AgentDetectionOptions {
    pub detector_ids: Option<Vec<String>>,
    pub home_dir: Option<PathBuf>,
    pub search_roots: Option<Vec<PathBuf>>,
    pub limits: AgentDetectionLimits,
}
/// One located executable on the ACP or the vendor-CLI side of a provider.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvidenceHit {
    pub kind: String,
    pub path: String,
    pub source: String,
}

/// Per-provider dual evidence, emitted for every selected provider whether or
/// not an ACP candidate exists.
///
/// This is what makes `adapterMissing` observable: a wrapper provider whose ACP
/// command is absent still has a probe result here, so preflight can tell the
/// user whether the vendor CLI they already installed was actually found.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderEvidence {
    pub provider: String,
    pub detector_id: String,
    /// True when the catalog declares an adapter relation for this provider.
    pub adapter_relation_declared: bool,
    pub acp_commands: Vec<AgentEvidenceHit>,
    pub native_commands: Vec<AgentEvidenceHit>,
    /// Presence only — never the path and never a file's contents. The shared
    /// config/credential dir may contain secrets, so the detector reports that
    /// it was seen, not where or what was in it.
    pub shared_config_present: bool,
    /// Node.js state on this machine. Probed once per scan and attached to every
    /// provider, because the tool is a machine fact and not a per-provider one;
    /// only providers whose catalog `requires` names Node read it.
    pub node: ToolVersion,
    /// uv state on this machine; see `node`.
    pub uv: ToolVersion,
    /// The provider's own installed version when a local source could supply it
    /// (npm global metadata, which the executable probe cannot provide). The
    /// direct executable probe wins when it produced a version.
    pub adapter_version: Option<String>,
    /// What a newly started process would see on PATH but this process does not.
    /// A machine fact (read once per scan), not a per-provider one — but attached
    /// per provider so a diagnosis can explain a located executable that the app
    /// cannot otherwise reach.
    pub path_gap: crate::agent_diagnostics::PathGapReport,
}
