//! Host/agent ownership policy for ACP fs and terminal channels.
//!
//! #316：fs 与 terminal **分门控**（`HostToolsPolicy { fs, terminal }`）——
//! fs 缺省 Host（默认广告并以 workspace root 沙箱执行），terminal 缺省
//! Agent（不广告不执行）。YAML（`acp.host_tools` / `acp.host_terminal`）
//! 声明优先；缺省门回退旧环境变量 `PYLON_ACP_HOST_TOOLS`（兼容既有 host
//! 档用户）；环境变量非法值 fail-closed。

use std::collections::BTreeMap;

use pylon_core::agent_config::HostToolsMode;

pub const HOST_TOOLS_ENV: &str = "PYLON_ACP_HOST_TOOLS";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostToolsPolicy {
    pub fs: HostToolsMode,
    pub terminal: HostToolsMode,
}

impl Default for HostToolsPolicy {
    /// #316 缺省：fs=Host（默认广告并沙箱执行），terminal=Agent（不广告不执行）。
    fn default() -> Self {
        Self {
            fs: HostToolsMode::Host,
            terminal: HostToolsMode::Agent,
        }
    }
}

impl HostToolsPolicy {
    /// YAML 声明优先；其次环境变量（仅当 env **实际设置**时——两门共用同一
    /// 值，历史语义）；二者皆无 → 各门缺省（fs=Host，terminal=Agent）。
    pub fn resolve(
        yaml_fs: Option<HostToolsMode>,
        yaml_terminal: Option<HostToolsMode>,
        runtime_env: &BTreeMap<String, String>,
    ) -> Result<Self, String> {
        let env_mode = parse_env_mode(runtime_env)?;
        Ok(Self {
            fs: yaml_fs.or(env_mode).unwrap_or(HostToolsMode::Host),
            terminal: yaml_terminal.or(env_mode).unwrap_or(HostToolsMode::Agent),
        })
    }

    /// 解析失败时的安全缺省（双门全关 + warn 由调用方记录）。
    pub fn closed() -> Self {
        Self {
            fs: HostToolsMode::Agent,
            terminal: HostToolsMode::Agent,
        }
    }

    pub fn fs_hosts(self) -> bool {
        !matches!(self.fs, HostToolsMode::Agent)
    }

    pub fn terminal_hosts(self) -> bool {
        !matches!(self.terminal, HostToolsMode::Agent)
    }

    pub fn allows_fs_request(self, method: &str) -> bool {
        self.fs_hosts() && method.starts_with("fs/")
    }

    pub fn allows_terminal_request(self, method: &str) -> bool {
        self.terminal_hosts() && method.starts_with("terminal/")
    }
}

/// 环境变量词表：未设/空 → None（门走各自缺省）；`agent` → Agent；
/// `host` → Host；`unrestricted`/`permissive` → Unrestricted；其它 fail-closed。
fn parse_env_mode(runtime_env: &BTreeMap<String, String>) -> Result<Option<HostToolsMode>, String> {
    match runtime_env.get(HOST_TOOLS_ENV).map(|value| value.trim()) {
        None | Some("") => Ok(None),
        Some("agent") => Ok(Some(HostToolsMode::Agent)),
        Some("host") => Ok(Some(HostToolsMode::Host)),
        Some("unrestricted") | Some("permissive") => Ok(Some(HostToolsMode::Unrestricted)),
        Some(other) => Err(format!("unsupported {HOST_TOOLS_ENV} value: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fs_defaults_host_and_terminal_defaults_agent() {
        let policy = HostToolsPolicy::resolve(None, None, &BTreeMap::new()).unwrap();
        assert_eq!(policy.fs, HostToolsMode::Host);
        assert_eq!(policy.terminal, HostToolsMode::Agent);
        assert!(policy.fs_hosts() && policy.allows_fs_request("fs/read_text_file"));
        assert!(!policy.allows_fs_request("session/new"));
        assert!(!policy.terminal_hosts());
        assert!(!policy.allows_terminal_request("terminal/create"));
    }

    #[test]
    fn yaml_declaration_wins_over_env_per_gate() {
        let env = BTreeMap::from([(HOST_TOOLS_ENV.to_string(), "host".to_string())]);
        let policy = HostToolsPolicy::resolve(
            Some(HostToolsMode::Agent),
            Some(HostToolsMode::Unrestricted),
            &env,
        )
        .unwrap();
        assert_eq!(policy.fs, HostToolsMode::Agent);
        assert_eq!(policy.terminal, HostToolsMode::Unrestricted);
        assert!(!policy.allows_fs_request("fs/write_text_file"));
        assert!(policy.allows_terminal_request("terminal/kill"));
    }

    #[test]
    fn env_still_gates_undeclared_channels_and_rejects_unknown_values() {
        let host_env = BTreeMap::from([(HOST_TOOLS_ENV.to_string(), " host ".to_string())]);
        let policy = HostToolsPolicy::resolve(None, None, &host_env).unwrap();
        assert!(policy.allows_fs_request("fs/read_text_file"));
        assert!(policy.allows_terminal_request("terminal/create"));
        let invalid = BTreeMap::from([(HOST_TOOLS_ENV.to_string(), "typo".to_string())]);
        assert!(HostToolsPolicy::resolve(None, None, &invalid).is_err());
        // 解析失败的安全缺省 = 双门全关。
        assert!(!HostToolsPolicy::closed().fs_hosts());
        assert!(!HostToolsPolicy::closed().terminal_hosts());
    }
}
