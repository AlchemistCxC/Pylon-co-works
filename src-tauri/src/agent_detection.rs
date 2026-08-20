//! GUI-side agent runtime detection adapter.
//!
//! Pure discovery logic lives in `pylon-core::agent_detection` (standalone
//! binaries link only pylon-core). This module keeps the Tauri command that
//! matches detected candidates against the running `agents.yaml` state, and
//! re-exports the shared types so existing callers keep compiling.

use std::collections::HashMap;

use crate::{error::PylonError, AppState};
use pylon_core::agent_detection as detection_core;

pub use pylon_core::agent_detection::*;

type ConfiguredRuntimes = HashMap<String, (String, String, Vec<String>)>;

#[tauri::command]
pub(crate) async fn detect_agent_runtimes(
    state: tauri::State<'_, AppState>,
    detector_ids: Option<Vec<String>>,
) -> Result<AgentDetectionReport, PylonError> {
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
    detection_core::detect_agent_runtime_candidates_inner(
        detection_core::AgentDetectionOptions {
            detector_ids,
            ..detection_core::AgentDetectionOptions::default()
        },
        &configured,
    )
    .await
    .map_err(PylonError::Protocol)
}
