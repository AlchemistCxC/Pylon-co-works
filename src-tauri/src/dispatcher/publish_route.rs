//! SESSION_UPDATE 出站选路单点（#416 W2 步骤②自三处同构选路收口）：
//! 平台源判定与 Channel 查找各只出现一次。调用方：直发路径（mod.rs
//! handle_session_update）、canonical 批次 flush（canonical_flush.rs
//! `publish_committed_update`）、draft 片段发布（draft_flush.rs
//! `publish_draft_update`）。
//!
//! 收口契约（R2 精确化）：载荷富化（`source` 注入与 `canonicalEvent` /
//! `committedDraftId` / `draftChunk` 等扩展字段）**留在调用方**——三处富化
//! 各异且注入时机（`Arc::try_unwrap` 之后 / draft sanitized 副本）属表征；
//! send 失败仅告警、不中断（三处现行为一致，本函数取 void）。
//! 三处调用点的 send 失败日志文案现状已漂移（中文 / 英文 / draft 前缀），
//! 经 `channel_send_failure` 参数逐一保留——顺手统一文案属行为表征变化，
//! 不在本次范围。

/// SESSION_UPDATE 出站选路：平台源（`gateway.is_platform_source`）永远走
/// 广播路径——deliver_all 是其唯一出站通道，Channel 只服务 GUI 流式回显；
/// 即使未来误为平台源注册 channel 也不得截胡平台投递（防御深度，原
/// mod.rs 直发路径注释自本函数起单点化）。已注册 GUI source 走 Channel
/// 信封帧；未注册 source（平台会话 / 未升级前端）走 `emit_event_all`
/// 广播兜底（gateway.deliver_all 同源独立）。
pub(crate) fn publish_session_update<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    gateway: &crate::gateway::GatewayCore,
    update_channels: &crate::runtime::UpdateChannelMap,
    source: &str,
    payload: serde_json::Value,
    channel_send_failure: &str,
) {
    let channel = if gateway.is_platform_source(source) {
        None
    } else {
        update_channels
            .lock()
            .ok()
            .and_then(|map| map.get(source).cloned())
    };
    if let Some(channel) = channel {
        let frame = serde_json::json!({
            "event": crate::event_names::SESSION_UPDATE,
            "payload": payload,
        });
        if let Err(error) = channel.send(frame) {
            tracing::warn!("{channel_send_failure} source={source}: {error}");
        }
        return;
    }
    crate::emit_event_all(
        window,
        gateway,
        source,
        crate::event_names::SESSION_UPDATE,
        payload,
    );
}
