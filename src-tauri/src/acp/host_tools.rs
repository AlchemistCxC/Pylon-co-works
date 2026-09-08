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
    HostUnrestricted,
}

impl HostToolsPolicy {
    pub fn parse_env(runtime_env: &BTreeMap<String, String>) -> Result<Self, String> {
        match runtime_env.get(HOST_TOOLS_ENV).map(|value| value.trim()) {
            None | Some("") | Some("agent") => Ok(Self::AgentSelfHosted),
            Some("host") => Ok(Self::HostStrict),
            Some("unrestricted") | Some("permissive") => Ok(Self::HostUnrestricted),
            Some(other) => Err(format!("unsupported {HOST_TOOLS_ENV} value: {other}")),
        }
    }

    pub fn hosts_channels(self) -> bool {
        matches!(self, Self::HostStrict | Self::HostUnrestricted)
    }

    pub fn allows_request(self, method: &str) -> bool {
        self.hosts_channels() && (method.starts_with("fs/") || method.starts_with("terminal/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_agent_self_hosted_and_rejects_host_channels() {
        let policy = HostToolsPolicy::parse_env(&BTreeMap::new()).unwrap();
        assert_eq!(policy, HostToolsPolicy::AgentSelfHosted);
        assert!(!policy.hosts_channels());
        assert!(!policy.allows_request("fs/read_text_file"));
        assert!(!policy.allows_request("terminal/create"));
    }

    #[test]
    fn host_opt_in_is_explicit_and_scoped() {
        let env = BTreeMap::from([(HOST_TOOLS_ENV.to_string(), " host ".to_string())]);
        let policy = HostToolsPolicy::parse_env(&env).unwrap();
        assert_eq!(policy, HostToolsPolicy::HostStrict);
        assert!(policy.allows_request("fs/read_text_file"));
        assert!(policy.allows_request("terminal/create"));
        assert!(!policy.allows_request("session/new"));
    }

    #[test]
    fn unrestricted_opt_in_hosts_channels_and_unknown_values_fail_closed() {
        let env = BTreeMap::from([(HOST_TOOLS_ENV.to_string(), " permissive ".to_string())]);
        let policy = HostToolsPolicy::parse_env(&env).unwrap();
        assert_eq!(policy, HostToolsPolicy::HostUnrestricted);
        assert!(policy.allows_request("fs/read_text_file"));
        let invalid = BTreeMap::from([(HOST_TOOLS_ENV.to_string(), "typo".to_string())]);
        assert!(HostToolsPolicy::parse_env(&invalid).is_err());
    }
}
