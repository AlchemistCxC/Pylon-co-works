//! Agent 浏览器设置：档位、工作区覆盖、域名黑名单、广告过滤。
//!
//! 持久化为 `pylon-browser-agent.json`（config_root，原子写，先例
//! `workspaces.rs` + `agent_config::write_config_atomically`）。Rust 侧是
//! 唯一权威：策略引擎读这里，前端面板经命令读写，sessionCreation 注入也
//! 经命令解析有效档位。

use crate::agent_config::write_config_atomically;
use crate::browser::agent::policy::BrowserAccessMode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

pub(crate) const SETTINGS_SCHEMA_VERSION: u32 = 1;
/// 域名黑名单条目上限；超出部分在保存时截断。
pub(crate) const MAX_DOMAIN_BLOCKLIST: usize = 256;
/// 单条域名长度上限（DNS 规范 253 字符 + 余量）。
pub(crate) const MAX_DOMAIN_LENGTH: usize = 255;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserAgentSettings {
    pub(crate) schema_version: u32,
    /// 全局默认档位；裁决为 `readonly`（观察类默认可用）。
    pub(crate) default_mode: BrowserAccessMode,
    /// 工作区级覆盖（workspaceId → 档位），未命中回落 `default_mode`。
    #[serde(default)]
    pub(crate) workspace_modes: HashMap<String, BrowserAccessMode>,
    /// Agent 导航域名黑名单（后缀匹配，见 policy::is_domain_blocked）。
    #[serde(default)]
    pub(crate) domain_blocklist: Vec<String>,
    /// CDP Fetch 请求拦截：基础广告/追踪过滤（同时作用于用户与 Agent 导航）。
    #[serde(default = "default_ad_filter_enabled")]
    pub(crate) ad_filter_enabled: bool,
}

fn default_ad_filter_enabled() -> bool {
    true
}

impl Default for BrowserAgentSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            default_mode: BrowserAccessMode::ReadOnly,
            workspace_modes: HashMap::new(),
            domain_blocklist: Vec::new(),
            ad_filter_enabled: default_ad_filter_enabled(),
        }
    }
}

impl BrowserAgentSettings {
    /// 载入设置：文件缺失、损坏或 schema 不识别时静默回落默认值（先例
    /// `load_mcp_persisted` 的降级语义），不让浏览器面板打不开。
    pub(crate) fn load(path: &Path) -> Self {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(_) => return Self::default(),
        };
        match serde_json::from_str::<Self>(&raw) {
            Ok(settings) if settings.schema_version == SETTINGS_SCHEMA_VERSION => settings,
            _ => Self::default(),
        }
    }

    pub(crate) fn save(&self, path: &Path) -> Result<(), String> {
        let mut normalized = self.clone();
        normalized.schema_version = SETTINGS_SCHEMA_VERSION;
        normalized.domain_blocklist = normalized
            .domain_blocklist
            .iter()
            .map(|entry| entry.trim().to_ascii_lowercase())
            .filter(|entry| !entry.is_empty() && entry.len() <= MAX_DOMAIN_LENGTH)
            .take(MAX_DOMAIN_BLOCKLIST)
            .collect();
        let content = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
        write_config_atomically(path, &content).map_err(|e| e.to_string())
    }

    /// 有效档位：工作区覆盖优先，未命中回落全局默认。
    pub(crate) fn resolve_access(&self, workspace_id: Option<&str>) -> BrowserAccessMode {
        if let Some(workspace_id) = workspace_id {
            if let Some(mode) = self.workspace_modes.get(workspace_id) {
                return *mode;
            }
        }
        self.default_mode
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pylon-agent-settings-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn defaults_follow_adjudication() {
        let settings = BrowserAgentSettings::default();
        assert_eq!(settings.default_mode, BrowserAccessMode::ReadOnly);
        assert!(settings.ad_filter_enabled);
        assert!(settings.workspace_modes.is_empty());
        assert!(settings.domain_blocklist.is_empty());
    }

    #[test]
    fn load_missing_or_corrupt_file_falls_back_to_default() {
        let dir = temp_dir("missing");
        let path = dir.join("pylon-browser-agent.json");
        assert_eq!(
            BrowserAgentSettings::load(&path),
            BrowserAgentSettings::default()
        );
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(
            BrowserAgentSettings::load(&path),
            BrowserAgentSettings::default()
        );
        std::fs::write(&path, r#"{"schemaVersion":99,"defaultMode":"full"}"#).unwrap();
        assert_eq!(
            BrowserAgentSettings::load(&path),
            BrowserAgentSettings::default()
        );
    }

    #[test]
    fn save_load_roundtrip_preserves_overrides() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("pylon-browser-agent.json");
        let mut settings = BrowserAgentSettings {
            default_mode: BrowserAccessMode::Full,
            ..Default::default()
        };
        settings
            .workspace_modes
            .insert("ws-1".into(), BrowserAccessMode::Off);
        settings.domain_blocklist = vec!["Bank.CN".into(), "  ".into()];
        settings.save(&path).unwrap();
        let loaded = BrowserAgentSettings::load(&path);
        assert_eq!(loaded.default_mode, BrowserAccessMode::Full);
        assert_eq!(
            loaded.workspace_modes.get("ws-1"),
            Some(&BrowserAccessMode::Off)
        );
        // 归一化：小写、去空白项。
        assert_eq!(loaded.domain_blocklist, vec!["bank.cn".to_string()]);
    }

    #[test]
    fn resolve_access_prefers_workspace_override() {
        let mut settings = BrowserAgentSettings::default();
        settings
            .workspace_modes
            .insert("ws-a".into(), BrowserAccessMode::Full);
        assert_eq!(
            settings.resolve_access(Some("ws-a")),
            BrowserAccessMode::Full
        );
        assert_eq!(
            settings.resolve_access(Some("ws-b")),
            BrowserAccessMode::ReadOnly
        );
        assert_eq!(settings.resolve_access(None), BrowserAccessMode::ReadOnly);
    }

    #[test]
    fn save_caps_blocklist_entries() {
        let dir = temp_dir("cap");
        let path = dir.join("pylon-browser-agent.json");
        let settings = BrowserAgentSettings {
            domain_blocklist: (0..400).map(|index| format!("d{index}.example")).collect(),
            ..Default::default()
        };
        settings.save(&path).unwrap();
        let loaded = BrowserAgentSettings::load(&path);
        assert_eq!(loaded.domain_blocklist.len(), MAX_DOMAIN_BLOCKLIST);
    }
}
