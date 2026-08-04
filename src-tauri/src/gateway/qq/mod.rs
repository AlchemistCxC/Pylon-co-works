//! QQ 平台适配器（B10.1 骨架 + B10.2 组装 + B10 收尾：发送队列/重试/死目标/回复锚点）。

pub mod auth;
pub mod dedup;
pub mod events;
pub mod send;
pub mod types;
pub mod ws;

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dedup::DedupState;
use reqwest::Client;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::gateway::{build_resolved, route, GatewayCore, PlatformAdapter, ResolvedIngest};

use self::auth::QqAuth;

/// QQ 平台键（gateway source 前缀与适配器 platform_key 的统一字面量，§3-8）。
const PLATFORM_KEY: &str = "qq";

/// QQ 平台单条文本上限（字符，Hermes MAX_MESSAGE_LENGTH 实证值）。
const QQ_MAX_MESSAGE_LEN: usize = 4000;
/// 每 chat 发送队列容量（agent 输出洪水时不阻塞 deliver，满则丢弃该段并告警）。
const SEND_QUEUE_CAP: usize = 256;
/// 瞬时失败重试次数（指数退避 1s/2s/4s 后放弃告警）。
const SEND_RETRY_ATTEMPTS: u32 = 3;
/// token 瞬时失败重试次数（指数退避 1s/2s 后放弃该消息并告警，不丢队列后续消息）。
const TOKEN_RETRY_ATTEMPTS: u32 = 3;
/// rate limited 等待（QQ 实证：60s 后重试一次）。
#[cfg(not(test))]
const RATE_LIMIT_DELAY_SECS: u64 = 60;
/// 测试态缩短 rate 重试等待（O42 集成测试验证重试失败分类，不等待真实 60s）。
#[cfg(test)]
const RATE_LIMIT_DELAY_SECS: u64 = 1;
/// send_loop 空闲超时（审查修复：无消息时任务自行退出并从 senders map 移除，
/// 防止 chat_id 无界增长导致常驻任务泄漏）。
#[cfg(not(test))]
const SEND_LOOP_IDLE_SECS: u64 = 300;
/// 测试态缩短空闲超时（R10 集成测试验证 token 触发与 worker 重建，不等待真实 300s）。
#[cfg(test)]
const SEND_LOOP_IDLE_SECS: u64 = 1;
/// 死目标 TTL（B8）：标记后 30 分钟自动过期，过期后下一次投递作为探测发送
/// （探测失败重新标记，成功自愈清除）——死目标从"永久哑火"变为"渐进探测恢复"。
const DEAD_TARGET_TTL: Duration = Duration::from_secs(30 * 60);
/// 死目标短路告警节流（O43）：同 key 1s 内至多一条 warn——
/// 死目标期间每条 agent 输出都触发 deliver，逐条 warn 会刷屏。
const DEAD_TARGET_WARN_INTERVAL: Duration = Duration::from_secs(1);

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

/// QQ 目标类型（R14：字符串枚举化——parse_source / send_message 不再以裸 &str
/// 拼路径，非法 chat_type 在类型层不可表达）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QqChatType {
    /// 私聊（qq:user:* → /v2/users/{id}/messages）。
    C2C,
    /// 群聊（qq:group:* → /v2/groups/{id}/messages）。
    Group,
}

impl QqChatType {
    /// wire 形态："c2c" / "group"（QQ API 路径段）。
    pub fn as_str(&self) -> &'static str {
        match self {
            QqChatType::C2C => "c2c",
            QqChatType::Group => "group",
        }
    }
}

impl FromStr for QqChatType {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "c2c" => Ok(QqChatType::C2C),
            "group" => Ok(QqChatType::Group),
            other => Err(format!("不支持的 chat_type: {other}")),
        }
    }
}

impl fmt::Display for QqChatType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 入队消息：单 chat 串行发送（天然节流）。
struct QueuedSend {
    chat_type: QqChatType,
    chat_id: String,
    text: String,
    reply_to: Option<String>,
}

/// 每 chat 发送 worker 句柄（R10）：发送端 + 取消令牌。
/// token 是 worker 存活判定：空闲退出时触发（cancel），deliver_text 见
/// cancelled 即重建新 worker（新 token）；token 相等性校验防止旧 worker
/// 的清理误删重建后的新条目。
struct SendWorker {
    tx: mpsc::Sender<QueuedSend>,
    token: CancellationToken,
}

/// QQ 适配器：入站（handle_incoming）去重后经 dispatch_ingest 进入 ACP 发送；
/// 出站 deliver 经 per-chat 发送队列串行投递（重试/死目标/回复锚点）。
pub struct QqAdapter {
    dedup: Mutex<DedupState>,
    core: Arc<GatewayCore>,
    http: Client,
    auth: Arc<QqAuth>,
    /// QQ API 基地址（测试可注入桩地址；生产 = types::API_BASE）。
    base_url: String,
    /// 复合键 `{chat_type}:{chat_id}` → 发送 worker 句柄（SendWorker：发送端 +
    /// 存活 token；后台 send_loop 串行消费，空闲超时触发 token 并自回收）。
    /// 群/私聊同 id 互不串扰（O40）。
    senders: Arc<Mutex<HashMap<String, SendWorker>>>,
    /// 复合键 `{chat_type}:{chat_id}` → (死目标原因, 标记时间)（forbidden/not_found 标记；
    /// 成功发送自愈清除；TTL 过期后下一条投递作探测发送）。
    dead_targets: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    /// 复合键 `{chat_type}:{chat_id}` → 最近一次短路 warn 时间（O43 节流：
    /// 同 key 1s 内至多一条告警，过期条目随检查清理，表保持有界）。
    short_circuit_warns: Mutex<HashMap<String, Instant>>,
}

/// 平台入站白名单检查（B10.3，Hermes group_allow_from / allow_from 模式）：
///
/// - 群消息（qq:group:*）：群级白名单（qq 配置）→ 成员白名单（binding.allow_from）
/// - 私聊（qq:user:*）：用户白名单（binding.allow_from）
/// - 未配置白名单 = 放行；群级白名单只约束群消息
///
/// §3-2：从 gateway/mod.rs 下沉（QQ 专属语义：qq:group: 前缀解析 + group_allow_from）——
/// 通用模块不感知 QQ source 形状；第二个平台接入时再评估通用化。
pub(crate) fn ingest_allowed(
    qq_config: &route::QqGatewayConfig,
    binding: Option<&route::EntityBinding>,
    source: &str,
    member_openid: Option<&str>,
    user_openid: Option<&str>,
) -> bool {
    if let Some(group_id) = source.strip_prefix("qq:group:") {
        if let Some(allow) = &qq_config.group_allow_from {
            if !allow.iter().any(|g| g == group_id) {
                return false;
            }
        }
    }
    let Some(binding) = binding else {
        return true;
    };
    let Some(allow) = &binding.allow_from else {
        return true;
    };
    let principal = if source.starts_with("qq:group:") {
        member_openid.unwrap_or("")
    } else {
        user_openid.unwrap_or("")
    };
    allow.iter().any(|entry| entry == principal)
}

/// 从 gateway source 解析 QQ 目标：`qq:group:123` → (Group, 123)；`qq:user:456` → (C2C, 456)。
pub fn parse_source(source: &str) -> Result<(QqChatType, &str), String> {
    let mut parts = source.splitn(3, ':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(PLATFORM_KEY), Some(kind @ ("group" | "user")), Some(id)) if !id.is_empty() => Ok((
            if kind == "group" {
                QqChatType::Group
            } else {
                QqChatType::C2C
            },
            id,
        )),
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
            short_circuit_warns: Mutex::new(HashMap::new()),
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
            short_circuit_warns: Mutex::new(HashMap::new()),
        })
    }

    /// 入站入口：空文本拦截 → 白名单 + 路由绑定（单快照）→ 去重 → dispatch（ACP 发送）。
    ///
    /// 核验修复：白名单先于 seen 记录——被白名单拒绝的消息不占去重窗口，
    /// 之后白名单放宽时同一消息重放仍可正常处理（消息从未真正 ingest 过）。
    /// 修复（O38）：白名单判定先于内容截断 clone——拒绝路径不产生截断分配
    /// （白名单只看 source/member，与 content 无关）。
    /// 修复（S5）：白名单判定与路由绑定在同一 `with_routes_and_qq` 单快照内完成，
    /// ResolvedIngest 的 binding 与白名单判定依据同一份配置（不再经 ingest()
    /// 二次读锁，消除 reload 窗口下"旧绑定放行 → 新绑定投递"的混搭）。
    /// 修复（S9）：空 content（@bot 后无文字、无附件）入口拦截，与白名单拒绝
    /// 同语义：不占 seen 窗口，同一 msg_id 的非空内容仍可正常处理。
    /// - 空文本 → Ok(None)，不 dispatch
    /// - 白名单拒绝 → Ok(None)，不 dispatch
    /// - msg_id 已见（resume 重放）→ Ok(None)，不重复 ingest
    /// - 新消息 → 记录 seen + last_msg_id，dispatch 发送并返回解析结果
    ///   ws.rs 事件分发后调用本方法；去重/白名单在适配器层完成，解析结果见干净消息。
    pub fn handle_incoming(
        &self,
        source: &str,
        msg_id: &str,
        content: &str,
        member_openid: Option<&str>,
        user_openid: Option<&str>,
    ) -> Result<Option<ResolvedIngest>, String> {
        // S9：入站空文本拦截（与出站 O39 对称）——空消息不入站、不 dispatch，
        // 空 content 不会直达 send_prompt_core（agent 收不到空 user 消息）。
        // 拦截先于 dedup.is_new：与白名单拒绝同语义，不占 seen 窗口。
        if content.trim().is_empty() {
            return Ok(None);
        }
        // S5：空 source 校验与 ingest() 保持一致（无 source 即无路由可解析）。
        if source.trim().is_empty() {
            return Err("ingest requires a non-empty source".to_string());
        }
        // P3：锁内读取白名单配置，避免每消息 clone 整个 QqGatewayConfig
        // R6b：读锁中毒（panic 后）→ 拒绝 ingest（fail-closed）——不得回退默认
        // 空白名单（空白名单 = 放行所有群，白名单安全路径必须拒绝）。
        // O38：白名单判定先于内容截断 clone——拒绝路径不产生截断分配。
        // O67：with_routes_and_qq 单锁快照——qq 配置与路由绑定一次读锁内取齐。
        // S5：单快照内同时完成白名单判定与 binding 提取——判定依据的 allow_from
        // 与投递路由的 binding 必须出自同一份配置快照。旧实现白名单后经
        // core.ingest() 二次读锁解析 binding，reload 落在两次读锁之间时：消息按
        // 旧绑定的 allow_from 放行，却投递给新绑定（或绑定被删后回退 active
        // agent）——白名单校验过的 agent 与实际接收 agent 不一致。
        let (allowed, binding) = match self.core.with_routes_and_qq(source, |qq, binding| {
            (
                ingest_allowed(qq, binding, source, member_openid, user_openid),
                binding.cloned(),
            )
        }) {
            Some(snapshot) => snapshot,
            None => {
                tracing::error!("gateway 配置读锁中毒，拒绝 ingest（fail-closed）: {source}");
                return Ok(None);
            }
        };
        if !allowed {
            return Ok(None);
        }
        // S5：截断与组装统一走 build_resolved 纯函数（§3-4，替代已删除的
        // ingest() 公共入口）——用快照 binding 构造，不经二次读锁。截断在
        // 白名单判定之后（O38：拒绝路径不产生截断分配）、去重判重之后
        // （重放路径同样不产生截断分配），行为与旧单快照路径逐字一致。
        let mut dedup = self
            .dedup
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !dedup.is_new(msg_id) {
            return Ok(None);
        }
        if let Some(chat_id) = source.rsplit(':').next() {
            // O40：复合键 `{chat_type}:{chat_id}` 隔离——群聊与私聊同 id
            // （如 group:123 / c2c:123）不得互串回复锚点；无法解析 kind 时
            // 回退原裸 id 键（保留旧行为，此类 source 会被白名单拒绝）。
            // §3-3：复用 parse_source 消除重复 kind 匹配（原 split(':').nth(1)
            // 手工匹配 "group"/"user" 字面量）；parse_source Err → 同一回退分支。
            let key = match parse_source(source) {
                Ok((chat_type, _)) => format!("{chat_type}:{chat_id}"),
                Err(_) => chat_id.to_string(),
            };
            dedup.set_latest(&key, msg_id);
        }
        drop(dedup);
        // C14：组装带 msg_id 的解析结果再 dispatch——ingest 发送失败时 lib.rs 可经
        // rollback_seen 撤销 seen 标记（故障期消息不永久丢失，resume 重放可重入）。
        // source 非空已在上方校验，build_resolved 必成功（Err 分支为防御性兜底）。
        let mut dispatched = build_resolved(source, content, binding)?;
        dispatched.msg_id = Some(msg_id.to_string());
        self.core.dispatch_ingest(&dispatched);
        Ok(Some(dispatched))
    }
}

impl PlatformAdapter for QqAdapter {
    fn platform_key(&self) -> &str {
        PLATFORM_KEY
    }

    fn max_message_len(&self) -> usize {
        // §3-7：分段上限参数外置（gateway.qq.max_message_len，缺省 = QQ_MAX_MESSAGE_LEN
        // 4000，行为零变化）。qq_config() 每次调用 clone 整个配置——deliver_all 每
        // chunk 调用一次，可接受；若在意可改读锁访问器（方案 §3-7 留方案）。
        self.core
            .qq_config()
            .max_message_len
            .unwrap_or(QQ_MAX_MESSAGE_LEN)
    }

    /// 回滚 seen 标记（C14）：ingest 发送失败时撤销 msg_id 的去重记录，
    /// 之后 resume 重放同一消息可重新 ingest。锁中毒时静默放弃（保守处理）。
    fn rollback_seen(&self, msg_id: &str) {
        if let Ok(mut dedup) = self.dedup.lock() {
            dedup.rollback(msg_id);
        }
    }

    /// 投递文本（已分段，B10 收尾）：回复锚点（dedup latest_for）→ 死目标短路 →
    /// per-chat 发送队列入队（后台串行发送 + 重试 + 死目标标记）。队列满丢弃该段并告警。
    /// deliver_event（done/error）首版不投平台，记录日志。
    fn deliver_text(&self, source: &str, text: &str) -> Result<(), String> {
        let (chat_type, chat_id) = parse_source(source)?;
        // O40：复合键 `{chat_type}:{chat_id}`——群聊与私聊同 id 时
        // 回复锚点/死目标/发送队列互不串扰（如 group:123 与 c2c:123）。
        let key = format!("{chat_type}:{chat_id}");
        // 回复锚点：本 chat 最新收到的 msg_id（QQ 回复 API 需要）
        let reply_to = self
            .dedup
            .lock()
            .ok()
            .and_then(|dedup| dedup.latest_for(&key).map(str::to_string));
        // 死目标短路：目标不可达（群被删/拉黑/注销）不再投递；TTL 过期则清除标记
        // 放行本条做探测发送（B8：失败重新标记，成功自愈）
        if let Some(entry) = self
            .dead_targets
            .lock()
            .ok()
            .and_then(|d| d.get(&key).cloned())
        {
            if !dead_target_expired(&entry) {
                // O43：告警节流——死目标期间每条 agent 输出都触发 deliver，逐条
                // warn 会刷屏；同 key 1s 内至多一条，过期条目随检查顺带清理。
                let mut warns = self
                    .short_circuit_warns
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let now = Instant::now();
                warns.retain(|_, last| now.duration_since(*last) < DEAD_TARGET_WARN_INTERVAL);
                if !warns.contains_key(&key) {
                    tracing::warn!(
                        "QQ deliver 短路（死目标 {key}: {}），丢弃 {:.60}...",
                        entry.0,
                        text
                    );
                    warns.insert(key.clone(), now);
                }
                return Ok(());
            }
            self.dead_targets.lock().ok().map(|mut d| d.remove(&key));
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return Err("QQ deliver 需要 tokio runtime".to_string());
        };
        let message = QueuedSend {
            chat_type,
            chat_id: chat_id.to_string(),
            text: text.to_string(),
            reply_to,
        };
        // R10：入队与 worker 存活判定在同一把 senders 锁内完成——并发 deliver 的
        // try_send 与 worker 的空闲退出判定串行化，无需 strong_count 启发式：
        // 队列里已有本条消息 → worker 必继续；worker 已触发 token → 必重建新 worker。
        let mut spawned = None;
        {
            let mut senders = self
                .senders
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match senders.get(&key) {
                Some(existing) if !existing.token.is_cancelled() => {
                    if existing.tx.try_send(message).is_err() {
                        tracing::warn!("QQ deliver 队列满（{chat_id}），丢弃该段");
                    }
                }
                _ => {
                    // 无存活 worker（或旧 worker 已空闲退出、token 已触发）：
                    // 重建 channel + token，启动新后台发送循环。
                    let (tx, rx) = mpsc::channel(SEND_QUEUE_CAP);
                    let token = CancellationToken::new();
                    let worker = SendWorker {
                        tx: tx.clone(),
                        token: token.clone(),
                    };
                    senders.insert(key.clone(), worker);
                    if tx.try_send(message).is_err() {
                        tracing::warn!("QQ deliver 队列满（{chat_id}），丢弃该段");
                    }
                    spawned = Some((rx, token));
                }
            }
        }
        if let Some((rx, token)) = spawned {
            let http = self.http.clone();
            let auth = self.auth.clone();
            let dead = self.dead_targets.clone();
            let base_url = self.base_url.clone();
            let senders = self.senders.clone();
            let key_owned = key.clone();
            runtime.spawn(async move {
                Self::send_loop(http, auth, dead, base_url, senders, key_owned, rx, token).await;
            });
        }
        Ok(())
    }

    fn deliver_event(
        &self,
        source: &str,
        event: &str,
        _payload: &serde_json::Value,
    ) -> Result<(), String> {
        tracing::info!("QQ deliver_event 未投递（首版仅文本）: {source} event={event}");
        Ok(())
    }
}

impl QqAdapter {
    /// per-chat 后台发送循环：串行消费队列（节流）→ token → 发送（瞬时 3 次退避重试 /
    /// rate 60s 一次 / 死目标标记短路）。成功发送清除死目标标记（自愈）。
    /// R10：空闲 SEND_LOOP_IDLE_SECS 无消息则触发 cancel_token 并退出（从 senders
    /// map 移除，防 chat_id 无界增长 + 常驻任务泄漏）——token 取代原 strong_count
    /// 协议：deliver_text 在 senders 锁内 try_send（与退出判定串行化），并凭
    /// `token.is_cancelled()` 判定 worker 存活、重建新 worker 时使用新 token。
    /// O40：key 为复合键 `{chat_type}:{chat_id}`（群/私聊同 id 互不串扰），
    /// 死目标/senders 均以 key 寻址；msg.chat_id 仅用于 QQ API 路径与日志。
    // clippy 2026-08-02：8 参为串行队列状态（http/auth/dead_targets/base_url/senders/key/rx/cancel_token），
    // 均为独立不可分组资源，保持显式签名（重构参数结构体收益低）。
    #[allow(clippy::too_many_arguments)]
    async fn send_loop(
        http: Client,
        auth: Arc<QqAuth>,
        dead_targets: Arc<Mutex<HashMap<String, (String, Instant)>>>,
        base_url: String,
        senders: Arc<Mutex<HashMap<String, SendWorker>>>,
        key: String,
        mut rx: mpsc::Receiver<QueuedSend>,
        cancel_token: CancellationToken,
    ) {
        let idle = std::time::Duration::from_secs(SEND_LOOP_IDLE_SECS);
        'messages: loop {
            let msg = tokio::select! {
                msg = rx.recv() => match msg {
                    Some(msg) => msg,
                    None => break,
                },
                _ = tokio::time::sleep(idle) => {
                    // R10：空闲退出协议（取代 P2-3 的 strong_count double-check）。
                    // 并发 deliver_text 的 try_send 与本次判定在同一把 senders 锁内
                    // 串行化：锁内队列非空 → 必继续；否则凭 token 所有权确认本 worker
                    // 仍是 map 内唯一条目 → 触发 token、移除条目后退出。deliver_text
                    // 见 token 已触发即重建新 worker（新 token），旧 worker 终段清理
                    // 经 token 相等性校验不误删新条目。
                    let exit = {
                        let mut map =
                            senders.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                        if !rx.is_empty() {
                            false
                        } else if map
                            .get(&key)
                            .map(|worker| worker.token == cancel_token)
                            .unwrap_or(false)
                        {
                            cancel_token.cancel();
                            map.remove(&key);
                            true
                        } else {
                            false
                        }
                    };
                    if exit {
                        break;
                    }
                    continue;
                }
            };
            // 死目标跳过：TTL 内跳过；过期则清除标记放行本条做探测发送（B8）。
            // O43：降级 debug——队列内逐条跳过是批量场景，warn 由 deliver_text
            // 短路节流兜底（每条目 1s 至多一条），此处逐条 warn 会刷屏。
            if let Some(entry) = dead_targets.lock().ok().and_then(|d| d.get(&key).cloned()) {
                if !dead_target_expired(&entry) {
                    tracing::debug!("QQ send_loop 跳过死目标 {}", msg.chat_id);
                    continue;
                }
                dead_targets.lock().ok().map(|mut d| d.remove(&key));
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
                                tracing::warn!(
                                    "QQ deliver token 连续 {attempts} 次获取失败（{key}），丢弃该消息: {error}"
                                );
                                continue 'messages;
                            }
                            tracing::warn!(
                                "QQ deliver token 获取失败（{key}），{}s 后重试: {error}",
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
                    dead_targets.lock().ok().map(|mut d| d.remove(&key));
                }
                Err(SendFailure::RateLimited(error)) => {
                    tracing::warn!(
                        "QQ deliver rate limited（{key}），{RATE_LIMIT_DELAY_SECS}s 后重试一次: {error}"
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(RATE_LIMIT_DELAY_SECS)).await;
                    let token = match auth.get_token().await {
                        Ok(token) => token,
                        Err(error) => {
                            tracing::warn!("QQ deliver rate 重试 token 失败: {error}");
                            continue;
                        }
                    };
                    // O42：rate 重试失败按变体分流——重试后仍 403/404/不存在等
                    // 死目标直接标记（原实现只 log warn，死目标永不标记）。
                    match Self::send_once(&http, &base_url, &token, &msg).await {
                        Ok(()) => {
                            dead_targets.lock().ok().map(|mut d| d.remove(&key));
                        }
                        Err(SendFailure::DeadTarget(reason)) => {
                            dead_targets.lock().ok().map(|mut d| {
                                d.insert(key.clone(), (reason.clone(), Instant::now()))
                            });
                            tracing::warn!(
                                "QQ deliver rate 重试后目标不可达（{key}），标记死目标: {reason}"
                            );
                        }
                        Err(other) => {
                            tracing::warn!("QQ deliver rate 重试仍失败: {other:?}");
                        }
                    }
                }
                Err(SendFailure::DeadTarget(error)) => {
                    dead_targets
                        .lock()
                        .ok()
                        .map(|mut d| d.insert(key.clone(), (error.clone(), Instant::now())));
                    tracing::warn!("QQ deliver 目标不可达（{key}），标记死目标: {error}");
                }
                Err(SendFailure::Transient(error)) => {
                    tracing::warn!("QQ deliver 发送失败（{key}）: {error}");
                }
            }
        }
        // R10：终段清理——仅当 map 内仍是本 worker（token 相同）才移除，
        // 防止与重建后的新 worker 条目互相覆盖（空闲分支已在锁内移除过，此处兜底）。
        if let Ok(mut map) = senders.lock() {
            if map
                .get(&key)
                .map(|worker| worker.token == cancel_token)
                .unwrap_or(false)
            {
                map.remove(&key);
            }
        }
        tracing::info!("QQ send_loop 退出（{key}，空闲或关闭）");
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
            types::QqMsgType::Text,
        )
        .await
        .map(|_| ())
        .map_err(|error| classify_send_error(&error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use tracing_subscriber::layer::Layer;

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

    fn config_with(yaml: &str) -> Arc<GatewayCore> {
        Arc::new(GatewayCore::from_config(
            crate::gateway::route::parse_config(yaml).expect("合法配置"),
        ))
    }

    #[test]
    fn parse_source_accepts_group_and_user_shapes() {
        assert_eq!(parse_source("qq:group:123"), Ok((QqChatType::Group, "123")));
        assert_eq!(parse_source("qq:user:456"), Ok((QqChatType::C2C, "456")));
        assert!(parse_source("qq:unknown:1").is_err());
        assert!(parse_source("qq:group:").is_err());
        assert!(parse_source("local").is_err());
        assert!(parse_source("wechat:group:1").is_err());
    }

    #[test]
    fn ingest_allowed_enforces_group_and_member_allowlists() {
        // §3-2：白名单函数随 QQ 语义下沉至适配器模块（通用模块不再感知 qq:group: 形状）
        let config = config_with(
            r#"
gateway:
  qq:
    group_allow_from: [group-a]
  routes:
    - source: qq:group:group-a
      agent: peri
      profile: trpg
      session: 战役1
      allow_from: [member-1]
    - source: qq:user:user-1
      agent: hermes
      profile: default
      session: dm
      allow_from: [user-1]
"#,
        );
        let qq = config.qq_config();
        let group_binding = config.binding("qq:group:group-a");
        // 群级白名单：未列出群拒绝
        assert!(!ingest_allowed(
            &qq,
            group_binding.as_ref(),
            "qq:group:group-x",
            Some("member-1"),
            None
        ));
        // 成员白名单：匹配放行、不匹配拒绝
        assert!(ingest_allowed(
            &qq,
            group_binding.as_ref(),
            "qq:group:group-a",
            Some("member-1"),
            None
        ));
        assert!(!ingest_allowed(
            &qq,
            group_binding.as_ref(),
            "qq:group:group-a",
            Some("stranger"),
            None
        ));
        // 私聊白名单：按 user_openid
        let c2c_binding = config.binding("qq:user:user-1");
        assert!(ingest_allowed(
            &qq,
            c2c_binding.as_ref(),
            "qq:user:user-1",
            None,
            Some("user-1")
        ));
        assert!(!ingest_allowed(
            &qq,
            c2c_binding.as_ref(),
            "qq:user:user-1",
            None,
            Some("user-2")
        ));
        // 群级白名单配置了 group-a：any 群被拒绝
        assert!(!ingest_allowed(
            &qq,
            None,
            "qq:group:any",
            Some("whoever"),
            None
        ));
        // 无群级白名单 + 无绑定 → 放行
        let open = config_with(
            r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
        );
        assert!(ingest_allowed(
            &open.qq_config(),
            None,
            "qq:group:any",
            Some("whoever"),
            None
        ));
    }

    #[test]
    fn qq_chat_type_roundtrips_via_from_str_and_as_str() {
        // R14：wire 形态 "c2c"/"group" 与枚举互转；非法值类型层拒绝
        assert_eq!("c2c".parse::<QqChatType>(), Ok(QqChatType::C2C));
        assert_eq!("group".parse::<QqChatType>(), Ok(QqChatType::Group));
        assert_eq!(QqChatType::C2C.as_str(), "c2c");
        assert_eq!(QqChatType::Group.as_str(), "group");
        assert_eq!(format!("{}:123", QqChatType::Group), "group:123");
        assert!("groupp".parse::<QqChatType>().is_err());
        assert!("".parse::<QqChatType>().is_err());
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
    fn empty_content_is_dropped_without_consuming_seen_window() {
        // S9：入站空文本（@bot 后无文字、无附件）与白名单拒绝同语义——
        // 入口拦截返回 Ok(None)、不占 seen 窗口；同一 msg_id 换成非空内容
        // 仍可正常处理（拦截先于 dedup.is_new）。
        let core = core_with_route();
        let adapter = test_adapter(core);
        for (msg_id, empty) in [("msg-empty", ""), ("msg-blank", "   "), ("msg-ws", "\t\n ")] {
            let dropped = adapter
                .handle_incoming("qq:group:123", msg_id, empty, None, None)
                .expect("ingest");
            assert!(dropped.is_none(), "空 content 必须丢弃: {empty:?}");
        }
        // 同一 msg_id 换非空内容 → 正常入站（空消息未占 seen）
        let valid = adapter
            .handle_incoming("qq:group:123", "msg-empty", "你好", None, None)
            .expect("ingest")
            .expect("同一 msg_id 的非空内容必须正常处理");
        assert_eq!(valid.content, "你好");
        assert_eq!(valid.msg_id.as_deref(), Some("msg-empty"));
        // 处理过之后同一 msg_id 重放 → 正常去重
        let replay = adapter
            .handle_incoming("qq:group:123", "msg-empty", "重复", None, None)
            .expect("ingest");
        assert!(replay.is_none(), "已处理消息重放必须去重");
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
    fn handle_incoming_binding_matches_whitelist_snapshot() {
        // S5：白名单判定与投递路由出自同一配置快照——解析结果携带的 binding
        // 与白名单判定所用的 binding 一致（旧实现白名单后经 core.ingest() 二次
        // 读锁，reload 窗口下存在"旧绑定放行 → 新绑定投递/回退 active agent"
        // 的白名单与实际接收 agent 不一致窗口）。
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
        let adapter = test_adapter(core.clone());
        // 白名单放行 → 解析结果携带与快照一致的 binding（白名单命中的同一绑定）
        let resolved = adapter
            .handle_incoming("qq:group:123", "msg-1", "hi", Some("member-1"), None)
            .expect("ingest")
            .expect("白名单成员必须放行");
        let binding = resolved.binding.expect("路由命中必须携带 binding");
        assert_eq!(binding.agent_id, "peri");
        assert_eq!(binding.profile_id, "trpg");
        assert_eq!(binding.session_key, "战役1");
        // 与 gateway 路由表（同一配置版本）完全一致
        assert_eq!(core.binding("qq:group:123"), Some(binding));
    }

    #[test]
    fn reload_keeps_allowlist_and_binding_on_same_snapshot() {
        // S5 端到端：热重载后白名单与路由绑定来自同一新快照——旧成员按新
        // 白名单拒绝，新成员放行且解析结果携带新 binding（无"旧绑定判定 +
        // 新绑定投递"混搭）。
        let core = Arc::new(GatewayCore::from_config(
            crate::gateway::route::parse_config(
                r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      allow_from: [old-member]
"#,
            )
            .expect("合法路由配置"),
        ));
        let adapter = test_adapter(core.clone());
        core.reload(
            crate::gateway::route::parse_config(
                r#"
gateway:
  routes:
    - source: qq:group:123
      agent: hermes
      profile: default
      session: 新战役
      allow_from: [new-member]
"#,
            )
            .expect("合法路由配置"),
        )
        .expect("reload 必须成功");
        let rejected = adapter
            .handle_incoming("qq:group:123", "msg-1", "hi", Some("old-member"), None)
            .expect("ingest");
        assert!(rejected.is_none(), "重载后旧成员必须按新白名单拒绝");
        let accepted = adapter
            .handle_incoming("qq:group:123", "msg-2", "hi", Some("new-member"), None)
            .expect("ingest")
            .expect("重载后新成员必须放行");
        assert_eq!(accepted.binding.as_ref().unwrap().agent_id, "hermes");
        assert_eq!(accepted.binding.as_ref().unwrap().session_key, "新战役");
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
    fn rollback_seen_allows_reingest_after_failure() {
        // C14：ingest 发送失败后 rollback_seen → 同一 msg_id 可重新 ingest
        let core = core_with_route();
        let adapter = test_adapter(core);
        let first = adapter
            .handle_incoming("qq:group:123", "msg-1", "你好", None, None)
            .expect("ingest");
        assert!(first.is_some());
        let replay = adapter
            .handle_incoming("qq:group:123", "msg-1", "你好", None, None)
            .expect("ingest");
        assert!(replay.is_none(), "已处理消息重放必须去重");
        // 发送失败回滚 → 重放重新可入
        adapter.rollback_seen("msg-1");
        let reprocessed = adapter
            .handle_incoming("qq:group:123", "msg-1", "你好", None, None)
            .expect("ingest")
            .expect("rollback 后同一 msg_id 必须可重入");
        assert_eq!(
            reprocessed.msg_id.as_deref(),
            Some("msg-1"),
            "解析结果必须携带 msg_id（lib.rs 回滚依赖）"
        );
        // rollback 未记录过的 id 安全
        adapter.rollback_seen("never-seen");
    }

    #[test]
    fn deliver_event_is_logged_not_sent() {
        let core = core_with_route();
        let adapter = test_adapter(core);
        assert!(adapter
            .deliver_event(
                "qq:group:123",
                crate::event_names::SESSION_DONE,
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
    fn anchor_keys_isolate_group_and_c2c_with_same_id() {
        // O40：群聊与私聊同 id（group:123 / c2c:123）回复锚点互不串扰
        let core = core_with_route();
        let adapter = test_adapter(core);
        adapter
            .handle_incoming("qq:group:123", "msg-g1", "hi", None, None)
            .expect("group ingest");
        adapter
            .handle_incoming("qq:user:123", "msg-c1", "hi", None, None)
            .expect("c2c ingest");
        let dedup = adapter.dedup.lock().unwrap();
        assert_eq!(dedup.latest_for("group:123"), Some("msg-g1"));
        assert_eq!(dedup.latest_for("c2c:123"), Some("msg-c1"));
        assert_eq!(dedup.latest_for("123"), None, "不得存在裸 id 键");
    }

    #[test]
    fn dead_target_short_circuit_is_isolated_per_chat_type() {
        // O40：group:123 标记死目标，同 id 的 c2c:123 不受影响（不短路）
        let core = core_with_route();
        let adapter = test_adapter(core);
        adapter.dead_targets.lock().unwrap().insert(
            "group:123".to_string(),
            ("forbidden".to_string(), Instant::now()),
        );
        // 群聊 → 短路丢弃（Ok 且不投递）
        assert!(adapter.deliver_text("qq:group:123", "hi").is_ok());
        // 同 id 私聊 → 未标记死目标，无 runtime 时走到 runtime 检查报错（未短路）
        let error = adapter
            .deliver_text("qq:user:123", "hi")
            .expect_err("c2c 未短路");
        assert!(
            error.contains("runtime"),
            "c2c:123 不应走死目标短路: {error}"
        );
    }

    /// 顺序响应桩：依次为每个连接返回对应响应（O42 集成测试：
    /// 第 1 个连接回 429（限流），第 2 个回 403（死目标））。
    fn spawn_sequence_server(
        responses: &'static [&'static [u8]],
    ) -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("listener address");
        let server = std::thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept request");
                let mut buffer = [0_u8; 1024];
                let _ = stream.read(&mut buffer).expect("read request");
                stream.write_all(response).expect("write response");
            }
        });
        (address, server)
    }

    #[tokio::test]
    async fn rate_retry_dead_target_failure_is_marked() {
        // O42：rate 限流重试一次后仍失败且为死目标（403）→ 标记死目标
        // （原实现重试失败只 log，永不标记）。
        let (address, server) = spawn_sequence_server(&[
            b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ]);
        let core = core_with_route();
        let auth = Arc::new(QqAuth::for_testing("test-token".to_string()));
        let adapter =
            QqAdapter::for_testing(core, Client::new(), auth, format!("http://{}", address));
        adapter
            .deliver_text("qq:group:123", "hi")
            .expect("deliver must enqueue");
        // 等待死目标标记（rate 重试在测试态 1s 后执行）
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let marked = adapter
                .dead_targets
                .lock()
                .unwrap()
                .get("group:123")
                .map(|(reason, _)| reason.clone());
            if let Some(reason) = marked {
                assert!(reason.contains("403"), "死目标原因应为 403: {reason}");
                break;
            }
            assert!(Instant::now() < deadline, "rate 重试后死目标未在限期内标记");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        server.join().expect("server thread");
    }

    /// 捕获 Layer（O43 节流断言：统计"短路"告警条数）。
    /// 全局默认 subscriber——callsite interest 是进程级缓存：首次注册的线程
    /// 若无全局默认订阅者会把 interest 算成 never()（永久静音该 callsite），
    /// with_default 的线程局部订阅者救不回来；set_global_default 会重建全部
    /// callsite interest，保证告警必然到达捕获层。本测试是唯一注册全局
    /// subscriber 的测试，必成功；其他测试的 group:123 告警与本测试的
    /// group:456 计数互不干扰。
    struct CapturingLayer {
        records: Arc<Mutex<Vec<String>>>,
    }

    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CapturingLayer {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if event.metadata().level() > &tracing::Level::WARN {
                return;
            }
            let mut message = String::new();
            struct Message<'a>(&'a mut String);
            impl tracing::field::Visit for Message<'_> {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    if field.name() == "message" && self.0.is_empty() {
                        self.0.push_str(&format!("{value:?}"));
                    }
                }
                fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                    if field.name() == "message" {
                        self.0.push_str(value);
                    }
                }
            }
            event.record(&mut Message(&mut message));
            self.records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(format!("{}: {}", event.metadata().level(), message));
        }
    }

    #[test]
    fn dead_target_short_circuit_warn_is_throttled_to_one_per_second() {
        // 用独有 chat id（group:456）隔离并行测试的日志干扰——全局捕获只认
        // 本 key 的告警，其他测试的"短路"告警（如 group:123）不得计入本测试计数。
        let records: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let subscriber = CapturingLayer {
            records: records.clone(),
        }
        .with_subscriber(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .finish(),
        );
        tracing::subscriber::set_global_default(subscriber)
            .expect("本测试是唯一注册全局 subscriber 的测试");
        let core = core_with_route();
        let adapter = test_adapter(core);
        adapter.dead_targets.lock().unwrap().insert(
            "group:456".to_string(),
            ("forbidden".to_string(), Instant::now()),
        );
        let warn_count = || {
            records
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .filter(|record| record.contains("group:456"))
                .count()
        };
        // 同 1s 内连续 3 条 → 只告警 1 次，节流表只留 1 条
        for _ in 0..3 {
            adapter
                .deliver_text("qq:group:456", "hi")
                .expect("短路返回 Ok");
        }
        assert_eq!(warn_count(), 1, "1s 内同 key 至多一条短路告警");
        assert_eq!(
            adapter.short_circuit_warns.lock().unwrap().len(),
            1,
            "节流表只记录一条"
        );
        // 间隔超过 1s 后再次投递 → 恢复告警
        std::thread::sleep(DEAD_TARGET_WARN_INTERVAL + Duration::from_millis(100));
        adapter
            .deliver_text("qq:group:456", "hi")
            .expect("短路返回 Ok");
        assert_eq!(warn_count(), 2, "1s 后应恢复告警");
    }

    #[tokio::test]
    async fn idle_exit_triggers_token_and_deliver_rebuilds_worker() {
        // R10：空闲退出触发 cancel token 并移除条目；再次 deliver 重建新 worker
        // （新 token）。桩 server 两个连接均被消费 ⇒ 两条消息都真实发出。
        let (address, server) = spawn_sequence_server(&[
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"id\":\"msg-1\"}",
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"id\":\"msg-2\"}",
        ]);
        let core = core_with_route();
        let auth = Arc::new(QqAuth::for_testing("test-token".to_string()));
        let adapter =
            QqAdapter::for_testing(core, Client::new(), auth, format!("http://{}", address));
        adapter
            .deliver_text("qq:group:123", "first")
            .expect("deliver must enqueue");
        let token1 = adapter
            .senders
            .lock()
            .unwrap()
            .get("group:123")
            .expect("worker1 必须存在")
            .token
            .clone();
        assert!(!token1.is_cancelled(), "新 worker token 未触发");
        // 空闲超时（测试态 SEND_LOOP_IDLE_SECS=1s）→ token 触发 + map 条目移除
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(token1.is_cancelled(), "空闲退出必须触发 token");
        assert!(
            adapter.senders.lock().unwrap().get("group:123").is_none(),
            "旧 worker 必须已从 map 移除"
        );
        // 再次投递 → 重建新 worker（新 token）
        adapter
            .deliver_text("qq:group:123", "second")
            .expect("deliver must enqueue");
        let token2 = adapter
            .senders
            .lock()
            .unwrap()
            .get("group:123")
            .expect("worker2 必须重建")
            .token
            .clone();
        assert_ne!(token1, token2, "重建必须使用新 token");
        assert!(!token2.is_cancelled());
        // 第二个 worker 同样空闲退出（两条消息均已发出并消费两个桩连接）
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(
            adapter.senders.lock().unwrap().get("group:123").is_none(),
            "新 worker 也应空闲退出"
        );
        server.join().expect("server thread");
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
