//! Typed Kernel routing policy for ACP session updates.
//!
//! This module deliberately owns decisions, not side-effect adapters.  The
//! dispatcher remains responsible for holding the session lock and invoking
//! Channel/Gateway/reaction-sink adapters after a committed result is available
//! （#416 W2：产品感知门控不在本决策面——`apply_pet` 字段已删，改由
//! `KernelReactionSink::wants_live_reactions(class)` 承接）.

use std::sync::Arc;

use crate::acp::{ReplayClassification, SessionUpdateVariant};
use crate::session::{CanonicalEventRow, DurableSessionOwner, EventError, EventService};

/// Ordered input to the Kernel routing seam.  `classification` is produced by
/// ACP transport; callers must not infer replay from provider metadata.
///
/// #334/P2：`payload` 以 `Arc<Value>` 共享——ingest（需 `'static` 拥有跨
/// spawn_blocking）与 publish（ingest 之后注入 source/canonicalEvent）两侧都要
/// payload，深拷贝以引用计数取代；发布侧在 ingest 完成后 `Arc::try_unwrap`
/// 取回唯一引用。
#[derive(Debug, Clone)]
pub(crate) struct RoutingInput {
    pub(crate) source: String,
    pub(crate) remote_session_id: String,
    pub(crate) generation: u64,
    pub(crate) owner: Option<DurableSessionOwner>,
    pub(crate) classification: ReplayClassification,
    pub(crate) variant: Option<SessionUpdateVariant>,
    pub(crate) replay_loading: bool,
    pub(crate) payload: std::sync::Arc<serde_json::Value>,
    pub(crate) wire_ordinal: Option<u64>,
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
    /// Whether the event may enter the durable canonical journal.
    pub(crate) persist_canonical: bool,
    /// Whether the event may be sent to Channel/Gateway after commit.
    pub(crate) publish: bool,
    // #416 W2：原 `apply_pet: is_live` 产品面字段已删——感知门控改由
    // `KernelReactionSink::wants_live_reactions(decision.class)` 承接
    // （门控语义钉在 class==Live：Replay 与 Boundary 均不产感知）。
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
    /// A committed outcome always carries the durable row that adapters may
    /// publish.  Keeping the row non-optional makes the C0-COMMIT invariant a
    /// type-level guarantee rather than a caller convention.
    Committed {
        event: CanonicalEventRow,
        revision: i64,
    },
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
            // P2（#334）：Arc 共享传递（原深拷贝拆除）；publish 侧稍后取回唯一引用。
            Arc::clone(&input.payload),
        )
        .await
    {
        Ok(result) => match result.events.into_iter().next() {
            Some(event) => CommitOutcome::Committed {
                event,
                revision: result.revision,
            },
            None => CommitOutcome::Rejected(EventError::Invalid(
                "canonical ingest committed no event".to_string(),
            )),
        },
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
            payload: std::sync::Arc::new(serde_json::json!({"sessionId":"peri-s1"})),
            wire_ordinal: None,
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
        // 原 `assert!(!decision.apply_pet)`（#416 W2 字段已删）：Replay 类非
        // Live，感知门控 `wants_live_reactions(class)` 恒 false（reactions.rs
        // reaction_gate_drops_replay_and_boundary_frames 钉住）。
        assert_ne!(decision.class, RoutingClass::Live);
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
        // 原 `assert!(decision.apply_pet)`（#416 W2 字段已删）：Live 类下感知
        // 门控由 sink 的 wants_live_reactions(Live)=true 承接。
        assert_eq!(decision.class, RoutingClass::Live);
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
        // 原 `assert!(!decision.apply_pet)`（#416 W2 字段已删）：Boundary 类非
        // Live，感知门控恒 false（R2 修正：终态边界帧同样不产感知）。
        assert_ne!(decision.class, RoutingClass::Live);
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
