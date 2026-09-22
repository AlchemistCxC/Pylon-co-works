//! pylon-core — standalone Pylon library with no Tauri/GUI dependencies.
//!
//! Extracted so standalone binaries (`pylon-cli`, `pylon-detect`) link only the
//! lightweight logic they need instead of the entire Tauri application library.
//!
//! - `agent_catalog`: shared first-party agent catalog (JSON-driven detection rules)
//! - `agent_detection`: pure agent runtime discovery (no AppState, no tauri)
//! - `agent_launch_plan`: pure Windows launch planner (catalog + detection + overrides)
//! - `agent_profile_transform`: Codeg-shaped profile -> Pylon profile DTO
//! - `cli_client`: named-pipe/Unix-socket client for a running Pylon kernel

pub mod agent_catalog;
pub mod agent_config;
pub mod agent_detection;
pub mod agent_diagnostics;
pub mod agent_launch_plan;
pub mod agent_preflight;
pub mod agent_profile_transform;
pub mod cli_client;
pub mod correlation;
// #247：hermes profile 探测与 Windows 启动适配（消费 AgentDef，随 agent 域归位）。
pub mod hermes;
// #247：catalog 投影的 provider 适配边界（纯逻辑，原宿主 provider_adapter/）。
pub mod provider_adapter;
