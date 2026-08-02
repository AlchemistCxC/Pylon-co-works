//! QQ 平台适配器（B10.1 骨架 + B10.2 组装 + B10 收尾：发送队列/重试/死目标/回复锚点）。

pub mod auth;
pub mod dedup;
pub mod events;
pub mod send;
pub mod types;
pub mod ws;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dedup::DedupState;
use reqwest::Client;
use tokio::sync::mpsc;

use crate::gateway::{GatewayCore, PlatformAdapter, ResolvedIngest};

use self::auth::QqAuth;

/// QQ 平台单条文本上限（字符，Hermes MAX_MESSAGE_LENGTH 实证值）。
const QQ_MAX_MESSAGE_LEN: usize = 4000;
/// 每 chat 发送队列容量（agent 输出洪水时不阻塞 deliver，满则丢弃该段并告警）。
const SEND_QUEUE_CAP: usize = 256;
/// 瞬时失败重试次数（指数退避 1s/2s/4s 后放弃告警）。
const SEND_RETRY_ATTEMPTS: u32 = 3;
/// token 瞬时失败重试次数（指数退避 1s/2s 后放弃该消息并告警，不丢队列后续消息）。
const TOKEN_RETRY_ATTEMPTS: u32 = 3;
/// rate limited 等待（QQ 实证：60s 后重试一次）。
const RATE_LIMIT_DELAY_SECS: u64 = 60;
/// send_loop 空闲超时（审查修复：无消息时任务自行退出并从 senders map 移除，
/// 防止 chat_id 无界增长导致常驻任务泄漏）。
const SEND_LOOP_IDLE_SECS: u64 = 300;
/// 死目标 TTL（B8）：标记后 30 分钟自动过期，过期后下一次投递作为探测发送
/// （探测失败重新标记，成功自愈清除）——死目标从"永久哑火"变为"渐进探测恢复"。
const DEAD_TARGET_TTL: Duration = Duration::from_secs(30 * 60);

/// 发送失败分类（B10 收尾，参考 Hermes 发送重试/死目标模式）。
#[derive(Debug)]
enum SendFailure {
    /// 瞬时（网络/5xx 等）：有限重试后告警。
    Transient(String),
    /// 平台限流（429/rate）：等 60s 重试一次，超限放弃告警。
    RateLimited(String),
    /// 死目标（403/404/forbidden/not found：群被删/拉黑/注销）：标记不可达，短路投递。
    DeadTarget(String),
}

fn classify_send_error(error: &str) -> SendFailure {
    // 修复（P2-2）：QQ 真实错误是中文（如 {"code":304023,"message":"发送消息频率限制"}），
    // 原实现只匹配英文/数字子串会误判为 Transient（限流丢消息 / 死目标永不标记）。
    // 匹配原则：明确限流词 → RateLimited；明确权限/对象不存在 → DeadTarget；其余 Transient。
    let lower = error.to_lowercase();
    if lower.contains("429")
        || lower.contains("rate")
        || error.contains("频率限制")
        || error.contains("发送频率")
        || error.contains("限流")
    {
        SendFailure::RateLimited(error.to_string())
    } else if lower.contains("403")
        || lower.contains("404")
        || lower.contains("forbidden")
        || lower.contains("not found")
        || lower.contains("not allowed")
        || error.contains("被禁")
        || error.contains("禁言")
        || error.contains("无权限")
        || error.contains("无操作权限")
        || error.contains("不存在")
        || error.contains("失效")
    {
        SendFailure::DeadTarget(error.to_string())
    } else {
        SendFailure::Transient(error.to_string())
    }
}

/// 死目标标记是否已过期（TTL 后允许下一条投递做探测发送）。
fn dead_target_expired(entry: &(String, Instant)) -> bool {
    entry.1.elapsed() >= DEAD_TARGET_TTL
}

/// 入队消息：单 chat 串行发送（天然节流）。
struct QueuedSend {
    chat_type: String,
    chat_id: String,
    text: String,
    reply_to: Option<String>,
}

/// QQ 适配器：入站（handle_incoming）去重后进入 gateway.ingest；
/// 出站 deliver 经 per-chat 发送队列串行投递（重试/死目标/回复锚点）。
pub struct QqAdapter {
    dedup: Mutex<DedupState>,
    core: Arc<GatewayCore>,
    http: Client,
    auth: Arc<QqAuth>,
    /// QQ API 基地址（测试可注入桩地址；生产 = types::API_BASE）。
    base_url: String,
    /// chat_id → 发送队列发送端（后台 send_loop 串行消费；空闲超时自回收）。
    senders: Arc<Mutex<HashMap<String, mpsc::Sender<QueuedSend>>>>,
    /// chat_id → (死目标原因, 标记时间)（forbidden/not_found 标记；成功发送自愈清除；
    /// TTL 过期后下一条投递作探测发送）。
    dead_targets: Arc<Mutex<HashMap<String, (String, Instant)>>>,
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
            base_url: types::API_BASE.to_string(),
            senders: Arc::new(Mutex::new(HashMap::new())),
            dead_targets: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// 测试构造：注入 QQ API 桩地址（集成测试避免打真实 QQ API）。
    #[cfg(test)]
    pub(crate) fn for_testing(
        core: Arc<GatewayCore>,
        http: Client,
        auth: Arc<QqAuth>,
        base_url: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            dedup: Mutex::new(DedupState::new()),
            core,
            http,
            auth,
            base_url,
            senders: Arc::new(Mutex::new(HashMap::new())),
            dead_targets: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// 入站入口：白名单 → 去重 → 路由解析 → dispatch（ACP 发送）。
    ///
    /// 核验修复：白名单先于 seen 记录——被白名单拒绝的消息不占去重窗口，
    /// 之后白名单放宽时同一消息重放仍可正常处理（消息从未真正 ingest 过）。
    /// 修复（O38）：白名单判定先于 `core.ingest`——被白名单拒绝的消息不再产生
    /// 超长截断的 content clone 分配（白名单只看 source/member，与 content 无关）。
    /// - 白名单拒绝 → Ok(None)，不 dispatch
    /// - msg_id 已见（resume 重放）→ Ok(None)，不重复 ingest
    /// - 新消息 → 记录 seen + last_msg_id，dispatch 发送并返回解析结果
    ///   ws.rs 事件分发后调用本方法；去重/白名单在适配器层完成，ingest 层只见干净消息。
    pub fn handle_incoming(
        &self,
        source: &str,
        msg_id: &str,
        content: &str,
        member_openid: Option<&str>,
        user_openid: Option<&str>,
    ) -> Result<Option<ResolvedIngest>, String> {
        // P3：锁内读取白名单配置（with_qq_config），避免每消息 clone 整个 QqGatewayConfig
        // R6b：读锁中毒（panic 后）→ 拒绝 ingest（fail-closed）——不得回退默认
        // 空白名单（空白名单 = 放行所有群，白名单安全路径必须拒绝）。
        // O38：白名单判定先于 ingest（截断 clone）——拒绝路径不产生截断分配。
        let binding = self.core.binding(source);
        let allowed = match self.core.with_qq_config(|qq| {
            crate::gateway::ingest_allowed(qq, binding.as_ref(), source, member_openid, user_openid)
        }) {
            Some(allowed) => allowed,
            None => {
                log::error!("gateway 配置读锁中毒，拒绝 ingest（fail-closed）: {source}");
                return Ok(None);
            }
        };
        if !allowed {
            return Ok(None);
        }
        let resolved = self.core.ingest(source, content)?;
        let mut dedup = self
            .dedup
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

    /// 投递文本（已分段，B10 收尾）：回复锚点（dedup latest_for）→ 死目标短路 →
    /// per-chat 发送队列入队（后台串行发送 + 重试 + 死目标标记）。队列满丢弃该段并告警。
    /// deliver_event（done/error）首版不投平台，记录日志。
    fn deliver_text(&self, source: &str, text: &str) -> Result<(), String> {
        let (chat_type, chat_id) = parse_source(source)?;
        // 回复锚点：本 chat 最新收到的 msg_id（QQ 回复 API 需要）
        let reply_to = self
            .dedup
            .lock()
            .ok()
            .and_then(|dedup| dedup.latest_for(chat_id).map(str::to_string));
        // 死目标短路：目标不可达（群被删/拉黑/注销）不再投递；TTL 过期则清除标记
        // 放行本条做探测发送（B8：失败重新标记，成功自愈）
        if let Some(entry) = self
            .dead_targets
            .lock()
            .ok()
            .and_then(|d| d.get(chat_id).cloned())
        {
            if !dead_target_expired(&entry) {
                log::warn!(
                    "QQ deliver 短路（死目标 {chat_id}: {}），丢弃 {:.60}...",
                    entry.0,
                    text
                );
                return Ok(());
            }
            self.dead_targets.lock().ok().map(|mut d| d.remove(chat_id));
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return Err("QQ deliver 需要 tokio runtime".to_string());
        };
        let (tx, rx) = {
            let mut senders = self
                .senders
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(existing) = senders.get(chat_id) {
                (existing.clone(), None)
            } else {
                let (tx, rx) = mpsc::channel(SEND_QUEUE_CAP);
                senders.insert(chat_id.to_string(), tx.clone());
                (tx, Some(rx))
            }
        };
        if let Some(rx) = rx {
            // 首个入队者：启动本 chat 的后台发送循环（空闲超时自回收并移除 map 条目）
            let http = self.http.clone();
            let auth = self.auth.clone();
            let dead = self.dead_targets.clone();
            let base_url = self.base_url.clone();
            let senders = self.senders.clone();
            let chat_id_owned = chat_id.to_string();
            // P2-3：把发送端克隆交给 send_loop——空闲退出前用它做强计数 double-check
            let sender_owned = tx.clone();
            runtime.spawn(async move {
                Self::send_loop(
                    http,
                    auth,
                    dead,
                    base_url,
                    senders,
                    sender_owned,
                    chat_id_owned,
                    rx,
                )
                .await;
            });
        }
        let message = QueuedSend {
            chat_type: chat_type.to_string(),
            chat_id: chat_id.to_string(),
            text: text.to_string(),
            reply_to,
        };
        if tx.try_send(message).is_err() {
            log::warn!("QQ deliver 队列满（{chat_id}），丢弃该段");
        }
        Ok(())
    }

    fn deliver_event(
        &self,
        source: &str,
        event: &str,
        _payload: &serde_json::Value,
    ) -> Result<(), String> {
        log::info!("QQ deliver_event 未投递（首版仅文本）: {source} event={event}");
        Ok(())
    }
}

impl QqAdapter {
    /// per-chat 后台发送循环：串行消费队列（节流）→ token → 发送（瞬时 3 次退避重试 /
    /// rate 60s 一次 / 死目标标记短路）。成功发送清除死目标标记（自愈）。
    /// 审查修复：空闲 SEND_LOOP_IDLE_SECS 无消息则退出并从 senders map 移除
    /// （防 chat_id 无界增长 + 常驻任务泄漏）；token 瞬时失败退避重试不丢消息。
    // clippy 2026-08-02：8 参为串行队列状态（http/auth/dead_targets/base_url/senders/tx/chat_id/rx），
    // 均为独立不可分组资源，保持显式签名（重构参数结构体收益低）。
    #[allow(clippy::too_many_arguments)]
    async fn send_loop(
        http: Client,
        auth: Arc<QqAuth>,
        dead_targets: Arc<Mutex<HashMap<String, (String, Instant)>>>,
        base_url: String,
        senders: Arc<Mutex<HashMap<String, mpsc::Sender<QueuedSend>>>>,
        tx: mpsc::Sender<QueuedSend>,
        chat_id: String,
        mut rx: mpsc::Receiver<QueuedSend>,
    ) {
        let idle = std::time::Duration::from_secs(SEND_LOOP_IDLE_SECS);
        'messages: loop {
            let msg = tokio::select! {
                msg = rx.recv() => match msg {
                    Some(msg) => msg,
                    None => break,
                },
                _ = tokio::time::sleep(idle) => {
                    // 修复（P2-3）：空闲退出竞态——break 与 map 移除之间，并发 deliver_text
                    // 可能克隆 sender 并 try_send 成功，随后 rx 被 drop 丢消息且无告警。
                    // 锁内 double-check：sender 强计数 >2（并发 deliver 正持有克隆，
                    // 克隆发生在 senders 锁内，锁内判断可排空该窗口）或队列非空 →
                    // 继续循环；否则移除 map 条目后退出。
                    let exit = {
                        let mut map = senders.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                        if tx.strong_count() > 2 || !rx.is_empty() {
                            false
                        } else {
                            map.remove(&chat_id);
                            true
                        }
                    };
                    if exit {
                        break;
                    }
                    continue;
                }
            };
            // 死目标跳过：TTL 内跳过；过期则清除标记放行本条做探测发送（B8）
            if let Some(entry) = dead_targets
                .lock()
                .ok()
                .and_then(|d| d.get(&msg.chat_id).cloned())
            {
                if !dead_target_expired(&entry) {
                    log::warn!("QQ send_loop 跳过死目标 {}", msg.chat_id);
                    continue;
                }
                dead_targets.lock().ok().map(|mut d| d.remove(&msg.chat_id));
            }
            // 修复（P2-4）：token 瞬时失败指数退避重试（1s/2s），当前消息原地保留不丢；
            // 连续超 TOKEN_RETRY_ATTEMPTS 次仍未成功 → 记录日志并丢弃该消息
            // （继续处理队列后续消息）。
            let token = {
                let mut attempts = 0u32;
                'token: loop {
                    match auth.get_token().await {
                        Ok(token) => break 'token token,
                        Err(error) => {
                            attempts += 1;
                            if attempts >= TOKEN_RETRY_ATTEMPTS {
                                log::warn!("QQ deliver token 连续 {attempts} 次获取失败（{chat_id}），丢弃该消息: {error}");
                                continue 'messages;
                            }
                            log::warn!(
                                "QQ deliver token 获取失败（{chat_id}），{}s 后重试: {error}",
                                1u64 << (attempts - 1)
                            );
                            tokio::time::sleep(std::time::Duration::from_secs(
                                1u64 << (attempts - 1),
                            ))
                            .await;
                        }
                    }
                }
            };
            match Self::send_with_retry(&http, &base_url, &token, &msg).await {
                Ok(()) => {
                    dead_targets.lock().ok().map(|mut d| d.remove(&msg.chat_id));
                }
                Err(SendFailure::RateLimited(error)) => {
                    log::warn!("QQ deliver rate limited（{chat_id}），{RATE_LIMIT_DELAY_SECS}s 后重试一次: {error}", chat_id = msg.chat_id);
                    tokio::time::sleep(std::time::Duration::from_secs(RATE_LIMIT_DELAY_SECS)).await;
                    let token = match auth.get_token().await {
                        Ok(token) => token,
                        Err(error) => {
                            log::warn!("QQ deliver rate 重试 token 失败: {error}");
                            continue;
                        }
                    };
                    if let Err(error) = Self::send_once(&http, &base_url, &token, &msg).await {
                        log::warn!("QQ deliver rate 重试仍失败: {error:?}");
                    } else {
                        dead_targets.lock().ok().map(|mut d| d.remove(&msg.chat_id));
                    }
                }
                Err(SendFailure::DeadTarget(error)) => {
                    dead_targets.lock().ok().map(|mut d| {
                        d.insert(msg.chat_id.clone(), (error.clone(), Instant::now()))
                    });
                    log::warn!(
                        "QQ deliver 目标不可达（{}），标记死目标: {error}",
                        msg.chat_id
                    );
                }
                Err(SendFailure::Transient(error)) => {
                    log::warn!(
                        "QQ deliver 发送失败（{chat_id}）: {error}",
                        chat_id = msg.chat_id
                    );
                }
            }
        }
        senders.lock().ok().map(|mut map| map.remove(&chat_id));
        log::info!("QQ send_loop 退出（{chat_id}，空闲或关闭）");
    }

    /// 发送 + 瞬时失败指数退避重试（SEND_RETRY_ATTEMPTS 次：1s/2s/4s）。
    /// 修复（P2-1）：按 SendFailure 变体分流——DeadTarget/RateLimited 立即返回
    /// （死目标标记 / 60s 全局等待由 send_loop 调用处处理），仅 Transient 走退避重试。
    async fn send_with_retry(
        http: &Client,
        base_url: &str,
        token: &str,
        msg: &QueuedSend,
    ) -> Result<(), SendFailure> {
        let mut last_error = None;
        for attempt in 0..SEND_RETRY_ATTEMPTS {
            match Self::send_once(http, base_url, token, msg).await {
                Ok(()) => return Ok(()),
                Err(SendFailure::Transient(error)) => {
                    last_error = Some(SendFailure::Transient(error));
                    if attempt + 1 < SEND_RETRY_ATTEMPTS {
                        tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_error.unwrap_or(SendFailure::Transient("unknown".to_string())))
    }

    /// 单次发送（send.rs；错误分类给重试/死目标策略）。
    async fn send_once(
        http: &Client,
        base_url: &str,
        token: &str,
        msg: &QueuedSend,
    ) -> Result<(), SendFailure> {
        send::send_message(
            http,
            base_url,
            token,
            &msg.chat_id,
            &msg.chat_type,
            &msg.text,
            msg.reply_to.as_deref(),
            types::MSG_TYPE_TEXT,
        )
        .await
        .map(|_| ())
        .map_err(|error| classify_send_error(&error))
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
        adapter
            .handle_incoming("qq:group:123", "msg-1", "first", None, None)
            .expect("first ingest");
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
        let replayed = adapter
            .handle_incoming("qq:group:123", "msg-0", "x", None, None)
            .expect("ingest");
        assert!(replayed.is_some(), "窗口挤出后 msg-0 应重新可见");
    }

    #[test]
    fn empty_source_is_rejected() {
        let core = core_with_route();
        let adapter = test_adapter(core);
        let error = adapter
            .handle_incoming("", "msg-1", "x", None, None)
            .expect_err("空 source 必须拒绝");
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
            .deliver_event(
                "qq:group:123",
                "peri:done",
                &serde_json::json!({"data": {}})
            )
            .is_ok());
    }

    #[test]
    fn dead_target_expired_only_after_ttl() {
        // 未过期：刚标记 → false
        assert!(!dead_target_expired(&(
            "forbidden".to_string(),
            Instant::now()
        )));
        // 过期：标记时间已超 TTL → true
        assert!(dead_target_expired(&(
            "forbidden".to_string(),
            Instant::now() - DEAD_TARGET_TTL
        )));
        // 恰好边界：超过 TTL 一瞬 → true
        assert!(dead_target_expired(&(
            "forbidden".to_string(),
            Instant::now() - DEAD_TARGET_TTL - Duration::from_secs(1)
        )));
    }

    #[test]
    fn classify_send_error_matches_chinese_and_http_status() {
        // 限流：QQ 真实中文错误（原实现只匹配英文/数字子串会误判 Transient 丢消息）
        assert!(matches!(
            classify_send_error("HTTP 429: {\"code\":304023,\"message\":\"发送消息频率限制\"}"),
            SendFailure::RateLimited(_)
        ));
        assert!(matches!(
            classify_send_error("发送频率过快"),
            SendFailure::RateLimited(_)
        ));
        assert!(matches!(
            classify_send_error("触发限流"),
            SendFailure::RateLimited(_)
        ));
        // 死目标：HTTP 状态码 / 中文权限 / 对象不存在
        assert!(matches!(
            classify_send_error("HTTP 403: 无操作权限"),
            SendFailure::DeadTarget(_)
        ));
        assert!(matches!(
            classify_send_error("HTTP 404: {\"message\":\"群不存在\"}"),
            SendFailure::DeadTarget(_)
        ));
        assert!(matches!(
            classify_send_error("账号被禁言"),
            SendFailure::DeadTarget(_)
        ));
        assert!(matches!(
            classify_send_error("not allowed"),
            SendFailure::DeadTarget(_)
        ));
        // 其余 → Transient
        assert!(matches!(
            classify_send_error("HTTP 500: internal error"),
            SendFailure::Transient(_)
        ));
        assert!(matches!(
            classify_send_error("connect timeout"),
            SendFailure::Transient(_)
        ));
    }
}
