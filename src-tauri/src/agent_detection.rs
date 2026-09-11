//! GUI-side agent runtime detection adapter.
//!
//! Pure discovery logic lives in `pylon-core::agent_detection` (standalone
//! binaries link only pylon-core). This module keeps the Tauri command that
//! matches detected candidates against the running `agents.yaml` state, and
//! re-exports the shared types so existing callers keep compiling.

use std::collections::HashMap;

use crate::{error::PylonError, AppState};
use pylon_core::agent_detection as detection_core;
use pylon_core::agent_preflight;

pub use pylon_core::agent_detection::*;

type ConfiguredRuntimes = HashMap<String, (String, String, Vec<String>)>;

/// A4：设置页消费的检测结果 = 候选 + 每 provider 的双证据 + 每 provider 的
/// preflight 结论。preflight 与 `pylon-detect` CLI 走同一份 `from_detection`
/// 映射，所以面板与 CLI 不会各自算出不同的结论。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeDetectionView {
    #[serde(flatten)]
    pub report: AgentDetectionReport,
    pub preflight: Vec<agent_preflight::PreflightResult>,
}

#[tauri::command]
pub(crate) async fn detect_agent_runtimes(
    state: tauri::State<'_, AppState>,
    detector_ids: Option<Vec<String>>,
) -> Result<AgentRuntimeDetectionView, PylonError> {
    let configured: ConfiguredRuntimes = state
        .agents
        .lock()
        .map_err(|error| PylonError::Protocol(error.to_string()))?
        .iter()
        .map(|(id, agent)| {
            (
                id.clone(),
                (
                    agent.provider.clone().unwrap_or_default().to_lowercase(),
                    detection_core::configured_executable_key(&agent.exe),
                    agent.args.clone(),
                ),
            )
        })
        .collect();
    let report = detection_core::detect_agent_runtime_candidates_inner(
        detection_core::AgentDetectionOptions {
            detector_ids,
            ..detection_core::AgentDetectionOptions::default()
        },
        &configured,
    )
    .await
    .map_err(PylonError::Protocol)?;
    let preflight = report
        .providers
        .iter()
        .filter_map(|evidence| agent_preflight::from_detection(evidence, &report.candidates).ok())
        .collect::<Vec<_>>();
    Ok(AgentRuntimeDetectionView { report, preflight })
}
