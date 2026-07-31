//! QQ 平台适配器（B10.1 骨架 + B10.2 组装：入站去重/ingest + 出站文本投递）。

pub mod auth;
pub mod dedup;
pub mod events;
pub mod send;
pub mod types;
pub mod ws;

use std::sync::{Arc, Mutex};

use dedup::DedupState;
use reqwest::Client;

use crate::gateway::{GatewayCore, PlatformAdapter, ResolvedIngest};

use self::auth::QqAuth;

/// QQ 平台单条文本上限（字符，Hermes MAX_MESSAGE_LENGTH 实证值）。
const QQ_MAX_MESSAGE_LEN: usize = 4000;

/// QQ 适配器：入站（handle_incoming）去重后进入 gateway.ingest；
/// 出站 deliver 文本经 send.rs 发送（truncate 分段已在 GatewayCore 核心层完成）。
pub struct QqAdapter {
    dedup: Mutex<DedupState>,
    core: Arc<GatewayCore>,
    http: Client,
    auth: Arc<QqAuth>,
}

/// 从 gateway source 解析 QQ 目标：`qq:group:123` → (group, 123)；`qq:user:456` → (c2c, 456)。
pub fn parse_source(source: &str) -> Result<(&str, &str), String> {
    let mut parts = source.splitn(3, ':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("qq"), Some(kind @ ("group" | "user")), Some(id)) if !id.is_empty() => {
            Ok((if kind == "group" { "group" } else { "c2c" }, id))
        }
        _ => Err(format!("无法解析 QQ source: {source}")),
    }
}

impl QqAdapter {
    /// 构造适配器（B10.2 由 run() 凭据配置创建并注册进 GatewayCore）。
    pub fn new(core: Arc<GatewayCore>, http: Client, auth: Arc<QqAuth>) -> Arc<Self> {
        Arc::new(Self {
            dedup: Mutex::new(DedupState::new()),
            core,
            http,
            auth,
        })
    }

    /// 入站入口：白名单 → 去重 → 路由解析 → dispatch（ACP 发送）。
    ///
    /// 核验修复：白名单先于 seen 记录——被白名单拒绝的消息不占去重窗口，
    /// 之后白名单放宽时同一消息重放仍可正常处理（消息从未真正 ingest 过）。
    /// - 白名单拒绝 → Ok(None)，不 dispatch
    /// - msg_id 已见（resume 重放）→ Ok(None)，不重复 ingest
    /// - 新消息 → 记录 seen + last_msg_id，dispatch 发送并返回解析结果
    /// ws.rs 事件分发后调用本方法；去重/白名单在适配器层完成，ingest 层只见干净消息。
    pub fn handle_incoming(
        &self,
        source: &str,
        msg_id: &str,
        content: &str,
        member_openid: Option<&str>,
        user_openid: Option<&str>,
    ) -> Result<Option<ResolvedIngest>, String> {
        let resolved = self.core.ingest(source, content)?;
        if !crate::gateway::ingest_allowed(
            self.core.qq_config(),
            resolved.binding.as_ref(),
            source,
            member_openid,
            user_openid,
        ) {
            return Ok(None);
        }
        let mut dedup = self.dedup.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !dedup.is_new(msg_id) {
            return Ok(None);
        }
        if let Some(chat_id) = source.rsplit(':').next() {
            dedup.set_latest(chat_id, msg_id);
        }
        drop(dedup);
        self.core.dispatch_ingest(&resolved);
        Ok(Some(resolved))
    }
}

impl PlatformAdapter for QqAdapter {
    fn platform_key(&self) -> &str {
        "qq"
    }

    fn max_message_len(&self) -> usize {
        QQ_MAX_MESSAGE_LEN
    }

    /// 投递文本（已分段）：拿 token → send_message。发送失败只告警（不阻断 WebView 事件）。
    /// deliver_event（done/error）首版不投平台，记录日志。
    fn deliver_text(&self, source: &str, text: &str) -> Result<(), String> {
        let (chat_type, chat_id) = parse_source(source)?;
        let http = self.http.clone();
        let auth = self.auth.clone();
        let text = text.to_string();
        let chat_type = chat_type.to_string();
        let chat_id = chat_id.to_string();
        tokio::spawn(async move {
            match auth.get_token().await {
                Ok(token) => match send::send_message(
                    &http,
                    types::API_BASE,
                    &token,
                    &chat_id,
                    &chat_type,
                    &text,
                    None,
                    types::MSG_TYPE_TEXT,
                )
                .await
                {
                    Ok(_) => {}
                    Err(error) => log::warn!("QQ deliver 发送失败: {error}"),
                },
                Err(error) => log::warn!("QQ deliver token 获取失败: {error}"),
            }
        });
        Ok(())
    }

    fn deliver_event(&self, source: &str, event: &str, _payload: &serde_json::Value) -> Result<(), String> {
        log::info!("QQ deliver_event 未投递（首版仅文本）: {source} event={event}");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core_with_route() -> Arc<GatewayCore> {
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#;
        Arc::new(GatewayCore::from_config(
            crate::gateway::route::parse_config(yaml).expect("合法路由配置"),
        ))
    }

    fn test_adapter(core: Arc<GatewayCore>) -> Arc<QqAdapter> {
        let auth = Arc::new(QqAuth::new(
            Client::new(),
            "test-app".to_string(),
            "test-secret".to_string(),
        ));
        QqAdapter::new(core, Client::new(), auth)
    }

    #[test]
    fn parse_source_accepts_group_and_user_shapes() {
        assert_eq!(parse_source("qq:group:123"), Ok(("group", "123")));
        assert_eq!(parse_source("qq:user:456"), Ok(("c2c", "456")));
        assert!(parse_source("qq:unknown:1").is_err());
        assert!(parse_source("qq:group:").is_err());
        assert!(parse_source("local").is_err());
        assert!(parse_source("wechat:group:1").is_err());
    }

    #[test]
    fn handle_incoming_resolves_route_and_records_latest_msg() {
        let core = core_with_route();
        let adapter = test_adapter(core);
        let resolved = adapter
            .handle_incoming("qq:group:123", "msg-1", "你好", None, None)
            .expect("ingest must resolve")
            .expect("新消息必须返回解析结果");
        assert_eq!(resolved.source, "qq:group:123");
        assert_eq!(resolved.content, "你好");
        assert_eq!(resolved.binding.as_ref().unwrap().agent_id, "peri");
    }

    #[test]
    fn replayed_msg_id_is_dropped_without_ingest() {
        let core = core_with_route();
        let adapter = test_adapter(core);
        adapter.handle_incoming("qq:group:123", "msg-1", "first", None, None).expect("first ingest");
        let replay = adapter
            .handle_incoming("qq:group:123", "msg-1", "first replay", None, None)
            .expect("replay must be handled");
        assert!(replay.is_none(), "重复 msg_id 必须丢弃（resume 重放保护）");
    }

    #[test]
    fn replayed_msg_id_after_window_eviction_is_new_again() {
        let core = core_with_route();
        let adapter = test_adapter(core);
        // 填满 dedup 窗口再插一条，把 msg-0 挤出
        for i in 0..=dedup::DedupState::new().window_capacity() {
            let msg = format!("msg-{i}");
            let _ = adapter.handle_incoming("qq:group:123", &msg, "x", None, None);
        }
        let replayed = adapter.handle_incoming("qq:group:123", "msg-0", "x", None, None).expect("ingest");
        assert!(replayed.is_some(), "窗口挤出后 msg-0 应重新可见");
    }

    #[test]
    fn empty_source_is_rejected() {
        let core = core_with_route();
        let adapter = test_adapter(core);
        let error = adapter.handle_incoming("", "msg-1", "x", None, None).expect_err("空 source 必须拒绝");
        assert!(error.contains("source"));
    }

    #[test]
    fn member_allowlist_rejects_stranger_group_message() {
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      allow_from: [member-1]
"#;
        let core = Arc::new(GatewayCore::from_config(
            crate::gateway::route::parse_config(yaml).expect("合法路由配置"),
        ));
        let adapter = test_adapter(core);
        let allowed = adapter
            .handle_incoming("qq:group:123", "msg-ok", "hi", Some("member-1"), None)
            .expect("ingest")
            .expect("白名单成员必须放行");
        assert_eq!(allowed.source, "qq:group:123");
        let rejected = adapter
            .handle_incoming("qq:group:123", "msg-no", "hi", Some("stranger"), None)
            .expect("ingest");
        assert!(rejected.is_none(), "非白名单成员必须丢弃");
    }

    #[test]
    fn allowlisted_rejected_message_is_reprocessable_on_replay() {
        // 核验修复：白名单拒绝的消息不占去重窗口——之后白名单通过时同一 msg_id 可处理
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      allow_from: [member-1]
"#;
        let core = Arc::new(GatewayCore::from_config(
            crate::gateway::route::parse_config(yaml).expect("合法路由配置"),
        ));
        let adapter = test_adapter(core);
        // stranger 发送 → 白名单拒绝（不记 seen）
        let rejected = adapter
            .handle_incoming("qq:group:123", "msg-1", "hi", Some("stranger"), None)
            .expect("ingest");
        assert!(rejected.is_none());
        // 同一 msg_id 由白名单成员重放 → 应正常处理（未被 seen 窗口吞掉）
        let reprocessed = adapter
            .handle_incoming("qq:group:123", "msg-1", "hi", Some("member-1"), None)
            .expect("ingest")
            .expect("白名单通过后同一消息必须可处理");
        assert_eq!(reprocessed.source, "qq:group:123");
        // 处理过之后再次重放 → 去重丢弃
        let replay = adapter
            .handle_incoming("qq:group:123", "msg-1", "hi", Some("member-1"), None)
            .expect("ingest");
        assert!(replay.is_none(), "已处理消息重放必须去重");
    }

    #[test]
    fn group_allowlist_rejects_unlisted_group() {
        let yaml = r#"
gateway:
  qq:
    group_allow_from: [group-a]
  routes:
    - source: qq:group:group-b
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let core = Arc::new(GatewayCore::from_config(
            crate::gateway::route::parse_config(yaml).expect("合法路由配置"),
        ));
        let adapter = test_adapter(core);
        let rejected = adapter
            .handle_incoming("qq:group:group-b", "msg-1", "hi", Some("member-1"), None)
            .expect("ingest");
        assert!(rejected.is_none(), "未列入群级白名单必须丢弃");
    }

    #[test]
    fn deliver_event_is_logged_not_sent() {
        let core = core_with_route();
        let adapter = test_adapter(core);
        assert!(adapter
            .deliver_event("qq:group:123", "peri:done", &serde_json::json!({"data": {}}))
            .is_ok());
    }
}
