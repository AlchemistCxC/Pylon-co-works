//! CDP 客户端门面：目标解析 + 会话复用 + 断线自愈。
//!
//! 工具层只跟 [`Cdp`] 打交道，不直接建连。这样「复用哪条会话」「什么时候重连」
//! 「目标怎么寻址」只有一处实现。

pub mod events;
pub mod http;
pub mod session;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::cdp::events::Kind;
use crate::cdp::http::TargetInfo;
use crate::cdp::session::{EvalOptions, Session};
use crate::error::{Error, Result};

/// 断线重连的尝试次数（含首次）。2 = 一次重试。
const ATTEMPTS: usize = 2;

pub struct Cdp {
    pub host: String,
    pub port: u16,
    pub timeout: Duration,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Cdp {
    pub fn new(host: impl Into<String>, port: u16, timeout: Duration) -> Self {
        Self {
            host: host.into(),
            port,
            timeout,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn endpoint(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    pub async fn targets(&self) -> Result<Vec<TargetInfo>> {
        http::fetch_targets(&self.host, self.port, self.timeout).await
    }

    pub async fn version(&self) -> Result<Value> {
        http::fetch_version(&self.host, self.port, self.timeout).await
    }

    /// 把 `target` 参数解析成唯一目标。
    ///
    /// 不传时：只有一个页面目标就直接用；多个则报错并列出全部，
    /// 让 agent 用返回值里的 id 前缀重新调用——而不是替它猜一个。
    pub async fn resolve(&self, requested: Option<&str>) -> Result<TargetInfo> {
        let endpoint = self.endpoint();
        let targets = self.targets().await?;
        let pages: Vec<TargetInfo> = targets
            .iter()
            .filter(|target| target.is_page_like() && target.is_attachable())
            .cloned()
            .collect();
        let candidates = if pages.is_empty() {
            // 有些 WebView2 版本把页面报成别的 type；退一步用「可附加」当筛选条件。
            targets
                .iter()
                .filter(|target| target.is_attachable())
                .cloned()
                .collect::<Vec<_>>()
        } else {
            pages
        };

        if candidates.is_empty() {
            return Err(Error::NoTargets { endpoint });
        }

        match requested {
            None => match candidates.len() {
                1 => candidates
                    .into_iter()
                    .next()
                    .ok_or(Error::NoTargets { endpoint }),
                _ => Err(Error::AmbiguousTarget {
                    endpoint,
                    available: describe_all(&candidates),
                }),
            },
            Some(needle) => {
                // 精确 id → id 前缀 → url 子串 → title 子串，逐级放宽。
                let found = candidates
                    .iter()
                    .find(|target| target.id == needle)
                    .or_else(|| {
                        candidates
                            .iter()
                            .find(|target| target.id.starts_with(needle))
                    })
                    .or_else(|| candidates.iter().find(|target| target.url.contains(needle)))
                    .or_else(|| {
                        candidates
                            .iter()
                            .find(|target| target.title.contains(needle))
                    });
                match found {
                    Some(target) => Ok(target.clone()),
                    None => Err(Error::UnknownTarget {
                        requested: needle.to_string(),
                        available: describe_all(&candidates),
                    }),
                }
            }
        }
    }

    /// 取得目标的活跃会话，必要时建连。
    pub async fn session(&self, requested: Option<&str>) -> Result<(TargetInfo, Arc<Session>)> {
        let target = self.resolve(requested).await?;

        // 复用的前提是连接仍然活着：reader task 退出时会把 alive 置 false，
        // 光看「表里有 entry」会在 app 重启后一直返回死会话。
        {
            let guard = self.sessions.lock().await;
            if let Some(existing) = guard.get(&target.id) {
                if existing.is_alive() {
                    return Ok((target, Arc::clone(existing)));
                }
            }
        }

        let session = Session::connect(target.clone(), self.timeout).await?;
        let mut guard = self.sessions.lock().await;
        // 并发建连时以先插入的为准，丢弃自己这条多余连接。
        let stored = guard
            .entry(target.id.clone())
            .or_insert_with(|| Arc::clone(&session));
        Ok((target, Arc::clone(stored)))
    }

    /// 丢弃某个目标的会话（重连前调用）。
    pub async fn invalidate(&self, target_id: &str) {
        self.sessions.lock().await.remove(target_id);
    }

    /// 调一个 CDP 方法，连接断开时自动重连并重试一次。
    pub async fn call(
        &self,
        requested: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let mut last_gone: Option<Error> = None;
        for _ in 0..ATTEMPTS {
            let (target, session) = self.session(requested).await?;
            match session.call(method, params.clone()).await {
                Ok(value) => return Ok(value),
                Err(Error::TargetGone { detail }) => {
                    self.invalidate(&target.id).await;
                    eprintln!(
                        "[pylon-webview2-mcp] 目标 {} 的连接断开（{detail}），重建后重试 {method}",
                        target.id
                    );
                    last_gone = Some(Error::TargetGone { detail });
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_gone.unwrap_or(Error::TargetGone {
            detail: format!("{method} 在 {ATTEMPTS} 次尝试后仍未成功"),
        }))
    }

    /// 跨超时调一个 CDP 方法（截图、全页布局这类慢操作）。
    pub async fn call_with_timeout(
        &self,
        requested: Option<&str>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let mut last_gone: Option<Error> = None;
        for _ in 0..ATTEMPTS {
            let (target, session) = self.session(requested).await?;
            match session
                .call_with_timeout(method, params.clone(), timeout)
                .await
            {
                Ok(value) => return Ok(value),
                Err(Error::TargetGone { detail }) => {
                    self.invalidate(&target.id).await;
                    last_gone = Some(Error::TargetGone { detail });
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_gone.unwrap_or(Error::TargetGone {
            detail: format!("{method} 在 {ATTEMPTS} 次尝试后仍未成功"),
        }))
    }

    /// 求值表达式，连接断开时自动重连并重试一次。
    ///
    /// 重连后重放求值需要谨慎：写操作（例如 `emit`）会执行两次。
    /// 因此重放只覆盖「会话在**调用前**就已断开」的情形——那种情况表达式根本没跑过。
    /// 若表达式已经在远端执行，`Session::call` 返回的是 `TargetGone`（连接中途断），
    /// 此时重放可能重复副作用，所以这里不做重试，直接把错误交给调用方判断。
    pub async fn evaluate(
        &self,
        requested: Option<&str>,
        expression: &str,
        options: EvalOptions,
    ) -> Result<Value> {
        let (target, session) = self.session(requested).await?;
        match session.evaluate(expression, options).await {
            Ok(value) => Ok(value),
            Err(Error::TargetGone { detail }) => {
                self.invalidate(&target.id).await;
                Err(Error::TargetGone {
                    detail: format!(
                        "{detail}（表达式可能已执行过；本次未自动重放以避免重复副作用，请重试）"
                    ),
                })
            }
            Err(error) => Err(error),
        }
    }

    /// 取事件缓冲句柄（读日志类工具用）。
    pub async fn read_events(
        &self,
        requested: Option<&str>,
        kind: Kind,
        since_seq: Option<u64>,
        scan: usize,
        limit: usize,
        matches: impl Fn(&Value) -> bool,
    ) -> Result<(events::ReadOutcome, Value)> {
        let (_, session) = self.session(requested).await?;
        let log = session.events();
        let mut guard = log.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let outcome = guard.read(kind, since_seq, scan, limit, matches);
        let stats = guard.stats(kind);
        drop(guard);
        Ok((outcome, stats))
    }

    /// 清空某类事件缓冲。
    pub async fn reset_events(&self, requested: Option<&str>, kind: Kind) -> Result<Value> {
        let (_, session) = self.session(requested).await?;
        let log = session.events();
        let mut guard = log.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.reset(kind);
        Ok(guard.stats(kind))
    }
}

fn describe_all(targets: &[TargetInfo]) -> String {
    targets
        .iter()
        .map(TargetInfo::describe)
        .collect::<Vec<_>>()
        .join(" | ")
}
