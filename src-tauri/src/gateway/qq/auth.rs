//! QQ Bot OAuth2 Token 管理（BE-B10-004）。
//!
//! POST /app/getAppAccessToken → 缓存 access_token + 过期时间。
//! Singleflight 锁避免并发刷新。移植自 Prism `src/qq/auth.rs`。
//!
//! 凭据由构造参数传入（PYLON_QQ_APP_ID / PYLON_QQ_CLIENT_SECRET 在 run() 接线，
//! 本模块不读 env、不依赖 tauri）。已接线（B10.2）：QqAuth/get_gateway_url 由
//! QQ 适配器与 WS 循环消费。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Client;
use tokio::sync::Mutex as AsyncMutex;

use super::types::{
    GatewayResponse, TokenRequest, TokenResponse, API_BASE, GATEWAY_URL_PATH, TOKEN_URL,
};

const DEFAULT_EXPIRES_IN_SECS: i64 = 7200;
const MAX_EXPIRES_IN_SECS: i64 = 30 * 24 * 60 * 60;
const TOKEN_REFRESH_MARGIN: Duration = Duration::from_secs(60);

fn token_expiry(now: Instant, expires_in: i64) -> Result<Instant, String> {
    if !(1..=MAX_EXPIRES_IN_SECS).contains(&expires_in) {
        return Err(format!("token expires_in 超出允许范围: {expires_in}"));
    }
    now.checked_add(Duration::from_secs(expires_in as u64))
        .ok_or_else(|| "token expires_in 导致时间溢出".to_string())
}

fn token_is_fresh(now: Instant, expires_at: Instant) -> bool {
    expires_at
        .checked_duration_since(now)
        .is_some_and(|remaining| remaining > TOKEN_REFRESH_MARGIN)
}

/// OAuth2 token 管理器
pub struct QqAuth {
    client: Client,
    app_id: String,
    client_secret: String,
    /// token 与过期时间合并单锁快照——双 Mutex 撕裂读会在刷新窗口返回过期 token。
    token: Mutex<Option<(String, Instant)>>,
    refresh_lock: AsyncMutex<()>,
}

impl QqAuth {
    pub fn new(client: Client, app_id: String, client_secret: String) -> Self {
        Self {
            client,
            app_id,
            client_secret,
            token: Mutex::new(None),
            refresh_lock: AsyncMutex::new(()),
        }
    }

    /// 获取有效 token，必要时刷新
    pub async fn get_token(&self) -> Result<String, String> {
        // 快速路径: token 未过期
        {
            let guard = self.token.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((token, expires)) = guard.as_ref() {
                if token_is_fresh(Instant::now(), *expires) {
                    return Ok(token.clone());
                }
            }
        }

        // 需要刷新 — 拿锁
        let _lock = self.refresh_lock.lock().await;

        // Double-check（可能被其他协程刷新了）
        {
            let guard = self.token.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((token, expires)) = guard.as_ref() {
                if token_is_fresh(Instant::now(), *expires) {
                    return Ok(token.clone());
                }
            }
        }

        // 请求新 token
        let resp = self
            .client
            .post(TOKEN_URL)
            .json(&TokenRequest {
                app_id: self.app_id.clone(),
                client_secret: self.client_secret.clone(),
            })
            .send()
            .await
            .map_err(|e| format!("获取 token 失败: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Token API 返回错误: {body}"));
        }

        let data: TokenResponse = resp
            .json()
            .await
            .map_err(|e| format!("解析 token 响应失败: {e}"))?;

        let expires_in = data.expires_in.unwrap_or(DEFAULT_EXPIRES_IN_SECS);
        let expires_at = token_expiry(Instant::now(), expires_in)?;
        let token = data.access_token.clone();

        *self.token.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((data.access_token, expires_at));

        log::info!("QQ token 已刷新，有效期 {} 秒", expires_in);
        Ok(token)
    }

    /// 强制清除缓存 token
    pub fn invalidate(&self) {
        *self.token.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// 测试构造：预设固定 token（不触发刷新；集成测试避免打真实 QQ API）。
    #[cfg(test)]
    pub(crate) fn for_testing(token: String) -> Self {
        let auth = Self::new(
            Client::new(),
            "test-app".to_string(),
            "test-secret".to_string(),
        );
        *auth.token.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((token, Instant::now() + Duration::from_secs(3600)));
        auth
    }
}

/// 获取 Gateway WebSocket URL
pub async fn get_gateway_url(client: &Client, token: &str) -> Result<String, String> {
    let url = format!("{}{}", API_BASE, GATEWAY_URL_PATH);
    let resp = client
        .get(&url)
        .header("Authorization", format!("QQBot {token}"))
        .send()
        .await
        .map_err(|e| format!("获取 Gateway URL 失败: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Gateway URL API 返回错误: {body}"));
    }

    let data: GatewayResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析 Gateway URL 失败: {e}"))?;

    Ok(data.url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn token_expiry_rejects_non_positive_lifetime() {
        assert!(token_expiry(Instant::now(), 0).is_err());
        assert!(token_expiry(Instant::now(), -1).is_err());
    }

    #[test]
    fn token_expiry_rejects_unreasonably_large_lifetime() {
        assert!(token_expiry(Instant::now(), 31 * 24 * 60 * 60).is_err());
    }

    #[test]
    fn token_expiry_uses_checked_instant_addition() {
        let now = Instant::now();
        let expiry = token_expiry(now, 120).unwrap();
        assert_eq!(
            expiry.checked_duration_since(now),
            Some(Duration::from_secs(120))
        );
    }

    /// 快速路径并发一致性：N 个任务同时 get_token，全部拿到同一缓存 token，
    /// 且不触发真实刷新（任何刷新都会打到真实 QQ API 而失败，故成功即证明）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_get_token_returns_cached_token() {
        let auth = std::sync::Arc::new(QqAuth::for_testing("test-token".to_string()));
        let mut handles = Vec::with_capacity(64);
        for _ in 0..64 {
            let auth = auth.clone();
            handles.push(tokio::spawn(async move { auth.get_token().await }));
        }
        for handle in handles {
            assert_eq!(handle.await.unwrap().unwrap(), "test-token");
        }
    }

    /// 单飞逻辑测试：无缓存 token 时 N 个并发 get_token 全部阻塞在 refresh_lock，
    /// 由唯一一次刷新写入（本测试注入）的 token 经 double-check 服务，
    /// 不产生任何额外刷新请求（额外刷新会打到真实 QQ API 而失败）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_get_token_singleflight_no_extra_refresh() {
        let auth = std::sync::Arc::new(QqAuth::new(
            Client::new(),
            "test-app".to_string(),
            "test-secret".to_string(),
        ));

        // 模拟唯一一次刷新者：先持有 refresh_lock
        let lock_guard = auth.refresh_lock.lock().await;

        const N: usize = 32;
        let (tx, mut rx) = tokio::sync::mpsc::channel(N);
        let mut handles = Vec::with_capacity(N);
        for _ in 0..N {
            let auth = auth.clone();
            let tx = tx.clone();
            handles.push(tokio::spawn(async move {
                tx.send(()).await.expect("channel 发送失败");
                auth.get_token().await
            }));
        }
        // 确认所有任务已进入 get_token（无缓存 token，只能阻塞在 refresh_lock）
        for _ in 0..N {
            rx.recv().await.expect("任务未全部启动");
        }

        // 唯一一次刷新写入
        *auth.token.lock().unwrap_or_else(|p| p.into_inner()) = Some((
            "singleflight-token".to_string(),
            Instant::now() + Duration::from_secs(3600),
        ));
        drop(lock_guard);

        for handle in handles {
            assert_eq!(handle.await.unwrap().unwrap(), "singleflight-token");
        }
    }

    /// 锁中毒恢复：毒化 token mutex 后 invalidate / 写入 / 读取仍可用
    /// （unwrap_or_else(|p| p.into_inner()) 顺带修复）。
    #[test]
    fn token_mutex_poison_recovered() {
        let auth = QqAuth::for_testing("poisoned-token".to_string());
        let poisoned = std::panic::catch_unwind(|| {
            let _guard = auth.token.lock().unwrap();
            panic!("故意毒化 token mutex");
        });
        assert!(poisoned.is_err(), "测试前提：mutex 应已被毒化");

        auth.invalidate();
        *auth.token.lock().unwrap_or_else(|p| p.into_inner()) = Some((
            "recovered-token".to_string(),
            Instant::now() + Duration::from_secs(3600),
        ));
        let guard = auth.token.lock().unwrap_or_else(|p| p.into_inner());
        let (token, _) = guard.as_ref().unwrap();
        assert_eq!(token, "recovered-token");
    }
}
