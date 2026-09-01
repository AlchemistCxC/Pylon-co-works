//! 会话级可恢复状态注册表。
//!
//! 统一把“会话切换后需要回填前端的状态量”声明在这里：
//! 每个状态项负责两件事——从会话响应捕获（capture）与回填到会话响应（restore）。
//! 以后新增状态量只需在 `SESSION_STATE_ENTRIES` 追加一项，无需改动 create/persist。

use super::model::SessionInfo;

pub(crate) struct SessionStateEntry {
    pub(crate) capture: fn(&mut SessionInfo, &serde_json::Value),
    pub(crate) restore: fn(&SessionInfo, &mut serde_json::Value),
}

fn capture_usage(session: &mut SessionInfo, response: &serde_json::Value) {
    if let Some(usage) = response
        .get("usage")
        .or_else(|| {
            response
                .get("sessionInfo")
                .and_then(|info| info.get("usage"))
        })
        .cloned()
    {
        session.snapshots.insert("usage".to_string(), usage);
    }
}

fn restore_usage(session: &SessionInfo, response: &mut serde_json::Value) {
    if response.get("usage").is_some() {
        return;
    }
    if let Some(usage) = session.snapshots.get("usage") {
        if let Some(obj) = response.as_object_mut() {
            obj.insert("usage".to_string(), usage.clone());
        }
    }
}

fn capture_commands(session: &mut SessionInfo, response: &serde_json::Value) {
    let commands = response
        .get("commands")
        .or_else(|| response.get("availableCommands"))
        .cloned();
    if let Some(commands) = commands {
        session.snapshots.insert("commands".to_string(), commands);
    }
}

fn restore_commands(session: &SessionInfo, response: &mut serde_json::Value) {
    if response.get("commands").is_some() || response.get("availableCommands").is_some() {
        return;
    }
    if let Some(commands) = session.snapshots.get("commands") {
        if let Some(obj) = response.as_object_mut() {
            obj.insert("commands".to_string(), commands.clone());
        }
    }
}

fn capture_config_options(session: &mut SessionInfo, _response: &serde_json::Value) {
    // config_options 已在 SessionInfo::apply_session_response 中解析并写入 typed 字段；
    // 这里保持为空实现，restore 从 typed 字段回填。
    let _ = session;
}

fn restore_config_options(session: &SessionInfo, response: &mut serde_json::Value) {
    if response.get("configOptions").is_some() || session.config_options.is_empty() {
        return;
    }
    if let Some(obj) = response.as_object_mut() {
        obj.insert(
            "configOptions".to_string(),
            serde_json::json!(session.config_options),
        );
    }
}

fn capture_mode(session: &mut SessionInfo, _response: &serde_json::Value) {
    // mode 已在 SessionInfo::apply_session_response 中解析并写入 typed 字段。
    let _ = session;
}

fn restore_mode(session: &SessionInfo, response: &mut serde_json::Value) {
    if response.get("modes").is_some() {
        return;
    }
    let mode = session.mode.clone().or_else(|| {
        session
            .snapshots
            .get("mode")
            .and_then(|value| value.as_str())
            .map(str::to_string)
    });
    if let Some(mode) = mode {
        if let Some(obj) = response.as_object_mut() {
            obj.insert(
                "modes".to_string(),
                serde_json::json!({ "currentModeId": mode }),
            );
        }
    }
}

pub(crate) static SESSION_STATE_ENTRIES: &[SessionStateEntry] = &[
    SessionStateEntry {
        capture: capture_usage,
        restore: restore_usage,
    },
    SessionStateEntry {
        capture: capture_commands,
        restore: restore_commands,
    },
    SessionStateEntry {
        capture: capture_config_options,
        restore: restore_config_options,
    },
    SessionStateEntry {
        capture: capture_mode,
        restore: restore_mode,
    },
];

pub(crate) fn capture_session_state(session: &mut SessionInfo, response: &serde_json::Value) {
    for entry in SESSION_STATE_ENTRIES {
        (entry.capture)(session, response);
    }
}

pub(crate) fn restore_session_state(session: &SessionInfo, response: &mut serde_json::Value) {
    for entry in SESSION_STATE_ENTRIES {
        (entry.restore)(session, response);
    }
}
