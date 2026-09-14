//! BrowserAgentHub：Agent 浏览器能力的运行时状态聚合（AppState 持有）。
//!
//! 职责：设置读写（Rust 侧唯一权威）、claim 状态机、ref 注册表、CDP 状态
//! （Windows）。页面操作本身仍走 [`crate::browser::BrowserManager`]；本结构
//! 只做决策与簿记，命令层（browser_agent_cmds）按 hub 决策调度。

#[cfg(windows)]
use crate::browser_agent::cdp::CdpState;
use crate::browser_agent::claim::ClaimManager;
use crate::browser_agent::policy::BrowserAccessMode;
use crate::browser_agent::refs::RefRegistry;
use crate::browser_agent::settings::BrowserAgentSettings;
use std::path::PathBuf;
use std::sync::Mutex;

pub(crate) struct BrowserAgentHub {
    settings: Mutex<BrowserAgentSettings>,
    settings_path: Mutex<Option<PathBuf>>,
    claim: Mutex<ClaimManager>,
    refs: Mutex<RefRegistry>,
    /// CDP per-tab 状态（Windows；其余平台 () 占位）。
    #[cfg(windows)]
    pub(crate) cdp: Mutex<CdpState>,
    #[cfg(not(windows))]
    pub(crate) cdp: Mutex<()>,
}

/// 工具执行结果信封：策略拒绝与执行失败都以 `{ok:false, code, message}` 返回
/// （HTTP 200 语义），MCP 工具结果原样可见错误码；只有基础设施故障才走 Err。
pub(crate) fn denial(code: &str, message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "ok": false, "code": code, "message": message.into() })
}

impl BrowserAgentHub {
    pub(crate) fn new() -> Self {
        Self {
            settings: Mutex::new(BrowserAgentSettings::default()),
            settings_path: Mutex::new(None),
            claim: Mutex::new(ClaimManager::new()),
            refs: Mutex::new(RefRegistry::new()),
            #[cfg(windows)]
            cdp: Mutex::new(CdpState::new()),
            #[cfg(not(windows))]
            cdp: Mutex::new(()),
        }
    }

    /// setup 时注入设置文件路径并完成首次载入。
    pub(crate) fn init_settings_path(&self, path: PathBuf) {
        let loaded = BrowserAgentSettings::load(&path);
        if let Ok(mut guard) = self.settings.lock() {
            *guard = loaded;
        }
        if let Ok(mut guard) = self.settings_path.lock() {
            *guard = Some(path);
        }
    }

    /// 读取设置快照。
    pub(crate) fn settings(&self) -> BrowserAgentSettings {
        self.settings
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// 解析有效档位（工作区覆盖优先）。
    pub(crate) fn resolve_access(&self, workspace_id: Option<&str>) -> BrowserAccessMode {
        self.settings().resolve_access(workspace_id)
    }

    /// 更新设置（归一化 + 原子持久化），返回归一化后的值。
    pub(crate) fn update_settings(
        &self,
        next: BrowserAgentSettings,
    ) -> Result<BrowserAgentSettings, String> {
        let path = {
            let guard = self
                .settings_path
                .lock()
                .map_err(|error| error.to_string())?;
            guard
                .clone()
                .ok_or_else(|| "browser agent 设置路径未初始化".to_string())?
        };
        next.save(&path)?;
        let normalized = next;
        if let Ok(mut guard) = self.settings.lock() {
            *guard = normalized.clone();
        }
        Ok(normalized)
    }

    pub(crate) fn claim(&self) -> &Mutex<ClaimManager> {
        &self.claim
    }

    pub(crate) fn refs(&self) -> &Mutex<RefRegistry> {
        &self.refs
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_agent::policy::AgentBrowserTool;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pylon-agent-hub-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn default_hub_resolves_readonly_and_updates_persist() {
        let hub = BrowserAgentHub::new();
        let dir = temp_dir("update");
        hub.init_settings_path(dir.join("pylon-browser-agent.json"));
        assert_eq!(hub.resolve_access(None), BrowserAccessMode::ReadOnly);

        let mut next = hub.settings();
        next.default_mode = BrowserAccessMode::Full;
        next.domain_blocklist = vec!["bank.cn".into()];
        hub.update_settings(next).unwrap();
        assert_eq!(hub.resolve_access(None), BrowserAccessMode::Full);

        // 持久化可重载：新 hub 指到同一文件应读到 full。
        let reloaded = BrowserAgentHub::new();
        reloaded.init_settings_path(dir.join("pylon-browser-agent.json"));
        assert_eq!(reloaded.resolve_access(None), BrowserAccessMode::Full);
        assert!(reloaded
            .settings()
            .domain_blocklist
            .contains(&"bank.cn".to_string()));
    }

    #[test]
    fn update_without_init_path_errors() {
        let hub = BrowserAgentHub::new();
        let error = hub
            .update_settings(BrowserAgentSettings::default())
            .unwrap_err();
        assert!(error.contains("未初始化"));
    }

    #[test]
    fn denial_envelope_shape() {
        let value = denial("readonly_restricted", "需要升档");
        assert_eq!(value["ok"], serde_json::Value::Bool(false));
        assert_eq!(value["code"], "readonly_restricted");
        let _ = AgentBrowserTool::Click;
    }
}
