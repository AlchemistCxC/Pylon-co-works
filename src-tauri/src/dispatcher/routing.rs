//! Typed Kernel routing policy for ACP session updates.
//!
//! This module deliberately owns decisions, not side-effect adapters.  The
//! dispatcher remains responsible for holding the session lock and invoking
//! Channel/Gateway/Pet adapters after a committed result is available.

use std::sync::Arc;

use crate::acp::{ReplayClassification, SessionUpdateVariant};
use crate::session::{CanonicalEventRow, DurableSessionOwner, EventError, EventService};

/// Ordered input to the Kernel routing seam.  `classification` is produced by
/// ACP transport; callers must not infer replay from provider metadata.
#[derive(Debug, Clone)]
pub(crate) struct RoutingInput {
    pub(crate) source: String,
    pub(crate) remote_session_id: String,
    pub(crate) generation: u64,
    pub(crate) owner: Option<DurableSessionOwner>,
    pub(crate) classification: ReplayClassification,
    pub(crate) variant: Option<SessionUpdateVariant>,
    pub(crate) replay_loading: bool,
    pub(crate) payload: serde_json::Value,
}

/// Side-effect policy decided once for an input event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RoutingClass {
    Live,
    Replay,
    Boundary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RoutingDecision {
    pub(crate) class: RoutingClass,
    pub(crate) variant: Option<SessionUpdateVariant>,
    /// Whether the event may mutate the in-memory session state.
    pub(crate) mutate_session: bool,
    /// Whether an agent message chunk belongs to the current live response.
    pub(crate) collect_response: bool,
    /// Whether Pet events may be emitted for this event.
    pub(crate) apply_pet: bool,
    /// Whether the event may enter the durable canonical journal.
    pub(crate) persist_canonical: bool,
    /// Whether the event may be sent to Channel/Gateway after commit.
    pub(crate) publish: bool,
}

pub(crate) fn classification_is_replay(classification: ReplayClassification) -> bool {
    matches!(classification, ReplayClassification::Replay { .. })
}

/// Decide routing policy without consulting provider-private metadata.
pub(crate) fn decide(input: &RoutingInput) -> RoutingDecision {
    let class = match input.classification {
        ReplayClassification::Live => RoutingClass::Live,
        ReplayClassification::Replay { .. } => RoutingClass::Replay,
        ReplayClassification::Boundary { .. } => RoutingClass::Boundary,
    };
    let is_live = class == RoutingClass::Live;
    let is_replay = class == RoutingClass::Replay;
    let is_user_chunk = input.variant == Some(SessionUpdateVariant::UserMessageChunk);
    let suppressed_during_load = is_replay && input.replay_loading;

    RoutingDecision {
        class,
        variant: input.variant,
        mutate_session: !is_user_chunk && (is_live || (is_replay && !suppressed_during_load)),
        collect_response: is_live && input.variant == Some(SessionUpdateVariant::AgentMessageChunk),
        apply_pet: is_live,
        persist_canonical: is_live && input.owner.is_some() && !is_user_chunk,
        publish: (is_live || is_replay && !suppressed_during_load) && !is_user_chunk,
    }
}

/// Agent-message chunk effects that must be applied while the session lock is
/// held.  The returned text is owned so the caller can safely feed the
/// session's round-bound collector after deriving Pet effects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentMessageChunkEffects {
    pub(crate) first_chunk: bool,
    pub(crate) code_seen: bool,
    pub(crate) text: Option<String>,
}

pub(crate) fn agent_message_chunk_effects(
    update: &serde_json::Value,
    decision: RoutingDecision,
) -> AgentMessageChunkEffects {
    if !decision.collect_response {
        return AgentMessageChunkEffects {
            first_chunk: false,
            code_seen: false,
            text: None,
        };
    }
    let text = update
        .get("content")
        .and_then(|content| content.get("text"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    AgentMessageChunkEffects {
        first_chunk: true,
        code_seen: text.as_deref().is_some_and(|value| value.contains("```")),
        text,
    }
}

/// Result of the durable append stage.  Adapters must only publish when the
/// result is `Committed`; a rejected append is never converted into a publish.
#[derive(Debug)]
pub(crate) enum CommitOutcome {
    Skipped,
    MissingService,
    Committed(Option<CanonicalEventRow>),
    Rejected(EventError),
}

pub(crate) async fn commit_live_event(
    input: &RoutingInput,
    decision: RoutingDecision,
    event_service: Option<&Arc<EventService>>,
) -> CommitOutcome {
    // Keep the source in the typed input so adapters cannot accidentally
    // substitute a different binding while an append is in flight.
    let _source = input.source.as_str();
    if !decision.persist_canonical {
        return CommitOutcome::Skipped;
    }
    let Some(owner) = input.owner.clone() else {
        return CommitOutcome::Skipped;
    };
    let Some(event_service) = event_service else {
        return CommitOutcome::MissingService;
    };
    match event_service
        .ingest_event(
            owner,
            Some(input.remote_session_id.clone()),
            input.generation,
            input.payload.clone(),
        )
        .await
    {
        Ok(result) => CommitOutcome::Committed(result.events.into_iter().next()),
        Err(error) => CommitOutcome::Rejected(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(
        classification: ReplayClassification,
        variant: Option<SessionUpdateVariant>,
        owner: bool,
        replay_loading: bool,
    ) -> RoutingInput {
        RoutingInput {
            source: "local:s1".to_string(),
            remote_session_id: "peri-s1".to_string(),
            generation: 1,
            owner: owner.then(|| DurableSessionOwner {
                profile_id: "profile".to_string(),
                agent_id: "agent".to_string(),
                local_session_id: "local:s1".to_string(),
            }),
            classification,
            variant,
            replay_loading,
            payload: serde_json::json!({"sessionId":"peri-s1"}),
        }
    }

    #[test]
    fn replay_decision_never_persists_or_applies_pet() {
        let decision = decide(&input(
            ReplayClassification::Replay { request_id: 7 },
            Some(SessionUpdateVariant::AgentMessageChunk),
            true,
            false,
        ));
        assert_eq!(decision.class, RoutingClass::Replay);
        assert!(decision.mutate_session);
        assert!(!decision.collect_response);
        assert!(!decision.apply_pet);
        assert!(!decision.persist_canonical);
        assert!(decision.publish);
    }

    #[test]
    fn live_agent_chunk_requires_commit_before_publish() {
        let decision = decide(&input(
            ReplayClassification::Live,
            Some(SessionUpdateVariant::AgentMessageChunk),
            true,
            false,
        ));
        assert_eq!(decision.class, RoutingClass::Live);
        assert!(decision.mutate_session);
        assert!(decision.collect_response);
        assert!(decision.apply_pet);
        assert!(decision.persist_canonical);
        assert!(decision.publish);
    }

    #[test]
    fn user_chunk_is_runtime_only_and_not_published() {
        let decision = decide(&input(
            ReplayClassification::Live,
            Some(SessionUpdateVariant::UserMessageChunk),
            true,
            false,
        ));
        assert!(!decision.mutate_session);
        assert!(!decision.persist_canonical);
        assert!(!decision.publish);
    }

    #[test]
    fn replay_loading_suppresses_incremental_publish() {
        let decision = decide(&input(
            ReplayClassification::Replay { request_id: 7 },
            Some(SessionUpdateVariant::ToolCall),
            true,
            true,
        ));
        assert!(!decision.mutate_session);
        assert!(!decision.publish);
    }

    #[test]
    fn response_boundary_cannot_mutate_or_publish_as_an_update() {
        let decision = decide(&input(
            ReplayClassification::Boundary { request_id: 7 },
            Some(SessionUpdateVariant::AgentMessageChunk),
            true,
            false,
        ));
        assert_eq!(decision.class, RoutingClass::Boundary);
        assert!(!decision.mutate_session);
        assert!(!decision.collect_response);
        assert!(!decision.apply_pet);
        assert!(!decision.persist_canonical);
        assert!(!decision.publish);
    }

    #[test]
    fn chunk_effects_are_derived_only_for_live_agent_chunks() {
        let update = serde_json::json!({"content":{"text":"```rust"}});
        let live = decide(&input(
            ReplayClassification::Live,
            Some(SessionUpdateVariant::AgentMessageChunk),
            true,
            false,
        ));
        assert_eq!(
            agent_message_chunk_effects(&update, live),
            AgentMessageChunkEffects {
                first_chunk: true,
                code_seen: true,
                text: Some("```rust".to_string()),
            }
        );
        let replay = decide(&input(
            ReplayClassification::Replay { request_id: 7 },
            Some(SessionUpdateVariant::AgentMessageChunk),
            true,
            false,
        ));
        assert_eq!(
            agent_message_chunk_effects(&update, replay),
            AgentMessageChunkEffects {
                first_chunk: false,
                code_seen: false,
                text: None,
            }
        );
    }
}
