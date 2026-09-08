//! Host/agent ownership policy for ACP fs and terminal channels.
//!
//! The policy is declarative only: Pylon currently executes no host fs or
//! terminal request in this module. `AgentSelfHosted` is the fail-closed
//! default selected by the ACP construction book.

use std::collections::BTreeMap;

pub const HOST_TOOLS_ENV: &str = "PYLON_ACP_HOST_TOOLS";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostToolsPolicy {
    AgentSelfHosted,
    HostStrict,
}

impl HostToolsPolicy {
    pub fn from_env(runtime_env: &BTreeMap<String, String>) -> Self {
        match runtime_env.get(HOST_TOOLS_ENV).map(|value| value.trim()) {
            Some("host") => Self::HostStrict,
            _ => Self::AgentSelfHosted,
        }
    }

    pub fn hosts_channels(self) -> bool { matches!(self, Self::HostStrict) }

    pub fn allows_request(self, method: &str) -> bool {
        self.hosts_channels() && (method.starts_with("fs/") || method.starts_with("terminal/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_agent_self_hosted_and_rejects_host_channels() {
        let policy = HostToolsPolicy::from_env(&BTreeMap::new());
        assert_eq!(policy, HostToolsPolicy::AgentSelfHosted);
        assert!(!policy.hosts_channels());
        assert!(!policy.allows_request("fs/read_text_file"));
        assert!(!policy.allows_request("terminal/create"));
    }

    #[test]
    fn host_opt_in_is_explicit_and_scoped() {
        let env = BTreeMap::from([(HOST_TOOLS_ENV.to_string(), " host ".to_string())]);
        let policy = HostToolsPolicy::from_env(&env);
        assert_eq!(policy, HostToolsPolicy::HostStrict);
        assert!(policy.allows_request("fs/read_text_file"));
        assert!(policy.allows_request("terminal/create"));
        assert!(!policy.allows_request("session/new"));
    }
}
