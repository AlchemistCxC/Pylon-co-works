//! MCP server 配置的后端校验与 ACP 请求序列化。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

pub const MAX_SERVERS: usize = 32;
const MAX_ARGS: usize = 64;
const MAX_ENV: usize = 64;
const MAX_HEADERS: usize = 64;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: Option<String>,
    pub name: Option<String>,
    pub transport: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub oauth: Option<OAuthConfig>,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OAuthConfig {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
}

fn default_enabled() -> bool { true }

pub fn validate_and_serialize(input: Option<Vec<McpServerConfig>>) -> Result<Vec<Value>, String> {
    let servers = input.unwrap_or_default();
    if servers.len() > MAX_SERVERS { return Err(format!("too many MCP servers: maximum is {MAX_SERVERS}")); }
    let mut identities = std::collections::HashSet::new();
    for server in &servers {
        for identity in [server.id.as_deref(), server.name.as_deref()].into_iter().flatten() {
            validate_text("server identity", identity)?;
            let key = identity.to_ascii_lowercase();
            if !identities.insert(key) {
                return Err(format!("duplicate MCP server identity: {identity}"));
            }
        }
    }
    servers.into_iter().filter(|server| server.enabled && !server.disabled).map(|server| {
        let transport = if server.transport.trim().is_empty() {
            if server.command.is_some() { "stdio".to_string() } else { "http".to_string() }
        } else { server.transport.to_ascii_lowercase() };
        if !matches!(transport.as_str(), "stdio" | "sse" | "streamable-http" | "http") {
            return Err(format!("unsupported MCP transport: {}", server.transport));
        }
        if server.args.len() > MAX_ARGS { return Err(format!("too many MCP args: maximum is {MAX_ARGS}")); }
        if server.env.len() > MAX_ENV { return Err(format!("too many MCP env entries: maximum is {MAX_ENV}")); }
        if server.headers.len() > MAX_HEADERS { return Err(format!("too many MCP headers: maximum is {MAX_HEADERS}")); }
        for arg in &server.args { validate_text("arg", arg)?; }
        validate_map("env", &server.env)?;
        validate_map("header", &server.headers)?;
        let mut result = Map::new();
        match transport.as_str() {
            "stdio" => {
                let command = server.command.ok_or_else(|| "stdio MCP server requires command".to_string())?;
                validate_text("command", &command)?;
                result.insert("command".into(), Value::String(command));
                result.insert("args".into(), Value::Array(server.args.into_iter().map(Value::String).collect()));
                if !server.env.is_empty() { result.insert("env".into(), map_strings(server.env)); }
            }
            "sse" | "streamable-http" | "http" => {
                let url = server.url.ok_or_else(|| "HTTP MCP server requires url".to_string())?;
                let parsed = url::Url::parse(&url).map_err(|_| "invalid MCP URL".to_string())?;
                if !matches!(parsed.scheme(), "http" | "https") { return Err("MCP URL must use http or https".into()); }
                result.insert("url".into(), Value::String(url));
                if !server.headers.is_empty() { result.insert("headers".into(), map_strings(server.headers)); }
                if let Some(oauth) = server.oauth {
                    validate_oauth(&oauth)?;
                    result.insert("oauth".into(), serde_json::to_value(oauth).map_err(|e| e.to_string())?);
                }
            }
            _ => unreachable!(),
        }
        Ok(Value::Object(result))
    }).collect()
}

fn validate_text(field: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() { return Err(format!("MCP {field} cannot be empty")); }
    if value.len() > 4096 { return Err(format!("MCP {field} is too long")); }
    if value.contains('\0') { return Err(format!("MCP {field} contains NUL")); }
    Ok(())
}

fn map_strings(values: HashMap<String, String>) -> Value {
    Value::Object(values.into_iter().map(|(key, value)| (key, Value::String(value))).collect())
}

fn validate_map(field: &str, values: &HashMap<String, String>) -> Result<(), String> {
    for (key, value) in values {
        validate_text(&format!("{field} key"), key)?;
        validate_text(field, value)?;
    }
    Ok(())
}

fn validate_oauth(oauth: &OAuthConfig) -> Result<(), String> {
    if let Some(value) = &oauth.client_id { validate_text("oauth client_id", value)?; }
    if let Some(value) = &oauth.client_secret { validate_text("oauth client_secret", value)?; }
    if let Some(scopes) = &oauth.scopes {
        if scopes.len() > MAX_ARGS { return Err(format!("too many OAuth scopes: maximum is {MAX_ARGS}")); }
        for scope in scopes { validate_text("oauth scope", scope)?; }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(enabled: bool) -> McpServerConfig {
        McpServerConfig { id: Some("demo".into()), name: None, transport: "stdio".into(), enabled, command: Some("demo-mcp".into()), args: vec!["--stdio".into()], env: HashMap::new(), url: None, headers: HashMap::new(), oauth: None, disabled: false }
    }

    #[test]
    fn disabled_servers_are_not_serialized() {
        assert!(validate_and_serialize(Some(vec![stdio(false)])).unwrap().is_empty());
    }

    #[test]
    fn stdio_server_serializes_without_secret_debug_output() {
        let values = validate_and_serialize(Some(vec![stdio(true)])).unwrap();
        assert_eq!(values[0]["command"], "demo-mcp");
    }

    #[test]
    fn rejects_invalid_transport_and_http_scheme() {
        let mut server = stdio(true);
        server.transport = "ftp".into();
        assert!(validate_and_serialize(Some(vec![server])).is_err());
        let mut server = stdio(true);
        server.transport = "sse".into();
        server.command = None;
        server.url = Some("file:///tmp/mcp".into());
        assert!(validate_and_serialize(Some(vec![server])).is_err());
    }

    #[test]
    fn rejects_duplicate_server_id_or_name_case_insensitively() {
        let mut first = stdio(true);
        first.id = Some("Server-A".into());
        let mut second = stdio(true);
        second.id = Some("server-a".into());
        assert!(validate_and_serialize(Some(vec![first, second])).is_err());

        let mut first = stdio(true);
        first.id = None;
        first.name = Some("shared-name".into());
        let mut second = stdio(true);
        second.id = None;
        second.name = Some("SHARED-NAME".into());
        assert!(validate_and_serialize(Some(vec![first, second])).is_err());
    }

    #[test]
    fn allows_unnamed_servers_without_identity_collision() {
        let mut first = stdio(true);
        first.id = None;
        let mut second = stdio(true);
        second.id = None;
        assert!(validate_and_serialize(Some(vec![first, second])).is_ok());
    }

    #[test]
    fn rejects_nul_or_oversized_mcp_values() {
        let mut server = stdio(true);
        server.args = vec!["bad\0arg".into()];
        assert!(validate_and_serialize(Some(vec![server])).is_err());

        let mut server = stdio(true);
        server.env.insert("TOKEN".into(), "x".repeat(4097));
        assert!(validate_and_serialize(Some(vec![server])).is_err());
    }

    #[test]
    fn validates_oauth_fields_without_redacting_wire_secret() {
        let mut server = stdio(true);
        server.transport = "http".into();
        server.command = None;
        server.url = Some("http://127.0.0.1:3000/mcp".into());
        server.oauth = Some(OAuthConfig {
            enabled: Some(true),
            client_id: Some("client".into()),
            client_secret: Some("secret".into()),
            scopes: Some(vec!["read".into()]),
        });
        let value = validate_and_serialize(Some(vec![server])).expect("valid OAuth config");
        assert_eq!(value[0]["oauth"]["clientSecret"], "secret");
    }
}
