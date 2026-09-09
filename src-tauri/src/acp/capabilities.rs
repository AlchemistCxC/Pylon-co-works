//! Negotiated ACP capability registry.
//!
//! Capabilities are provider-advertised data, not assumptions made by a
//! renderer. Unknown paths deliberately resolve to `false`; an adapter may
//! register a private path without changing the standard capability surface.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityState {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CapabilityRegistry {
    /// The original object is the only stored capability source. Absence must
    /// stay distinct from an explicitly empty object on the existing status API.
    raw: Option<serde_json::Value>,
}

impl CapabilityRegistry {
    pub fn from_initialize_response(response: &serde_json::Value) -> Result<Self, String> {
        let raw = response.get("agentCapabilities").cloned();
        if raw.as_ref().is_some_and(|value| !value.is_object()) {
            return Err("initialize agentCapabilities 必须为 object".to_string());
        }
        Ok(Self { raw })
    }

    /// Each segment is a literal JSON object key, including dots in private
    /// extension names. Non-boolean values do not advertise a boolean ability.
    pub fn state(&self, path: &[&str]) -> CapabilityState {
        let mut value = self.raw.as_ref();
        for key in path {
            value = match value.and_then(serde_json::Value::as_object) {
                Some(object) => object.get(*key),
                None => None,
            };
        }
        match value.and_then(serde_json::Value::as_bool) {
            Some(true) => CapabilityState::Supported,
            Some(false) => CapabilityState::Unsupported,
            None => CapabilityState::Unknown,
        }
    }

    /// Fail-closed standard check: only an explicit `true` is supported.
    pub fn supports(&self, path: &[&str]) -> bool {
        self.state(path) == CapabilityState::Supported
    }

    /// Object-valued capabilities (for example `sessionCapabilities.resume`)
    /// are advertised by presence of an object, not by a boolean leaf.
    pub fn supports_object(&self, path: &[&str]) -> bool {
        let mut value = self.raw.as_ref();
        for key in path {
            value = match value.and_then(serde_json::Value::as_object) {
                Some(object) => object.get(*key),
                None => None,
            };
        }
        value.is_some_and(serde_json::Value::is_object)
    }

    pub fn raw(&self) -> Option<&serde_json::Value> {
        self.raw.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_standard_and_private_capabilities_fail_closed() {
        let registry = CapabilityRegistry::from_initialize_response(&serde_json::json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": {"image": true, "audio": false},
                "_meta": {"provider.fastPath": true}
            }
        }))
        .unwrap();
        assert!(registry.supports(&["loadSession"]));
        assert!(registry.supports(&["promptCapabilities", "image"]));
        assert!(!registry.supports(&["promptCapabilities", "audio"]));
        assert_eq!(registry.state(&["fork"]), CapabilityState::Unknown);
        assert!(registry.supports(&["_meta", "provider.fastPath"]));
        assert!(!registry.supports(&["_meta", "provider", "fastPath"]));
    }

    #[test]
    fn absent_empty_and_non_boolean_capabilities_remain_distinct() {
        let absent = CapabilityRegistry::from_initialize_response(&serde_json::json!({})).unwrap();
        let empty = CapabilityRegistry::from_initialize_response(
            &serde_json::json!({"agentCapabilities": {}}),
        )
        .unwrap();
        assert_eq!(absent.raw(), None);
        assert_eq!(empty.raw(), Some(&serde_json::json!({})));
        let registry = CapabilityRegistry::from_initialize_response(&serde_json::json!({
            "agentCapabilities": {"loadSession": "true", "promptCapabilities": {"image": 1}}
        }))
        .unwrap();
        for path in [
            vec!["loadSession"],
            vec!["promptCapabilities", "image"],
            vec![],
            vec!["missing"],
        ] {
            assert_eq!(registry.state(&path), CapabilityState::Unknown);
            assert!(!registry.supports(&path));
        }
    }

    #[test]
    fn malformed_capabilities_are_rejected() {
        let error = CapabilityRegistry::from_initialize_response(&serde_json::json!({
            "agentCapabilities": []
        }))
        .unwrap_err();
        assert!(error.contains("必须为 object"));
    }

    #[test]
    fn object_capabilities_are_distinguished_from_boolean_leaves() {
        let registry = CapabilityRegistry::from_initialize_response(&serde_json::json!({
            "agentCapabilities": {"sessionCapabilities": {"resume": {}}}
        }))
        .unwrap();
        assert!(registry.supports_object(&["sessionCapabilities", "resume"]));
        assert!(!registry.supports(&["sessionCapabilities", "resume"]));
    }
}
