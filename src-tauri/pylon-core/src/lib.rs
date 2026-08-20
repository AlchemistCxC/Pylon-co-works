//! pylon-core — standalone Pylon library with no Tauri/GUI dependencies.
//!
//! Extracted so standalone binaries (`pylon-cli`, `pylon-detect`) link only the
//! lightweight logic they need instead of the entire Tauri application library.
//!
//! - `agent_catalog`: shared first-party agent catalog (JSON-driven detection rules)
//! - `agent_detection`: pure agent runtime discovery (no AppState, no tauri)
//! - `cli_client`: named-pipe/Unix-socket client for a running Pylon kernel

pub mod agent_catalog;
pub mod agent_detection;
pub mod cli_client;
