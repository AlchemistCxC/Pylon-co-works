//! Agent 浏览器授权档位与工具分档矩阵（issue #82 裁决：默认 readonly）。
//!
//! 策略在 `browser_agent_*` 命令 handler 内单点强制：MCP 桥与 pylon_cli
//! 两条通道最终都落到这些 handler，不存在旁路。URL 一律复用
//! [`crate::browser::is_allowed_browser_url`]（与用户同一白名单函数），
//! 再叠加用户可配域名黑名单。

use serde::{Deserialize, Serialize};

/// Agent 使用浏览器的授权档位。`off` 时不注入浏览器 MCP server，工具不存在；
/// `readonly` 默认可用（观察类工具）；`full` 需在 Sheet「Agent」面板显式升档。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BrowserAccessMode {
    Off,
    ReadOnly,
    Full,
}

impl BrowserAccessMode {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::ReadOnly => "readonly",
            Self::Full => "full",
        }
    }
}

/// Agent 浏览器工具集合（与 MCP 工具一一对应，snake_case 即工具名后缀）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentBrowserTool {
    Navigate,
    Snapshot,
    Screenshot,
    Wait,
    ReadNetwork,
    SavePage,
    Scroll,
    TabList,
    TabNew,
    TabSelect,
    TabClose,
    Emulate,
    Click,
    Type,
    Press,
    Download,
}

impl AgentBrowserTool {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Navigate => "browser_navigate",
            Self::Snapshot => "browser_snapshot",
            Self::Screenshot => "browser_screenshot",
            Self::Wait => "browser_wait",
            Self::ReadNetwork => "browser_read_network",
            Self::SavePage => "browser_save_page",
            Self::Scroll => "browser_scroll",
            Self::TabList => "browser_tab_list",
            Self::TabNew => "browser_tab_new",
            Self::TabSelect => "browser_tab_select",
            Self::TabClose => "browser_tab_close",
            Self::Emulate => "browser_emulate",
            Self::Click => "browser_click",
            Self::Type => "browser_type",
            Self::Press => "browser_press",
            Self::Download => "browser_download",
        }
    }
}

/// 策略拒绝的结构化错误码（wire 契约：MCP 工具结果 `code` 字段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PolicyDenial {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl PolicyDenial {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// 分档矩阵：readonly 放行观察类与导航/滚轮（观察新页面与懒加载所需），
/// 写操作（交互输入/下载/关标签）仅 full 档放行。off 拒绝一切。
pub(crate) fn check_tool_allowed(
    mode: BrowserAccessMode,
    tool: AgentBrowserTool,
) -> Result<(), PolicyDenial> {
    match mode {
        BrowserAccessMode::Off => Err(PolicyDenial::new(
            "agent_access_off",
            "Agent 浏览器访问已关闭（off）。请在 Browser Sheet「Agent」面板开启。",
        )),
        BrowserAccessMode::ReadOnly => match tool {
            AgentBrowserTool::Navigate
            | AgentBrowserTool::Snapshot
            | AgentBrowserTool::Screenshot
            | AgentBrowserTool::Wait
            | AgentBrowserTool::ReadNetwork
            | AgentBrowserTool::SavePage
            | AgentBrowserTool::Scroll
            | AgentBrowserTool::TabList
            | AgentBrowserTool::TabNew
            | AgentBrowserTool::TabSelect
            | AgentBrowserTool::Emulate => Ok(()),
            AgentBrowserTool::Click
            | AgentBrowserTool::Type
            | AgentBrowserTool::Press
            | AgentBrowserTool::Download
            | AgentBrowserTool::TabClose => Err(PolicyDenial::new(
                "readonly_restricted",
                "当前为只读档（readonly）：点击/输入/按键/下载/关标签需要升档。\
                 请用户在 Browser Sheet「Agent」面板切换为 full。",
            )),
        },
        BrowserAccessMode::Full => Ok(()),
    }
}

/// 域名黑名单：后缀匹配（`example.com` 命中 `example.com` 与 `a.example.com`）。
/// 条目在 settings 层已做小写归一；`http://10.0.0.1:8080` 这类 host:port
/// 先剥端口再匹配。空串与点号异常条目不匹配任何 host。
pub(crate) fn is_domain_blocked(url: &url::Url, blocklist: &[String]) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    blocklist.iter().any(|entry| {
        let entry = entry.trim().trim_end_matches('.').to_ascii_lowercase();
        if entry.is_empty() {
            return false;
        }
        host == entry || host.strip_suffix(&format!(".{entry}")).is_some()
    })
}

/// 导航类操作的 URL 策略：先过与用户相同的 scheme 白名单，再过域名黑名单。
pub(crate) fn check_url_allowed(url: &url::Url, blocklist: &[String]) -> Result<(), PolicyDenial> {
    if !crate::browser::is_allowed_browser_url(url) {
        return Err(PolicyDenial::new(
            "url_rejected",
            format!(
                "URL 被 Browser Sheet 白名单拒绝（仅允许 http/https）：scheme={}",
                url.scheme()
            ),
        ));
    }
    if is_domain_blocked(url, blocklist) {
        return Err(PolicyDenial::new(
            "domain_blocked",
            format!(
                "域名 {} 在 Agent 浏览器黑名单中。请用户在 Browser Sheet「Agent」面板调整。",
                url.host_str().unwrap_or("<unknown>")
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_mode_denies_every_tool() {
        for tool in [
            AgentBrowserTool::Navigate,
            AgentBrowserTool::Snapshot,
            AgentBrowserTool::Screenshot,
            AgentBrowserTool::Wait,
            AgentBrowserTool::ReadNetwork,
            AgentBrowserTool::SavePage,
            AgentBrowserTool::Scroll,
            AgentBrowserTool::TabList,
            AgentBrowserTool::TabNew,
            AgentBrowserTool::TabSelect,
            AgentBrowserTool::TabClose,
            AgentBrowserTool::Emulate,
            AgentBrowserTool::Click,
            AgentBrowserTool::Type,
            AgentBrowserTool::Press,
            AgentBrowserTool::Download,
        ] {
            let denial = check_tool_allowed(BrowserAccessMode::Off, tool).unwrap_err();
            assert_eq!(denial.code, "agent_access_off");
        }
    }

    #[test]
    fn readonly_allows_observe_and_blocks_write() {
        for tool in [
            AgentBrowserTool::Navigate,
            AgentBrowserTool::Snapshot,
            AgentBrowserTool::Screenshot,
            AgentBrowserTool::Wait,
            AgentBrowserTool::ReadNetwork,
            AgentBrowserTool::SavePage,
            AgentBrowserTool::Scroll,
            AgentBrowserTool::TabList,
            AgentBrowserTool::TabNew,
            AgentBrowserTool::TabSelect,
            AgentBrowserTool::Emulate,
        ] {
            assert!(check_tool_allowed(BrowserAccessMode::ReadOnly, tool).is_ok());
        }
        for tool in [
            AgentBrowserTool::Click,
            AgentBrowserTool::Type,
            AgentBrowserTool::Press,
            AgentBrowserTool::Download,
            AgentBrowserTool::TabClose,
        ] {
            let denial = check_tool_allowed(BrowserAccessMode::ReadOnly, tool).unwrap_err();
            assert_eq!(denial.code, "readonly_restricted");
            assert!(denial.message.contains("full"), "文案需指向升档入口");
        }
    }

    #[test]
    fn full_allows_every_tool() {
        for tool in [
            AgentBrowserTool::Navigate,
            AgentBrowserTool::Snapshot,
            AgentBrowserTool::Click,
            AgentBrowserTool::Type,
            AgentBrowserTool::Press,
            AgentBrowserTool::Download,
            AgentBrowserTool::TabClose,
        ] {
            assert!(check_tool_allowed(BrowserAccessMode::Full, tool).is_ok());
        }
    }

    #[test]
    fn domain_blocklist_matches_suffix_and_strips_port() {
        let blocklist = vec!["Example.COM".to_string(), "bank.cn".to_string()];
        assert!(is_domain_blocked(
            &url::Url::parse("https://example.com/x").unwrap(),
            &blocklist
        ));
        assert!(is_domain_blocked(
            &url::Url::parse("https://a.example.com/y").unwrap(),
            &blocklist
        ));
        assert!(is_domain_blocked(
            &url::Url::parse("http://bank.cn:8443/login").unwrap(),
            &blocklist
        ));
        assert!(!is_domain_blocked(
            &url::Url::parse("https://notexample.com").unwrap(),
            &blocklist
        ));
        assert!(!is_domain_blocked(
            &url::Url::parse("https://example.com.evil.io").unwrap(),
            &blocklist
        ));
        assert!(!is_domain_blocked(
            &url::Url::parse("about:blank").unwrap(),
            &blocklist
        ));
    }

    #[test]
    fn url_check_reuses_user_whitelist_then_blocklist() {
        let blocklist = vec!["bank.cn".to_string()];
        assert!(
            check_url_allowed(&url::Url::parse("https://example.com").unwrap(), &blocklist).is_ok()
        );
        assert!(check_url_allowed(&url::Url::parse("about:blank").unwrap(), &blocklist).is_ok());
        let scheme_denial =
            check_url_allowed(&url::Url::parse("file:///etc/passwd").unwrap(), &blocklist)
                .unwrap_err();
        assert_eq!(scheme_denial.code, "url_rejected");
        let domain_denial =
            check_url_allowed(&url::Url::parse("https://bank.cn/pay").unwrap(), &blocklist)
                .unwrap_err();
        assert_eq!(domain_denial.code, "domain_blocked");
    }
}
