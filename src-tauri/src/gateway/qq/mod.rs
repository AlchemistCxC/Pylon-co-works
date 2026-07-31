//! QQ 平台适配器（B10.1 骨架：入站去重 + ingest 入口；B10.2 接 WS/发送）。

pub mod auth;
pub mod dedup;
pub mod events;
pub mod send;
pub mod types;

use std::sync::{Arc, Mutex};

use dedup::DedupState;

use crate::gateway::{GatewayCore, PlatformAdapter, ResolvedIngest};

/// QQ 平台单条文本上限（字符，Hermes MAX_MESSAGE_LENGTH 实证值）。
const QQ_MAX_MESSAGE_LEN: usize = 4000;

/// QQ 适配器：入站（handle_incoming）去重后进入 gateway.ingest；
/// 出站（deliver）待 B10.2 接 WS 发送队列后接线——当前返回明确错误。
/// 待 B10.2 WS 连接接线后构造并注册进 GatewayCore。
#[allow(dead_code)]
pub struct QqAdapter {
    dedup: Mutex<DedupState>,
    core: Arc<GatewayCore>,
}

#[allow(dead_code)]
impl QqAdapter {
    /// 构造适配器（B10.2 注册进 GatewayCore）。
    pub fn new(core: Arc<GatewayCore>) -> Arc<Self> {
        Arc::new(Self {
            dedup: Mutex::new(DedupState::new()),
            core,
        })
    }

    /// 入站入口：resume 重放去重 → gateway.ingest 路由解析。
    ///
    /// - msg_id 已见（重放）→ Ok(None)，不重复 ingest
    /// - 新消息 → 记录 seen + last_msg_id，返回路由解析结果
    /// B10.2 WS 事件解析（events.rs）后调用本方法；去重在适配器层完成，
    /// ingest 层只见干净消息。
    pub fn handle_incoming(&self, source: &str, msg_id: &str, content: &str) -> Result<Option<ResolvedIngest>, String> {
        let mut dedup = self.dedup.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !dedup.is_new(msg_id) {
            return Ok(None);
        }
        if let Some(chat_id) = source.rsplit(':').next() {
            dedup.set_latest(chat_id, msg_id);
        }
        drop(dedup);
        self.core.ingest(source, content).map(Some)
    }
}

// trait impl 在 QqAdapter 接线（B10.2 构造注册）前与 struct 一致标 allow；
// QQ_MAX_MESSAGE_LEN 仅被本 impl 引用，随接线自然消除。
#[allow(dead_code)]
impl PlatformAdapter for QqAdapter {
    fn platform_key(&self) -> &str {
        "qq"
    }

    fn max_message_len(&self) -> usize {
        QQ_MAX_MESSAGE_LEN
    }

    fn deliver_text(&self, source: &str, _text: &str) -> Result<(), String> {
        Err(format!("QQ deliver 未接线（B10.2）: {source}"))
    }

    fn deliver_event(&self, source: &str, event: &str, _payload: &serde_json::Value) -> Result<(), String> {
        Err(format!("QQ deliver 未接线（B10.2）: {source} event={event}"))
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
        Arc::new(GatewayCore::with_routes(
            crate::gateway::route::EntityRouteTable::from_yaml_str(yaml).expect("合法路由配置"),
        ))
    }

    #[test]
    fn handle_incoming_resolves_route_and_records_latest_msg() {
        let core = core_with_route();
        let adapter = QqAdapter::new(core);
        let resolved = adapter
            .handle_incoming("qq:group:123", "msg-1", "你好")
            .expect("ingest must resolve")
            .expect("新消息必须返回解析结果");
        assert_eq!(resolved.source, "qq:group:123");
        assert_eq!(resolved.content, "你好");
        assert_eq!(resolved.binding.as_ref().unwrap().agent_id, "peri");
    }

    #[test]
    fn replayed_msg_id_is_dropped_without_ingest() {
        let core = core_with_route();
        let adapter = QqAdapter::new(core);
        adapter.handle_incoming("qq:group:123", "msg-1", "first").expect("first ingest");
        let replay = adapter
            .handle_incoming("qq:group:123", "msg-1", "first replay")
            .expect("replay must be handled");
        assert!(replay.is_none(), "重复 msg_id 必须丢弃（resume 重放保护）");
    }

    #[test]
    fn replayed_msg_id_after_window_eviction_is_new_again() {
        let core = core_with_route();
        let adapter = QqAdapter::new(core);
        // 填满 dedup 窗口再插一条，把 msg-0 挤出
        for i in 0..=dedup::DedupState::new().window_capacity() {
            let msg = format!("msg-{i}");
            let _ = adapter.handle_incoming("qq:group:123", &msg, "x");
        }
        let replayed = adapter.handle_incoming("qq:group:123", "msg-0", "x").expect("ingest");
        assert!(replayed.is_some(), "窗口挤出后 msg-0 应重新可见");
    }

    #[test]
    fn empty_source_is_rejected() {
        let core = core_with_route();
        let adapter = QqAdapter::new(core);
        let error = adapter.handle_incoming("", "msg-1", "x").expect_err("空 source 必须拒绝");
        assert!(error.contains("source"));
    }
}
