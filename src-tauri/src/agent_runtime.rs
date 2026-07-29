#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLifecycleStatus {
    Connecting,
    Connected,
    Reconnecting,
    Crashed,
    Disconnected,
    Error,
}

impl AgentLifecycleStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Reconnecting => "reconnecting",
            Self::Crashed => "crashed",
            Self::Disconnected => "disconnected",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRuntimeState {
    pub status: AgentLifecycleStatus,
    pub last_error: Option<String>,
    pub last_connected_at: Option<String>,
}

pub fn session_mapping_matches(
    current_peri_id: &str,
    current_generation: u64,
    expected_peri_id: &str,
    expected_generation: u64,
) -> bool {
    current_peri_id == expected_peri_id && current_generation == expected_generation
}

pub fn notification_matches_session(
    mapped_source: &str,
    event_source: &str,
    current_peri_id: &str,
    event_peri_id: &str,
    current_generation: u64,
    event_generation: u64,
) -> bool {
    mapped_source == event_source
        && session_mapping_matches(current_peri_id, current_generation, event_peri_id, event_generation)
}

pub fn status_after_connection_failure(previous: AgentLifecycleStatus) -> AgentLifecycleStatus {
    match previous {
        AgentLifecycleStatus::Connecting | AgentLifecycleStatus::Reconnecting => AgentLifecycleStatus::Disconnected,
        status => status,
    }
}

impl Default for AgentRuntimeState {
    fn default() -> Self {
        Self { status: AgentLifecycleStatus::Disconnected, last_error: None, last_connected_at: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_requires_matching_source_peri_id_and_generation() {
        assert!(notification_matches_session("a", "a", "peri-a", "peri-a", 4, 4));
        assert!(!notification_matches_session("a", "b", "peri-a", "peri-a", 4, 4));
        assert!(!notification_matches_session("a", "a", "peri-new", "peri-a", 4, 4));
        assert!(!notification_matches_session("a", "a", "peri-a", "peri-a", 5, 4));
    }

    #[test]
    fn connection_failure_returns_to_disconnected_without_mutating_connected_state() {
        assert_eq!(status_after_connection_failure(AgentLifecycleStatus::Connecting), AgentLifecycleStatus::Disconnected);
        assert_eq!(status_after_connection_failure(AgentLifecycleStatus::Reconnecting), AgentLifecycleStatus::Disconnected);
        assert_eq!(status_after_connection_failure(AgentLifecycleStatus::Connected), AgentLifecycleStatus::Connected);
    }

    #[test]
    fn lifecycle_status_strings_are_stable() {
        assert_eq!(AgentLifecycleStatus::Connecting.as_str(), "connecting");
        assert_eq!(AgentLifecycleStatus::Connected.as_str(), "connected");
        assert_eq!(AgentLifecycleStatus::Reconnecting.as_str(), "reconnecting");
        assert_eq!(AgentLifecycleStatus::Crashed.as_str(), "crashed");
        assert_eq!(AgentLifecycleStatus::Disconnected.as_str(), "disconnected");
        assert_eq!(AgentLifecycleStatus::Error.as_str(), "error");
    }

    #[test]
    fn runtime_state_defaults_to_disconnected_without_error() {
        let state = AgentRuntimeState::default();
        assert_eq!(state.status, AgentLifecycleStatus::Disconnected);
        assert_eq!(state.last_error, None);
        assert_eq!(state.last_connected_at, None);
    }

    #[test]
    fn stale_mapping_cannot_remove_replaced_session() {
        assert!(!session_mapping_matches("peri-new", 2, "peri-old", 1));
        assert!(!session_mapping_matches("peri-new", 2, "peri-new", 1));
        assert!(!session_mapping_matches("peri-old", 2, "peri-old", 1));
    }

    #[test]
    fn current_mapping_matches_peri_id_and_generation() {
        assert!(session_mapping_matches("peri-1", 3, "peri-1", 3));
    }
}
