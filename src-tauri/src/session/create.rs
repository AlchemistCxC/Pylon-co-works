//! 会话创建域：槽位替换 / session/new / 建立与复用。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use super::*;
/// R32：会话槽位替换——上限检查 + 插入新 SessionInfo +
/// 返回被替换的旧会话（None = 新槽位）。`allow_same_source_replace`：
/// true = 同 source 替换不占新名额（load_persisted_session 既有语义）；
/// false = 满额即拒绝，无论是否替换（new_session 既有语义）。
/// G2-07：上限参数化（E9 拍板 per-agent——调用方传 SessionSlotPolicy::default()
/// 解析值，每 runtime 100；G1 acp.max_sessions 落地后按 agent 解析覆盖）。
/// 检查与插入在同一写锁内完成；会话创建路径由 session_creation 串行化，
/// 与原先"读锁检查 + 写锁插入"行为等价。
pub(crate) fn replace_session_slot(
    runtime: &AgentRuntime,
    source: &str,
    session: SessionInfo,
    allow_same_source_replace: bool,
    max_sessions: usize,
) -> Result<Option<SessionInfo>, PylonError> {
    // 方案 8：委托 SessionStore（满额策略 + mapping_ready 通知 + 锁序纪律）。
    crate::session_store::insert(
        runtime,
        source,
        session,
        allow_same_source_replace,
        max_sessions,
    )
    .map_err(|e| PylonError::Protocol(e.to_string()))
}

/// G2-04：会话建立结果——peri_id + 是否首轮 + session/new 原始响应（new_session 命令回传前端）。
pub(crate) struct SessionMapping {
    pub(crate) peri_id: String,
    pub(crate) is_first: bool,
    pub(crate) new_response: Option<serde_json::Value>,
}

/// Return a non-empty string from the common ACP scalar/nested value shapes.
/// Providers disagree on whether a selected value is encoded as a plain
/// string, `{value: ...}`, or `{valueId: {value: ...}}`; initial-session
/// negotiation must understand all of them without stringifying objects.
fn response_string(value: &serde_json::Value) -> Option<String> {
    super::value_as_string(value)
}

fn option_identity(option: &serde_json::Value) -> Option<String> {
    let object = option.as_object()?;
    let keys = [
        "configId", "config_id", "optionId", "option_id", "id", "key", "name",
    ];
    keys.into_iter().find_map(|wanted| {
        object
            .iter()
            .find(|(key, _)| {
                key.replace(['-', ' '], "_")
                    .chars()
                    .flat_map(char::to_lowercase)
                    .collect::<String>()
                    == wanted
                        .replace(['-', ' '], "_")
                        .chars()
                        .flat_map(char::to_lowercase)
                        .collect::<String>()
            })
            .and_then(|(_, value)| response_string(value))
    })
}

fn option_text(option: &serde_json::Value) -> String {
    [
        "id",
        "key",
        "configId",
        "config_id",
        "optionId",
        "option_id",
        "name",
        "label",
        "title",
        "description",
        "category",
        "semantic",
        "valueType",
        "value_type",
    ]
    .into_iter()
    .filter_map(|key| option.get(key).and_then(response_string))
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
}

fn option_choices(option: &serde_json::Value) -> Vec<String> {
    // ACP implementations have used each of these names in the wild.  The
    // recursive walk also handles a JSON-schema `{schema: {enum: [...]}}`.
    fn collect(value: &serde_json::Value, depth: usize, out: &mut Vec<String>) {
        if depth > 4 {
            return;
        }
        if let Some(values) = value.as_array() {
            for item in values {
                if let Some(choice) = response_string(item) {
                    out.push(choice);
                }
            }
            return;
        }
        let Some(object) = value.as_object() else {
            return;
        };
        for key in [
            "options", "choices", "values", "available", "enum", "items", "schema",
            "optionValues", "option_values",
        ] {
            if let Some(nested) = object.get(key) {
                collect(nested, depth + 1, out);
            }
        }
    }

    let mut values = Vec::new();
    collect(option, 0, &mut values);
    values.sort();
    values.dedup();
    values
}

/// Locate a writable reasoning/thinking config option advertised by an ACP
/// agent.  `None` deliberately means "capability not advertised"; callers
/// must not turn the Hermes permission modes into a fake thinking setting.
/// When choices are advertised, the requested wire id must be one of them.
pub(crate) fn find_reasoning_option_id(
    options: &[serde_json::Value],
    requested: &str,
) -> Option<String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return None;
    }
    fn comparable(value: &str) -> String {
        value
            .chars()
            .filter(|character| character.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    }
    fn score(option: &serde_json::Value) -> i32 {
        let object = match option.as_object() {
            Some(object) => object,
            None => return 0,
        };
        let mut score = 0;
        for key in ["configId", "config_id", "optionId", "option_id", "id", "key"] {
            if let Some(value) = object.get(key).and_then(response_string) {
                let token = comparable(&value);
                if [
                    "reasoning", "reasoningeffort", "thinking", "thought", "thoughtlevel", "effort",
                ]
                .iter()
                .any(|marker| token == *marker)
                {
                    score = score.max(100);
                } else if ["reason", "think", "thought", "effort"]
                    .iter()
                    .any(|marker| token.contains(marker))
                {
                    score = score.max(70);
                }
            }
        }
        for key in ["category", "name", "label", "title", "description", "semantic"] {
            if let Some(value) = object.get(key).and_then(response_string) {
                let token = comparable(&value);
                if [
                    "reasoning", "reasoningeffort", "thinking", "thought", "thoughtlevel", "effort",
                ]
                .iter()
                .any(|marker| token == *marker)
                {
                    score = score.max(80);
                } else if ["reason", "think", "thought", "effort"]
                    .iter()
                    .any(|marker| token.contains(marker))
                {
                    score = score.max(50);
                }
            }
        }
        // A temperature/tuning slider is not a thinking level even when its
        // presentation label happens to contain the word "reasoning".
        if object
            .iter()
            .filter_map(|(_, value)| value.as_str())
            .any(|value| comparable(value).contains("temperature"))
            && score < 100
        {
            score -= 30;
        }
        score
    }
    let mut candidates: Vec<(i32, usize, String)> = options
        .iter()
        .enumerate()
        .filter_map(|(index, option)| {
        let object = option.as_object()?;
        let semantic = option_text(option);
        let semantic_match = [
            "reason", "reasoning", "think", "thinking", "thought", "effort", "推理", "思考",
        ]
        .iter()
        .any(|marker| semantic.contains(marker));
        let rank = score(option);
        if !semantic_match && rank <= 0 {
            return None;
        }
        let read_only = ["readOnly", "readonly", "read_only"]
            .into_iter()
            .any(|key| object.get(key).and_then(serde_json::Value::as_bool) == Some(true))
            || object.get("editable").and_then(serde_json::Value::as_bool) == Some(false);
        if read_only {
            return None;
        }
        let id = option_identity(option)?;
        let choices = option_choices(option);
        if !choices.is_empty()
            && !choices.iter().any(|choice| {
                comparable(choice) == comparable(requested)
            })
        {
            return None;
        }
        Some((rank.max(1), index, id))
    })
        .collect();
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    candidates.into_iter().next().map(|(_, _, id)| id)
}

fn merge_response_value(base: &mut serde_json::Value, patch: serde_json::Value) {
    let (Some(base_object), Some(patch_object)) = (base.as_object_mut(), patch.as_object()) else {
        *base = patch;
        return;
    };
    for (key, value) in patch_object {
        // An empty configOptions response is common for set_model/set_mode;
        // retaining the session/new catalogue avoids erasing selectors.
        if key == "configOptions"
            && value.as_array().is_some_and(|values| values.is_empty())
            && base_object
                .get(key)
                .and_then(serde_json::Value::as_array)
                .is_some_and(|values| !values.is_empty())
        {
            continue;
        }
        if let Some(existing) = base_object.get_mut(key) {
            if existing.is_object() && value.is_object() {
                merge_response_value(existing, value.clone());
                continue;
            }
        }
        base_object.insert(key.clone(), value.clone());
    }
}

fn set_response_current(response: &mut serde_json::Value, section: &str, key: &str, value: &str) {
    let Some(root) = response.as_object_mut() else {
        return;
    };
    let section_value = root
        .entry(section.to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(section_object) = section_value.as_object_mut() {
        section_object.insert(key.to_string(), serde_json::Value::String(value.to_string()));
    }
}

fn set_config_option_current(response: &mut serde_json::Value, key: &str, value: &str) {
    let options_value = if response.get("configOptions").is_some() {
        response.get_mut("configOptions")
    } else {
        response.get_mut("config_options")
    };
    let Some(options) = options_value.and_then(serde_json::Value::as_array_mut) else {
        return;
    };
    for option in options {
        let matches = option_identity(option)
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(key));
        if matches {
            if let Some(object) = option.as_object_mut() {
                object.insert(
                    "currentValue".to_string(),
                    serde_json::Value::String(value.to_string()),
                );
            }
            break;
        }
    }
}

fn merge_setting_response(
    response: &mut serde_json::Value,
    setting_response: serde_json::Value,
    section: &str,
    current_key: &str,
    option_key: &str,
    value: &str,
) {
    merge_response_value(response, setting_response);
    set_response_current(response, section, current_key, value);
    set_config_option_current(response, option_key, value);
}

fn merge_config_setting_response(
    response: &mut serde_json::Value,
    setting_response: serde_json::Value,
    option_key: &str,
    value: &str,
) {
    merge_response_value(response, setting_response);
    set_config_option_current(response, option_key, value);
}

fn advertised_config_option_id(response: &serde_json::Value, semantic: &str) -> Option<String> {
    let options = response
        .get("configOptions")
        .or_else(|| response.get("config_options"))
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    super::find_config_option(options, semantic).and_then(option_identity)
}

/// Apply the optional values selected in the empty-state control center.  The
/// operation is intentionally atomic from the caller's perspective: a failed
/// setting RPC is returned so the newly-created remote session can be closed
/// before any local mapping is published.
async fn apply_initial_session_options(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    peri_id: &str,
    generation: u64,
    response: &mut serde_json::Value,
    initial_model: Option<&str>,
    initial_reasoning: Option<&str>,
    initial_mode: Option<&str>,
) -> Result<(), PylonError> {
    if let Some(model) = initial_model.map(str::trim).filter(|value| !value.is_empty()) {
        let target = state
            .protocol_for_runtime(runtime)
            .set_model_api()
            .route("model");
        let (method, params) = match target {
            crate::agent_config::ModelSwitchTarget::SetModel => (
                acp::METHOD_SESSION_SET_MODEL,
                acp::session_set_model_params(peri_id, model).map_err(PylonError::Protocol)?,
            ),
            crate::agent_config::ModelSwitchTarget::ConfigOption => {
                let config_id = advertised_config_option_id(response, "model").ok_or_else(|| {
                    PylonError::Protocol(
                        "model config option is not advertised by the ACP agent".to_string(),
                    )
                })?;
                (
                    acp::METHOD_SESSION_SET_CONFIG_OPTION,
                    acp::session_set_config_option_params(
                        peri_id,
                        &config_id,
                        &serde_json::Value::String(model.to_string()),
                    )
                    .map_err(PylonError::Protocol)?,
                )
            },
            crate::agent_config::ModelSwitchTarget::Disabled => {
                return Err(PylonError::Protocol(
                    "model switching disabled by agent configuration".to_string(),
                ));
            }
        };
        let setting_response = state
            .acp_rpc_generation_checked(runtime, method, params, generation)
            .await
            .map_err(PylonError::from)?;
        state
            .ensure_generation(runtime, generation)
            .map_err(PylonError::Protocol)?;
        let model_option_key = if target == crate::agent_config::ModelSwitchTarget::ConfigOption {
            advertised_config_option_id(response, "model").unwrap_or_else(|| "model".to_string())
        } else {
            "model".to_string()
        };
        merge_setting_response(
            response,
            setting_response,
            "models",
            "currentModelId",
            &model_option_key,
            model,
        );
    }

    if let Some(mode) = initial_mode.map(str::trim).filter(|value| !value.is_empty()) {
        let params = acp::session_set_mode_params(peri_id, mode).map_err(PylonError::Protocol)?;
        let setting_response = state
            .acp_rpc_generation_checked(
                runtime,
                acp::METHOD_SESSION_SET_MODE,
                params,
                generation,
            )
            .await
            .map_err(PylonError::from)?;
        state
            .ensure_generation(runtime, generation)
            .map_err(PylonError::Protocol)?;
        merge_setting_response(
            response,
            setting_response,
            "modes",
            "currentModeId",
            "mode",
            mode,
        );
    }

    if let Some(reasoning) = initial_reasoning.map(str::trim).filter(|value| !value.is_empty()) {
        let options = response
            .get("configOptions")
            .or_else(|| response.get("config_options"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if let Some(option_id) = find_reasoning_option_id(options, reasoning) {
            let params = acp::session_set_config_option_params(
                peri_id,
                &option_id,
                &serde_json::Value::String(reasoning.to_string()),
            )
            .map_err(PylonError::Protocol)?;
            let setting_response = state
                .acp_rpc_generation_checked(
                    runtime,
                    acp::METHOD_SESSION_SET_CONFIG_OPTION,
                    params,
                    generation,
                )
                .await
                .map_err(PylonError::from)?;
            state
                .ensure_generation(runtime, generation)
                .map_err(PylonError::Protocol)?;
            merge_config_setting_response(
                response,
                setting_response,
                &option_id,
                reasoning,
            );
        } else {
            // Hermes currently exposes permission modes and model state, but
            // no ACP reasoning/thinking option.  Do not send a made-up config
            // id (which would look successful while changing nothing).
            tracing::warn!(
                source = source,
                requested = reasoning,
                "initial reasoning level is not advertised by the ACP agent; skipped"
            );
            state.log_runtime_summary(
                "warn",
                "session",
                Some(source.to_string()),
                "Initial reasoning level was not advertised by the ACP agent; skipped",
                serde_json::Map::from_iter([
                    ("requested".to_string(), serde_json::Value::String(reasoning.to_string())),
                    ("code".to_string(), serde_json::Value::String("reasoning_not_advertised".to_string())),
                ]),
            );
        }
    }
    Ok(())
}

/// G2-04：无条件建会话——上限检查 + session/new RPC + ensure_generation +
/// SessionInfo 构造 + apply_session_response + replace_session_slot（notify 唯一出口）+
/// 可选 close 被替换旧会话（new_session 语义；E7 拍板：ensure 路径也传 true）。
/// 调用方必须持有 runtime.session_creation 锁（并发建会话串行化，覆盖"检查 +
/// RPC + 插入"全程；tokio Mutex 不可重入，本函数内部不取锁）；RPC await 期间
/// 不持 sessions 锁（V14），await 后 ensure_generation（RPC 后位置不变量）。
/// "Session creation failed" 日志在本函数内发出（唯一出口）。
async fn create_session_slot(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    profile_id: Option<&str>,
    persona: &str,
    session_cwd: &str,
    workspace_id: Option<String>,
    wire_mcp_servers: &[serde_json::Value],
    initial_model: Option<&str>,
    initial_reasoning: Option<&str>,
    initial_mode: Option<&str>,
    close_replaced: bool,
) -> Result<SessionMapping, PylonError> {
    {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= crate::agent_runtime::SessionSlotPolicy::default().max_sessions {
            return Err(PylonError::Protocol("max sessions reached".to_string()));
        }
    }
    let generation = state.current_generation(runtime);
    // G2-07：McpServersMode 消费（G1 入口，E4 警告语义见 acp.rs 构造器 doc）——
    // per-agent 协议配置解析，缺省 Always = 现状 wire；OmitIfEmpty 显式删键（v2 语义）。
    let params = acp::session_new_params(
        session_cwd,
        wire_mcp_servers.to_vec(),
        state.protocol_for_runtime(runtime).mcp_servers,
    )?;
    let mut response = match state
        .acp_rpc(runtime, acp::METHOD_SESSION_NEW, params)
        .await
    {
        Ok(response) => response,
        Err(error) => {
            state.log_runtime_summary(
                "error",
                "session",
                Some(source.to_string()),
                "Session creation failed",
                serde_json::Map::new(),
            );
            return Err(error.into());
        }
    };
    state.ensure_generation(runtime, generation)?;
    let peri_id = crate::acp::session_id_from(&response)?;
    if initial_model.is_some() || initial_reasoning.is_some() || initial_mode.is_some() {
        if let Err(error) = apply_initial_session_options(
            state,
            runtime,
            source,
            &peri_id,
            generation,
            &mut response,
            initial_model,
            initial_reasoning,
            initial_mode,
        )
        .await
        {
            let _ = close_session_rpc(state, runtime, &peri_id, generation, false).await;
            return Err(error);
        }
    }
    let mut session = SessionInfo::new(
        peri_id.clone(),
        persona.to_string(),
        session_cwd.to_string(),
        false,
        generation,
    );
    session.profile_id = profile_id.map(str::to_string);
    // CWD-03：Workspace 绑定（方案 C；None = legacy 未绑定，root 解析回退 cwd）。
    session.workspace_id = workspace_id;
    session.apply_session_response(&response);
    restore_session_state(&session, &mut response);
    let replaced = replace_session_slot(
        runtime,
        source,
        session,
        false,
        crate::agent_runtime::SessionSlotPolicy::default().max_sessions,
    )?;
    let attached = crate::session_store::mark_attached_if_current(
        runtime, source, &peri_id, generation, generation,
    )
    .map_err(|error| PylonError::Protocol(error.to_string()))?;
    if !attached {
        return Err(PylonError::Protocol(format!(
            "stale session mapping for source: {source}"
        )));
    }
    if close_replaced {
        if let Some(old) = replaced {
            // 方案 6：统一 close RPC 入口（LocalFirstBestEffort，吞错误）。
            let _ = close_session_rpc(state, runtime, &old.peri_id, generation, false).await;
        }
    }
    Ok(SessionMapping {
        peri_id,
        is_first: true,
        new_response: Some(response),
    })
}

/// G2-04：会话建立/复用——已有映射则复用（返回 is_first = !has_first_prompt），
/// 否则走 create_session_slot（E7 拍板：自动建会话覆盖旧映射时 close 旧 peri，
/// close_replaced 传 true——覆盖场景仅并发 replace 返回 Some 的幽灵映射）。
/// 调用方须已持有该 source 的 prompt 锁（send_prompt_core 路径）。
pub(crate) async fn ensure_session_mapping(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    profile_id: Option<&str>,
    persona: &str,
    session_cwd: &str,
    wire_mcp_servers: &[serde_json::Value],
) -> Result<SessionMapping, PylonError> {
    let _creation_guard = runtime.session_creation.lock().await;
    if let Some(health) = runtime
        .binding_health
        .lock()
        .map_err(|error| error.to_string())?
        .get(source)
        .cloned()
    {
        let unavailable = match health {
            crate::agent_runtime::SessionBindingHealth::Attached { .. } => None,
            crate::agent_runtime::SessionBindingHealth::Probing { .. } => Some("probing"),
            crate::agent_runtime::SessionBindingHealth::Detached { .. } => Some("detached"),
        };
        if let Some(health) = unavailable {
            return Err(PylonError::SessionBindingUnavailable {
                session_source: source.to_string(),
                health: health.to_string(),
            });
        }
    }
    // G2-08 锁合并：消息到达即活动（B10.3b 会话超时判定）——updated_at 刷新与
    // 存在性读取合并为 guard 内一次 sessions.lock()（每消息 7 处 sessions 锁降为
    // 6 处）。行为差异（E10 已拍板）：crashed 早退路径不再刷新 updated_at。
    let existing = {
        let mut sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get_mut(source) {
            session.attach_profile_id(profile_id, source)?;
            session.updated_at = Some(Timestamp::now());
            Some((session.peri_id.clone(), !session.has_first_prompt))
        } else {
            None
        }
    };
    if let Some((peri_id, is_first)) = existing {
        return Ok(SessionMapping {
            peri_id,
            is_first,
            new_response: None,
        });
    }
    create_session_slot(
        state,
        runtime,
        source,
        profile_id,
        persona,
        session_cwd,
        None,
        wire_mcp_servers,
        None,
        None,
        None,
        true,
    )
    .await
}

/// G2-02：load_persisted_session 失败恢复去重——锁 sessions → 复核映射
/// （(peri_id, generation) 匹配）→ 有 previous 则 insert 否则 remove。
/// 调用方不得持有 sessions 锁（E5 锁序纪律：sessions → prompt_locks 单向）。
/// 错误传播：锁错误经 String → PylonError::Protocol（与调用方原样语义一致）。
pub(crate) fn restore_previous_slot(
    runtime: &AgentRuntime,
    source: &str,
    peri_id: &str,
    generation: u64,
    previous: Option<SessionInfo>,
) -> Result<(), PylonError> {
    let mut sessions = runtime
        .sessions
        .lock()
        .map_err(|lock_error| lock_error.to_string())?;
    if sessions.get(source).map(|session| {
        session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
    }) == Some(true)
    {
        if let Some(previous) = previous {
            sessions.insert(source.to_string(), previous);
        } else {
            sessions.remove(source);
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn new_session(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    source: String,
    profile_id: String,
    persona: String,
    cwd: Option<String>,
    workspace_id: Option<String>,
    mcp_servers: Option<Vec<crate::mcp::McpServerConfig>>,
    model: Option<String>,
    reasoning_level: Option<String>,
    mode: Option<String>,
) -> Result<serde_json::Value, PylonError> {
    DurableSessionOwner::new(&profile_id, &agent_id, &source).validate()?;
    // OWNER-02（§5.8）：显式 agentId 路由到 owner runtime——建会话前本地映射必不存在，
    // 故只要求 agent runtime 存在（不要求会话已存在）；不存在 owner runtime →
    // agent_runtime_unavailable，绝不 fallback active runtime。
    let runtime = state.inner().resolve_agent_runtime(&agent_id)?;
    // B1：GUI 不得冒名平台源——is_platform_source（注册适配器 OR 绑定命中）且
    // 无 binding → 拒绝（防会话建立后出站投递到 QQ）。G4 §3-9（C3）：E14 语义——
    // QQ 适配器未注册时 qq:* 未绑定源放行（无注册 = 无投递路径，安全等价，见
    // gateway/mod.rs is_platform_source doc）。
    if state.gateway.is_platform_source(&source) && state.gateway.binding(&source).is_none() {
        return Err(PylonError::Protocol(format!(
            "invalid GUI source: {source}"
        )));
    }
    state.inner().log_runtime_summary(
        "info",
        "session",
        Some(source.clone()),
        "Session creation started",
        serde_json::Map::new(),
    );
    let _creation_guard = runtime.session_creation.lock().await;
    // CWD-03：Workspace 绑定优先（root_path 单一来源）；未绑定走 cwd 缺省链。
    let (session_cwd, workspace_id) =
        crate::workspaces::resolve_session_cwd(state.inner(), cwd, workspace_id)?;
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    // G2-04：会话建立收敛——守卫/上限/RPC/构造/插入（notify 唯一出口）/
    // close 旧会话全部收敛进 create_session_slot（close_replaced=true，new_session 语义）。
    let mapping = create_session_slot(
        state.inner(),
        &runtime,
        &source,
        Some(&profile_id),
        &persona,
        &session_cwd,
        workspace_id,
        &mcp_servers,
        model.as_deref(),
        reasoning_level.as_deref(),
        mode.as_deref(),
        true,
    )
    .await?;
    state.inner().log_runtime_summary(
        "info",
        "session",
        Some(source.clone()),
        "Session creation succeeded",
        serde_json::Map::new(),
    );
    // Return full response so frontend gets modes + configOptions + sessionId
    Ok(mapping
        .new_response
        .expect("create_session_slot 必返回 session/new 原始响应"))
}

#[cfg(test)]
mod initial_option_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reasoning_option_requires_advertised_semantic_id_and_choice() {
        let options = vec![
            json!({
                "id": "temperature",
                "label": "Reasoning temperature",
                "type": "select",
                "options": [{"id": "0.2"}, {"id": "0.8"}]
            }),
            json!({
                "id": "reasoning_effort",
                "label": "Reasoning effort",
                "type": "select",
                "options": [{"id": "low"}, {"id": "high"}]
            }),
        ];
        assert_eq!(
            find_reasoning_option_id(&options, "high").as_deref(),
            Some("reasoning_effort")
        );
        assert_eq!(
            find_reasoning_option_id(&options, "medium"),
            None,
            "requested value outside provider choices must not be sent"
        );
    }

    #[test]
    fn reasoning_option_skips_unadvertised_or_read_only_values() {
        assert_eq!(
            find_reasoning_option_id(
                &[json!({"id": "reasoning", "label": "Thinking", "editable": false})],
                "high",
            ),
            None
        );
        assert_eq!(find_reasoning_option_id(&[], "high"), None);
    }

    #[test]
    fn reasoning_option_accepts_snake_case_config_catalog() {
        let response = json!({
            "config_options": [{
                "config_id": "thinking_level",
                "label": "Thinking level",
                "choices": [{"value": "low"}, {"value": "xhigh"}]
            }]
        });
        let options = response
            .get("configOptions")
            .or_else(|| response.get("config_options"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        assert_eq!(
            find_reasoning_option_id(options, "xhigh").as_deref(),
            Some("thinking_level")
        );
    }

    #[test]
    fn setting_response_merge_preserves_catalog_and_updates_current_values() {
        let mut response = json!({
            "sessionId": "session-1",
            "models": {
                "availableModels": [{"modelId": "openrouter:old", "name": "old"}],
                "currentModelId": "openrouter:old"
            },
            "modes": {
                "availableModes": [{"id": "default", "name": "Default"}],
                "currentModeId": "default"
            },
            "configOptions": [{"id": "model", "currentValue": "old"}]
        });
        merge_setting_response(
            &mut response,
            json!({"models": {"currentModelId": "openrouter:new"}}),
            "models",
            "currentModelId",
            "model",
            "openrouter:new",
        );
        merge_setting_response(
            &mut response,
            json!({}),
            "modes",
            "currentModeId",
            "mode",
            "accept_edits",
        );
        assert_eq!(response["models"]["currentModelId"], "openrouter:new");
        assert_eq!(response["modes"]["currentModeId"], "accept_edits");
        assert_eq!(response["models"]["availableModels"][0]["modelId"], "openrouter:old");
        assert_eq!(response["configOptions"][0]["currentValue"], "openrouter:new");
    }
}
