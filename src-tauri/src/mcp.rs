//! MCP server 配置的后端校验与 ACP 请求序列化。
//!
//! 序列化统一走官方 agent-client-protocol-schema v1 的 McpServer 类型
//! （tagged：http/sse 带 type，stdio untagged）——与 ACP 同源，wire 格式
//! 由 schema 保证。差异字典见 acp.rs「差异适配表」：Hermes 要求 name 必填，
//! Peri DefaultOnError 容忍但 name 缺失会被跳过；统一补 name（name→id 兜底）
//! 两边兼容。注意：官方 schema 无 oauth 字段，OAuthConfig 仅作前端表单
//! 校验保留，不序列化进 wire。

use agent_client_protocol_schema::v1::{
    EnvVariable, HttpHeader, McpServer, McpServerHttp, McpServerSse, McpServerStdio,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    /// P3 评估：enabled/disabled 语义重叠（`enabled && !disabled` 才生效），
    /// 但不可收敛为一个字段——两者都是与前端/持久化配置的 wire 契约
    /// （lib.rs 构造与 serde_json 持久化直接使用），删除会破坏 lib.rs 与
    /// 已落盘配置。语义上也有区分：enabled 缺省 true（表单默认开），
    /// disabled 是显式"排除"途径（禁用冲突 server 不参与去重，见
    /// validate_and_serialize 注释）。
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

fn default_enabled() -> bool {
    true
}

pub fn validate_and_serialize(input: Option<Vec<McpServerConfig>>) -> Result<Vec<Value>, String> {
    let servers = input.unwrap_or_default();
    if servers.len() > MAX_SERVERS {
        return Err(format!("too many MCP servers: maximum is {MAX_SERVERS}"));
    }
    // 审查修复：去重只针对启用中的 server——禁用冲突 server 应作为"排除"途径
    // （disabled 不进 wire，却参与去重会报 duplicate 且无解除途径）。
    // O60：去重并入序列化单次迭代（此前两遍遍历）。校验顺序保持先身份后
    // 传输细节——身份冲突的 server 不进入后续校验即报错，语义不变。
    let mut identities = std::collections::HashSet::new();
    servers
        .into_iter()
        .filter(|server| server.enabled && !server.disabled)
        .map(|server| {
            // 核验修复：同一 server 内 id 与 name 相同不算重复（只防跨 server 撞 identity）。
            let mut local = std::collections::HashSet::new();
            for identity in [server.id.as_deref(), server.name.as_deref()]
                .into_iter()
                .flatten()
            {
                validate_text("server identity", identity)?;
                let key = identity.to_ascii_lowercase();
                if !local.insert(key.clone()) {
                    continue;
                }
                if !identities.insert(key) {
                    return Err(format!("duplicate MCP server identity: {identity}"));
                }
            }
            let transport = if server.transport.trim().is_empty() {
                if server.command.is_some() {
                    "stdio".to_string()
                } else {
                    "http".to_string()
                }
            } else {
                server.transport.to_ascii_lowercase()
            };
            if !matches!(
                transport.as_str(),
                "stdio" | "sse" | "streamable-http" | "http"
            ) {
                return Err(format!("unsupported MCP transport: {}", server.transport));
            }
            if server.args.len() > MAX_ARGS {
                return Err(format!("too many MCP args: maximum is {MAX_ARGS}"));
            }
            if server.env.len() > MAX_ENV {
                return Err(format!("too many MCP env entries: maximum is {MAX_ENV}"));
            }
            if server.headers.len() > MAX_HEADERS {
                return Err(format!("too many MCP headers: maximum is {MAX_HEADERS}"));
            }
            for arg in &server.args {
                validate_text("arg", arg)?;
            }
            validate_map("env", &server.env)?;
            validate_map("header", &server.headers)?;
            // name 必填（Hermes 严格；Peri 缺失会被 DefaultOnError 跳过）——name→id 兜底
            let name = server
                .name
                .clone()
                .or_else(|| server.id.clone())
                .filter(|n| !n.trim().is_empty())
                .ok_or_else(|| "MCP server requires name or id".to_string())?;
            validate_text("name", &name)?;
            let value = match transport.as_str() {
                "stdio" => {
                    let command = server
                        .command
                        .ok_or_else(|| "stdio MCP server requires command".to_string())?;
                    validate_text("command", &command)?;
                    serde_json::to_value(McpServer::Stdio(
                        McpServerStdio::new(name, command)
                            .args(server.args)
                            .env(env_variables(server.env)),
                    ))
                    .map_err(|e| format!("serialize MCP stdio server: {e}"))?
                }
                "sse" | "streamable-http" | "http" => {
                    let url = server
                        .url
                        .ok_or_else(|| "HTTP MCP server requires url".to_string())?;
                    let parsed =
                        url::Url::parse(&url).map_err(|_| "invalid MCP URL".to_string())?;
                    if !matches!(parsed.scheme(), "http" | "https") {
                        return Err("MCP URL must use http or https".into());
                    }
                    let headers = http_headers(server.headers);
                    if transport == "sse" {
                        serde_json::to_value(McpServer::Sse(
                            McpServerSse::new(name, url).headers(headers),
                        ))
                        .map_err(|e| format!("serialize MCP sse server: {e}"))?
                    } else {
                        serde_json::to_value(McpServer::Http(
                            McpServerHttp::new(name, url).headers(headers),
                        ))
                        .map_err(|e| format!("serialize MCP http server: {e}"))?
                    }
                }
                // 2026-08-02：unreachable!() 改显式 Err——transport 已被上方白名单前置过滤，
                // 正常不可达，但未来改动过滤逻辑时不应成为生产 panic 点。
                _ => return Err(format!("unsupported MCP transport: {transport}")),
            };
            Ok(value)
        })
        .collect()
}

fn env_variables(env: HashMap<String, String>) -> Vec<EnvVariable> {
    env.into_iter()
        .map(|(name, value)| EnvVariable::new(name, value))
        .collect()
}

fn http_headers(headers: HashMap<String, String>) -> Vec<HttpHeader> {
    headers
        .into_iter()
        .map(|(name, value)| HttpHeader::new(name, value))
        .collect()
}

fn validate_text(field: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("MCP {field} cannot be empty"));
    }
    if value.len() > 4096 {
        return Err(format!("MCP {field} is too long"));
    }
    if value.contains('\0') {
        return Err(format!("MCP {field} contains NUL"));
    }
    Ok(())
}

fn validate_map(field: &str, values: &HashMap<String, String>) -> Result<(), String> {
    for (key, value) in values {
        validate_text(&format!("{field} key"), key)?;
        validate_text(field, value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(enabled: bool) -> McpServerConfig {
        McpServerConfig {
            id: Some("demo".into()),
            name: None,
            transport: "stdio".into(),
            enabled,
            command: Some("demo-mcp".into()),
            args: vec!["--stdio".into()],
            env: HashMap::new(),
            url: None,
            headers: HashMap::new(),
            oauth: None,
            disabled: false,
        }
    }

    #[test]
    fn disabled_servers_are_not_serialized() {
        assert!(validate_and_serialize(Some(vec![stdio(false)]))
            .unwrap()
            .is_empty());
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
    fn unnamed_servers_are_rejected() {
        // 官方 McpServer 要求 name（Hermes 严格必填；Peri 缺失被 DefaultOnError 跳过）
        let mut first = stdio(true);
        first.id = None;
        first.name = None;
        assert!(validate_and_serialize(Some(vec![first])).is_err());
    }

    #[test]
    fn same_server_id_and_name_are_not_duplicate() {
        // 核验修复：同一 server 的 id == name 只算一个身份（前端可能同时发 id+name）
        let mut server = stdio(true);
        server.id = Some("demo".into());
        server.name = Some("demo".into());
        assert!(
            validate_and_serialize(Some(vec![server])).is_ok(),
            "同 server id==name 不算重复"
        );
    }

    #[test]
    fn disabled_server_does_not_participate_in_dedup() {
        // 审查修复：禁用冲突 server 可作为"排除"途径（disabled 不进 wire 也不参与去重）
        let mut first = stdio(true);
        first.id = Some("shared".into());
        first.name = None;
        let mut second = stdio(false); // disabled
        second.id = Some("shared".into());
        second.name = None;
        assert!(
            validate_and_serialize(Some(vec![first, second])).is_ok(),
            "disabled 不参与去重"
        );
        // 两个启用中的冲突仍拒绝
        let mut first = stdio(true);
        first.id = Some("shared".into());
        first.name = None;
        let mut second = stdio(true);
        second.id = Some("shared".into());
        second.name = None;
        assert!(validate_and_serialize(Some(vec![first, second])).is_err());
    }

    #[test]
    fn name_falls_back_to_id() {
        // stdio() 构造 id=Some("demo") name=None → name 用 id 兜底
        let values = validate_and_serialize(Some(vec![stdio(true)])).unwrap();
        assert_eq!(values[0]["name"], "demo");
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
    fn oauth_config_is_validated_but_not_serialized_to_wire() {
        // 官方 schema 无 oauth 字段——OAuthConfig 仅前端表单使用，不进 wire
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
        let value = validate_and_serialize(Some(vec![server])).expect("valid HTTP server");
        assert_eq!(value[0]["type"], "http");
        assert!(
            value[0].get("oauth").is_none(),
            "oauth must not reach the wire"
        );
    }
}
