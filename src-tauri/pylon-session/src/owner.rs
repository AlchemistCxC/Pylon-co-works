//! DurableSessionOwner：持久化 owner 三元组（profile/agent/local_session）。
//! 持久化状态永不以远端 ACP id 或 runtime 内部唯一 source 恢复——恢复键必须
//! 同时绑定三段身份（OWNER-01/§5.8）。
use crate::error::SessionError;

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableSessionOwner {
    pub profile_id: String,
    pub agent_id: String,
    pub local_session_id: String,
}

impl DurableSessionOwner {
    pub fn new(
        profile_id: impl Into<String>,
        agent_id: impl Into<String>,
        local_session_id: impl Into<String>,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            agent_id: agent_id.into(),
            local_session_id: local_session_id.into(),
        }
    }

    pub fn validate(&self) -> Result<(), SessionError> {
        for (field, value) in [
            ("profileId", self.profile_id.as_str()),
            ("agentId", self.agent_id.as_str()),
            ("localSessionId", self.local_session_id.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(SessionError::from(format!(
                    "durable session owner {field} must be non-empty"
                )));
            }
        }
        Ok(())
    }

    pub fn key(&self) -> Result<String, SessionError> {
        self.validate()?;
        serde_json::to_string(&[
            self.profile_id.as_str(),
            self.agent_id.as_str(),
            self.local_session_id.as_str(),
        ])
        .map_err(SessionError::from)
    }
}
