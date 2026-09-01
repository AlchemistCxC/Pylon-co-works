use super::*;
use std::collections::HashMap;
use std::path::Path;

/// 应用 agent 补丁（§5.3.A）：patch 为 agent 整块 YAML 字符串（前端 AgentConfigEditor
/// 形态）；仅替换目标 agent，默认禁止创建不存在 agent（产品拍板项，默认禁止）。
pub(crate) fn apply_agent_patch(
    content: &str,
    agent_id: &str,
    patch_yaml: &str,
) -> Result<String, ConfigError> {
    let mut document = parse_config_document(content)?;
    let agents = document
        .get_mut("agents")
        .and_then(|value| value.as_mapping_mut())
        .ok_or_else(|| ConfigError::Invalid("配置缺少 agents 段".to_string()))?;
    let key = agent_id.to_string();
    if !agents.contains_key(&key) {
        return Err(ConfigError::Invalid(format!(
            "agent {agent_id} 不存在（默认禁止创建，待拍板）"
        )));
    }
    let patch_value: serde_yml::Value = serde_yml::from_str(patch_yaml)
        .map_err(|error| ConfigError::Parse(format!("agent {agent_id} 补丁 YAML 非法: {error}")))?;
    agents.insert(key, patch_value);
    serde_yml::to_string(&document)
        .map_err(|error| ConfigError::Invalid(format!("配置序列化失败: {error}")))
}

/// 施工文档 §4.3.1：结构化字段 patch（scope="agent_fields"）。
/// patch 为前端 JSON 对象 `{ exe?, default?, name?, provider?, transport?, args? }`；
/// 只允许白名单字段，避免前端 DTO 不完整时丢失高级字段（acp/model/env 等保持原值）。
/// `default: true` 在同一候选内互斥更新：其他 agent 全部置 false，目标置 true。
pub(crate) fn apply_agent_field_patch(
    content: &str,
    agent_id: &str,
    patch: &serde_json::Value,
) -> Result<String, ConfigError> {
    let patch = patch.as_object().ok_or_else(|| {
        ConfigError::Invalid("scope=agent_fields 的 config 必须为 JSON 对象".to_string())
    })?;
    if patch.is_empty() {
        return Err(ConfigError::Invalid(
            "agent_fields 补丁不能为空".to_string(),
        ));
    }
    let mut unknown = patch
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "exe" | "default" | "name" | "provider" | "transport" | "args"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    unknown.sort();
    if !unknown.is_empty() {
        return Err(ConfigError::Invalid(format!(
            "agent_fields 不支持字段: {}",
            unknown.join(", ")
        )));
    }

    let mut document = parse_config_document(content)?;
    let agents = document
        .get_mut("agents")
        .and_then(|value| value.as_mapping_mut())
        .ok_or_else(|| ConfigError::Invalid("配置缺少 agents 段".to_string()))?;
    let key = agent_id.to_string();
    if !agents.contains_key(&key) {
        return Err(ConfigError::Invalid(format!(
            "agent {agent_id} 不存在（字段 patch 只更新已有 agent）"
        )));
    }

    // default=true 互斥更新：先清掉所有其他 agent 的 default，再按 patch 写入目标。
    if patch.get("default").and_then(|value| value.as_bool()) == Some(true) {
        for (other_id, value) in agents.iter_mut() {
            if other_id != &key {
                if let Some(mapping) = value.as_mapping_mut() {
                    mapping.insert("default".to_string(), serde_yml::Value::Bool(false));
                }
            }
        }
    }

    let target = agents
        .get_mut(&key)
        .and_then(|value| value.as_mapping_mut())
        .ok_or_else(|| ConfigError::Invalid(format!("agent {agent_id} 不是 mapping")))?;

    for (field, value) in patch {
        match field.as_str() {
            "exe" => {
                let text = value.as_str().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.exe 必须为字符串".to_string())
                })?;
                if text.trim().is_empty() {
                    return Err(ConfigError::Invalid(
                        "agent_fields.exe 不能为空".to_string(),
                    ));
                }
                target.insert(
                    "exe".to_string(),
                    serde_yml::Value::String(text.to_string()),
                );
            }
            "name" => {
                let text = value.as_str().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.name 必须为字符串".to_string())
                })?;
                if text.trim().is_empty() {
                    return Err(ConfigError::Invalid(
                        "agent_fields.name 不能为空".to_string(),
                    ));
                }
                target.insert(
                    "name".to_string(),
                    serde_yml::Value::String(text.to_string()),
                );
            }
            "transport" => {
                let text = value.as_str().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.transport 必须为字符串".to_string())
                })?;
                if text != "subprocess" {
                    return Err(ConfigError::Invalid(
                        "agent_fields.transport 只允许 subprocess".to_string(),
                    ));
                }
                target.insert(
                    "transport".to_string(),
                    serde_yml::Value::String(text.to_string()),
                );
            }
            "provider" => match value {
                serde_json::Value::Null => {
                    target.remove("provider");
                }
                serde_json::Value::String(text) if !text.trim().is_empty() => {
                    target.insert(
                        "provider".to_string(),
                        serde_yml::Value::String(text.trim().to_lowercase()),
                    );
                }
                _ => {
                    return Err(ConfigError::Invalid(
                        "agent_fields.provider 必须为字符串或 null".to_string(),
                    ))
                }
            },
            "default" => {
                let flag = value.as_bool().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.default 必须为 bool".to_string())
                })?;
                target.insert("default".to_string(), serde_yml::Value::Bool(flag));
            }
            "args" => {
                let args = value.as_array().ok_or_else(|| {
                    ConfigError::Invalid("agent_fields.args 必须为字符串数组".to_string())
                })?;
                let mut out = Vec::with_capacity(args.len());
                for item in args {
                    let text = item.as_str().ok_or_else(|| {
                        ConfigError::Invalid("agent_fields.args 必须为字符串数组".to_string())
                    })?;
                    out.push(serde_yml::Value::String(text.to_string()));
                }
                target.insert("args".to_string(), serde_yml::Value::Sequence(out));
            }
            other => {
                return Err(ConfigError::Invalid(format!(
                    "agent_fields 不支持字段: {other}"
                )))
            }
        }
    }

    serde_yml::to_string(&document)
        .map_err(|error| ConfigError::Invalid(format!("配置序列化失败: {error}")))
}

/// 新建 Agent（scope="agent_create"）。
/// `agent_config` 是单 Agent 的结构化 JSON node；完整 `{ agents: ... }` document
/// 只允许用于 initialize_agents_config，避免前后端 wire 语义混用产生嵌套配置。
pub(crate) fn apply_agent_create(
    content: &str,
    agent_id: &str,
    agent_config: &serde_json::Value,
) -> Result<String, ConfigError> {
    validate_agent_id(agent_id)?;
    let config_object = agent_config
        .as_object()
        .ok_or_else(|| ConfigError::Invalid(format!("agent {agent_id} 配置必须为结构化 object")))?;
    if config_object.contains_key("agents") {
        return Err(ConfigError::Invalid(format!(
            "agent {agent_id} 配置必须是单 Agent node，不能包含顶层 agents"
        )));
    }
    let mut document = parse_config_document(content)?;
    let agents = document
        .get_mut("agents")
        .and_then(|value| value.as_mapping_mut())
        .ok_or_else(|| ConfigError::Invalid("配置缺少 agents 段".to_string()))?;
    let key = agent_id.to_string();
    if agents.contains_key(&key) {
        return Err(ConfigError::Invalid(format!(
            "agent {agent_id} 已存在（新建不可覆盖）"
        )));
    }
    let patch_value = serde_yml::to_value(agent_config).map_err(|error| {
        ConfigError::Invalid(format!("agent {agent_id} 结构化配置转换失败: {error}"))
    })?;
    agents.insert(key, patch_value);
    serde_yml::to_string(&document)
        .map_err(|error| ConfigError::Invalid(format!("配置序列化失败: {error}")))
}

/// 将结构化的完整 `{ agents: ... }` document 序列化为配置文件内容。
/// 与 `apply_agent_create` 的单 Agent node interface 分离，避免 wire shape 混用。
pub(crate) fn serialize_agents_document(
    document: &serde_json::Value,
) -> Result<String, ConfigError> {
    let agents = document
        .get("agents")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            ConfigError::Invalid(
                "结构化 agents document 必须包含 object 类型的 agents 段".to_string(),
            )
        })?;
    if agents.is_empty() {
        return Err(ConfigError::Invalid(
            "结构化 agents document 的 agents 段不能为空".to_string(),
        ));
    }
    serde_yml::to_string(document).map_err(|error| {
        ConfigError::Invalid(format!("结构化 agents document 序列化失败: {error}"))
    })
}

/// 施工文档 §4.3.2：新建 Agent 的 id 字符规则。
pub(crate) fn validate_agent_id(agent_id: &str) -> Result<(), ConfigError> {
    let mut chars = agent_id.chars();
    let first_valid = chars
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false);
    let rest_valid = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !first_valid || !rest_valid || agent_id.is_empty() {
        return Err(ConfigError::Invalid(format!(
            "agent id {agent_id:?} 非法（须匹配 ^[a-zA-Z0-9][a-zA-Z0-9._-]*$）"
        )));
    }
    Ok(())
}

/// 应用 gateway 补丁（§5.3.A）：patch 为前端 JSON `{ gateway: { routes: [...] } }`；
/// 只允许 routes 键整段替换（显式 patch，不做不透明深 merge，保留 qq/inject 段）。
pub(crate) fn apply_gateway_patch(
    content: &str,
    patch: &serde_json::Value,
) -> Result<String, ConfigError> {
    let gateway = patch
        .get("gateway")
        .ok_or_else(|| ConfigError::Invalid("补丁缺少 gateway 段".to_string()))?;
    let routes = gateway
        .get("routes")
        .ok_or_else(|| ConfigError::Invalid("gateway 补丁缺少 routes".to_string()))?;
    let extra_keys = gateway
        .as_object()
        .map(|object| object.keys().filter(|key| *key != "routes").count())
        .unwrap_or(0);
    if extra_keys > 0 {
        return Err(ConfigError::Invalid(
            "gateway 补丁只允许 routes 键（防隐式深 merge）".to_string(),
        ));
    }
    // JSON → YAML Value：JSON 是合法 YAML 子集，经字符串往返转换。
    let routes_yaml: serde_yml::Value = serde_yml::from_str(
        &serde_json::to_string(routes)
            .map_err(|error| ConfigError::Invalid(format!("routes 序列化失败: {error}")))?,
    )
    .map_err(|error| ConfigError::Parse(format!("gateway routes 非法: {error}")))?;
    let mut document = parse_config_document(content)?;
    let mapping = document
        .as_mapping_mut()
        .ok_or_else(|| ConfigError::Invalid("配置顶层必须为 mapping".to_string()))?;
    let gateway_key = "gateway".to_string();
    if !mapping.contains_key(&gateway_key) {
        mapping.insert(
            gateway_key.clone(),
            serde_yml::Value::Mapping(serde_yml::Mapping::new()),
        );
    }
    let gateway_node = mapping
        .get_mut(&gateway_key)
        .ok_or_else(|| ConfigError::Invalid("gateway 段不可变".to_string()))?;
    let gateway_map = gateway_node
        .as_mapping_mut()
        .ok_or_else(|| ConfigError::Invalid("gateway 段非法".to_string()))?;
    gateway_map.insert("routes".to_string(), routes_yaml);
    serde_yml::to_string(&document)
        .map_err(|error| ConfigError::Invalid(format!("配置序列化失败: {error}")))
}

/// 候选配置双域校验（§5.3.A）：agents 经 parse_agents（A11 env/NUL、transport、
/// 空 name/exe 等），gateway 经 GatewayConfig::from_yaml_str；任一侧失败即 Err。
/// 返回解析后的 agents 表（写盘前 active agent 保护检查复用，避免二次解析）。
pub(crate) fn validate_candidate(
    content: &str,
    base_dir: Option<&Path>,
) -> Result<HashMap<String, AgentDef>, ConfigError> {
    let (agents, gateway) = parse_domains(content, base_dir);
    let agents = agents?;
    gateway?;
    Ok(agents)
}

/// 原子写入（§5.3.A）：唯一临时文件 + 写全 + sync_all + rename 覆盖；失败清理
/// 临时文件。与 export::write_export_atomically 的 create_new（拒绝覆盖）语义
/// 不同——本函数是替换目标语义。Windows rename 覆盖/目标占用返回明确错误。
pub(crate) fn write_config_atomically(path: &Path, content: &str) -> Result<(), ConfigError> {
    let temp = write_synced_temp(path, "tmp", content.as_bytes()).map_err(|error| {
        ConfigError::Write(format!("写配置临时文件 {} 失败: {error}", path.display()))
    })?;
    if let Err(error) = replace_file(&temp, path).and_then(|_| sync_parent(path)) {
        let _ = std::fs::remove_file(&temp);
        return Err(ConfigError::Write(format!(
            "写配置 {} 失败: {error}",
            path.display()
        )));
    }
    Ok(())
}

pub fn default_agent_id(agents: &HashMap<String, AgentDef>) -> Result<Option<String>, ConfigError> {
    let mut defaults: Vec<&String> = agents
        .iter()
        .filter(|(_, agent)| agent.default)
        .map(|(id, _)| id)
        .collect();
    if defaults.len() > 1 {
        defaults.sort();
        return Err(ConfigError::Invalid(format!(
            "multiple default agents configured: {}",
            defaults
                .iter()
                .map(|id| id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    if let Some(id) = defaults.pop() {
        return Ok(Some(id.clone()));
    }
    Ok(agents.keys().min().cloned())
}

