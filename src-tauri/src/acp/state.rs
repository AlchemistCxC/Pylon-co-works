//! ACP live session state reducer.
//!
//! This module is deliberately UI-agnostic.  It consumes the transport's
//! already-classified raw notification and emits typed deltas; callers decide
//! whether a delta is committed to canonical history, projected to a renderer,
//! or ignored as replay.  No Tauri event, store, or renderer type may appear
//! here.

#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{AcpKind, RawMessage};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcpStateDelta {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    UserText {
        text: String,
    },
    ToolStarted {
        id: String,
        title: Option<String>,
    },
    ToolUpdated {
        id: String,
        status: Option<String>,
        output: Option<serde_json::Value>,
    },
    PermissionRequested {
        request_id: Option<String>,
        tool_call_id: Option<String>,
    },
    PermissionQueueDepth {
        depth: usize,
    },
    Usage {
        used: u64,
        size: Option<u64>,
        input: Option<u64>,
        output: Option<u64>,
    },
    Plan {
        entries: serde_json::Value,
    },
    Mode {
        mode: String,
    },
    Model {
        model: String,
    },
    Unknown {
        variant: String,
    },
}

/// Bounded live state owned by one ACP session. Text/tool maps are keyed by
/// provider ids so duplicate notifications update existing state instead of
/// creating a second UI row.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AcpSessionState {
    pub messages: Vec<String>,
    pub tools: BTreeMap<String, serde_json::Value>,
    pub pending_permissions: Vec<(String, String)>,
    pub usage: Option<(u64, Option<u64>)>,
    pub plan: Option<serde_json::Value>,
    pub mode: Option<String>,
    pub model: Option<String>,
}

impl AcpSessionState {
    /// Remove a resolved permission from the reducer-owned queue.  The caller
    /// supplies the canonical request id after a response or cancellation has
    /// been committed; stale ids are harmless and produce no delta.
    pub fn resolve_permission(&mut self, request_id: &str) -> Option<AcpStateDelta> {
        let before = self.pending_permissions.len();
        self.pending_permissions
            .retain(|(id, _)| id != request_id);
        (before != self.pending_permissions.len()).then_some(AcpStateDelta::PermissionQueueDepth {
            depth: self.pending_permissions.len(),
        })
    }
    /// Apply one raw ACP notification. Responses and unrelated notifications
    /// are intentionally no-ops. Unknown update variants remain observable as
    /// typed deltas so a newer Agent can be added without changing this state
    /// machine's framing or losing evidence.
    pub fn apply(&mut self, message: &RawMessage) -> Vec<AcpStateDelta> {
        if message.kind == AcpKind::PermissionRequest {
            let request_id = message.id.as_ref().map(ToString::to_string);
            let tool_call_id = message
                .params
                .as_ref()
                .and_then(serde_json::Value::as_object)
                .and_then(|params| string(params, &["toolCallId", "tool_call_id"]));
            if let (Some(request_id), Some(tool_call_id)) =
                (request_id.clone(), tool_call_id.clone())
            {
                self.pending_permissions
                    .push((request_id.clone(), tool_call_id.clone()));
            }
            return vec![
                AcpStateDelta::PermissionRequested {
                    request_id,
                    tool_call_id,
                },
                AcpStateDelta::PermissionQueueDepth {
                    depth: self.pending_permissions.len(),
                },
            ];
        }
        if message.kind != AcpKind::SessionUpdate {
            return Vec::new();
        }
        let Some(params) = message
            .params
            .as_ref()
            .and_then(serde_json::Value::as_object)
        else {
            return Vec::new();
        };
        let Some(update) = params.get("update").and_then(serde_json::Value::as_object) else {
            return Vec::new();
        };
        let variant = update
            .get("sessionUpdate")
            .or_else(|| update.get("session_update"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        let delta = match variant {
            "agent_message_chunk" => Self::text_delta(update, false),
            "agent_thought_chunk" | "agent_reasoning_chunk" => Self::text_delta(update, true),
            "user_message_chunk" => Self::text_delta(update, false).map(|d| match d {
                AcpStateDelta::Text { text } => AcpStateDelta::UserText { text },
                other => other,
            }),
            "tool_call" => {
                let Some(id) = string(update, &["toolCallId", "tool_call_id", "id"]) else {
                    return Vec::new();
                };
                let title = string(update, &["title", "name"]);
                self.tools.insert(id.clone(), update.clone().into());
                Some(AcpStateDelta::ToolStarted { id, title })
            }
            "tool_call_update" => {
                let Some(id) = string(update, &["toolCallId", "tool_call_id", "id"]) else {
                    return Vec::new();
                };
                let status = string(update, &["status"]);
                let output = update
                    .get("rawOutput")
                    .or_else(|| update.get("raw_output"))
                    .cloned();
                let mut next: serde_json::Value = update.clone().into();
                if let Some(previous) = self.tools.get(&id) {
                    let old = previous
                        .get("rawOutput")
                        .or_else(|| previous.get("raw_output"));
                    let key = if next.get("rawOutput").is_some() {
                        "rawOutput"
                    } else {
                        "raw_output"
                    };
                    if let (Some(old), Some(new)) = (old, next.get_mut(key)) {
                        append_output(old, new);
                    }
                }
                self.tools.insert(id.clone(), next);
                Some(AcpStateDelta::ToolUpdated { id, status, output })
            }
            "usage_update" => {
                let Some(used) = update
                    .get("used")
                    .or_else(|| update.get("value"))
                    .and_then(serde_json::Value::as_u64)
                else {
                    return Vec::new();
                };
                let size = update.get("size").and_then(serde_json::Value::as_u64);
                let input = update
                    .get("_meta")
                    .and_then(|meta| meta.get("inputTokens"))
                    .and_then(serde_json::Value::as_u64);
                let output = update
                    .get("_meta")
                    .and_then(|meta| meta.get("outputTokens"))
                    .and_then(serde_json::Value::as_u64);
                self.usage = Some((used, size));
                Some(AcpStateDelta::Usage {
                    used,
                    size,
                    input,
                    output,
                })
            }
            "plan" => {
                let entries = update
                    .get("entries")
                    .cloned()
                    .unwrap_or_else(|| update.clone().into());
                self.plan = Some(entries.clone());
                Some(AcpStateDelta::Plan { entries })
            }
            "current_mode_update" => {
                let Some(mode) = string(
                    update,
                    &["currentModeId", "current_mode_id", "modeId", "mode"],
                ) else {
                    return Vec::new();
                };
                self.mode = Some(mode.clone());
                Some(AcpStateDelta::Mode { mode })
            }
            "session_info_update" | "config_option_update" => {
                let model = update
                    .get("models")
                    .and_then(serde_json::Value::as_object)
                    .and_then(|m| {
                        string(
                            m,
                            &[
                                "currentModelId",
                                "current_model_id",
                                "currentModel",
                                "current",
                            ],
                        )
                    })
                    .or_else(|| string(update, &["modelId", "model_id", "model"]));
                model.map(|model| {
                    self.model = Some(model.clone());
                    AcpStateDelta::Model { model }
                })
            }
            other => Some(AcpStateDelta::Unknown {
                variant: other.to_owned(),
            }),
        };
        if let Some(ref delta) = delta {
            match delta {
                AcpStateDelta::Text { text }
                | AcpStateDelta::Reasoning { text }
                | AcpStateDelta::UserText { text } => self.messages.push(text.clone()),
                _ => {}
            }
        }
        delta.into_iter().collect()
    }

    fn text_delta(
        update: &serde_json::Map<String, serde_json::Value>,
        reasoning: bool,
    ) -> Option<AcpStateDelta> {
        let content = update.get("content").unwrap_or(&serde_json::Value::Null);
        let text = content
            .as_str()
            .or_else(|| content.get("text").and_then(serde_json::Value::as_str))?
            .to_owned();
        if reasoning {
            Some(AcpStateDelta::Reasoning { text })
        } else {
            Some(AcpStateDelta::Text { text })
        }
    }
}

fn string(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        map.get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    })
}

fn append_output(previous: &serde_json::Value, next: &mut serde_json::Value) {
    match (previous, &*next) {
        (serde_json::Value::Array(old), serde_json::Value::Array(new)) => {
            let mut combined = old.clone();
            combined.extend(new.iter().cloned());
            *next = serde_json::Value::Array(combined);
        }
        (serde_json::Value::String(old), serde_json::Value::String(new)) => {
            let mut combined = old.clone();
            combined.push_str(new);
            *next = serde_json::Value::String(combined);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(value: serde_json::Value) -> RawMessage {
        RawMessage {
            id: None,
            method: Some("session/update".into()),
            kind: AcpKind::SessionUpdate,
            result: None,
            params: Some(serde_json::json!({"sessionId":"s", "update": value})),
            error: None,
        }
    }

    #[test]
    fn reduces_text_tool_usage_and_mode_without_ui_side_effects() {
        let mut state = AcpSessionState::default();
        assert_eq!(
            state.apply(&update(
                serde_json::json!({"sessionUpdate":"agent_message_chunk", "content":{"text":"hi"}})
            )),
            vec![AcpStateDelta::Text { text: "hi".into() }]
        );
        assert_eq!(state.apply(&update(serde_json::json!({"sessionUpdate":"tool_call", "toolCallId":"t1", "title":"Read"}))).len(), 1);
        assert_eq!(
            state.apply(&update(
                serde_json::json!({"sessionUpdate":"usage_update", "used":7, "size":100})
            )),
            vec![AcpStateDelta::Usage {
                used: 7,
                size: Some(100),
                input: None,
                output: None,
            }]
        );
        assert_eq!(
            state.apply(&update(
                serde_json::json!({"sessionUpdate":"current_mode_update", "currentModeId":"accept"})
            )),
            vec![AcpStateDelta::Mode {
                mode: "accept".into()
            }]
        );
        assert_eq!(state.usage, Some((7, Some(100))));
    }

    #[test]
    fn unknown_variant_is_observable_and_non_session_messages_are_noop() {
        let mut state = AcpSessionState::default();
        assert_eq!(
            state.apply(&update(
                serde_json::json!({"sessionUpdate":"future_update"})
            )),
            vec![AcpStateDelta::Unknown {
                variant: "future_update".into()
            }]
        );
        let response = RawMessage {
            id: Some(crate::acp::RequestId::Number(1)),
            method: None,
            kind: AcpKind::Response,
            result: Some(serde_json::json!({})),
            params: None,
            error: None,
        };
        assert!(state.apply(&response).is_empty());
    }

    #[test]
    fn tool_updates_append_output_for_existing_call() {
        let mut state = AcpSessionState::default();
        state.apply(&update(serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "t1",
            "rawOutput": "a"
        })));
        state.apply(&update(serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "t1",
            "rawOutput": "b"
        })));
        assert_eq!(state.tools["t1"]["rawOutput"], "ab");
    }

    #[test]
    fn resolving_permission_updates_reducer_queue_depth() {
        let mut state = AcpSessionState {
            pending_permissions: vec![("7".into(), "tool-1".into())],
            ..Default::default()
        };
        assert_eq!(
            state.resolve_permission("7"),
            Some(AcpStateDelta::PermissionQueueDepth { depth: 0 })
        );
        assert!(state.resolve_permission("missing").is_none());
    }
}
