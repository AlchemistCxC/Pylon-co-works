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

pub fn notification_is_current(
    mapped_source: &str,
    event_source: &str,
    current_peri_id: &str,
    event_peri_id: &str,
    current_generation: u64,
    event_generation: u64,
    active_generation: u64,
) -> bool {
    notification_matches_session(
        mapped_source,
        event_source,
        current_peri_id,
        event_peri_id,
        current_generation,
        event_generation,
    ) && current_generation == active_generation
}

///
/// Peri `session/update` carries only `sessionId`. The local generation is
/// therefore part of the routing key: stale mappings from an older client
/// must not make the current mapping ambiguous, and an old-only mapping must
/// be rejected.
pub fn source_for_peri_id_in_generation<'a, I>(
    mappings: I,
    peri_id: &str,
    current_generation: u64,
) -> Option<(String, u64)>
where
    I: IntoIterator<Item = (&'a String, &'a String, u64)>,
{
    let mut matches = mappings
        .into_iter()
        .filter(|(_, mapped_peri_id, generation)| {
            mapped_peri_id.as_str() == peri_id && *generation == current_generation
        })
        .map(|(source, _, generation)| (source.clone(), generation));
    let first = matches.next()?;
    if matches.next().is_some() { None } else { Some(first) }
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
    fn notification_current_requires_active_generation() {
        assert!(notification_is_current("a", "a", "peri-a", "peri-a", 4, 4, 4));
        assert!(!notification_is_current("a", "a", "peri-a", "peri-a", 4, 4, 5));
        assert!(!notification_is_current("a", "a", "peri-a", "peri-a", 5, 4, 5));
        assert!(!notification_is_current("a", "b", "peri-a", "peri-a", 4, 4, 4));
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
    fn stale_generation_cannot_remove_current_session() {
        assert!(!session_mapping_matches("peri-current", 3, "peri-old", 2));
        assert!(!session_mapping_matches("peri-current", 3, "peri-current", 2));
    }

    #[test]
    fn duplicate_peri_id_is_rejected_as_ambiguous_in_active_generation() {
        let source_a = String::from("source-a");
        let source_b = String::from("source-b");
        let peri_id = String::from("peri-shared");
        let mappings = vec![(&source_a, &peri_id, 3), (&source_b, &peri_id, 3)];
        assert_eq!(source_for_peri_id_in_generation(mappings, "peri-shared", 3), None);
    }

    #[test]
    fn stale_generation_mapping_does_not_shadow_active_mapping() {
        let old_source = String::from("source-old");
        let active_source = String::from("source-active");
        let peri_id = String::from("peri-replaced");
        let mappings = vec![(&old_source, &peri_id, 2), (&active_source, &peri_id, 3)];
        assert_eq!(source_for_peri_id_in_generation(mappings, "peri-replaced", 3), Some(("source-active".into(), 3)));
        assert_eq!(source_for_peri_id_in_generation(vec![(&old_source, &peri_id, 2)], "peri-replaced", 3), None);
    }

    #[test]
    fn unique_source_resolves_one_mapping_in_active_generation() {
        let source = String::from("source-a");
        let peri_id = String::from("peri-1");
        let mappings = vec![(&source, &peri_id, 7)];
        assert_eq!(source_for_peri_id_in_generation(mappings, "peri-1", 7), Some(("source-a".into(), 7)));
    }

    #[test]
    fn unrelated_peri_id_does_not_resolve() {
        let source = String::from("source-a");
        let peri_id = String::from("peri-a");
        let mappings = vec![(&source, &peri_id, 1)];
        assert_eq!(source_for_peri_id_in_generation(mappings, "peri-b", 1), None);
    }
}
