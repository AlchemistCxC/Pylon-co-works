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
    access_token: Mutex<Option<String>>,
    expires_at: Mutex<Instant>,
    refresh_lock: AsyncMutex<()>,
}

impl QqAuth {
    pub fn new(client: Client, app_id: String, client_secret: String) -> Self {
        Self {
            client,
            app_id,
            client_secret,
            access_token: Mutex::new(None),
            expires_at: Mutex::new(Instant::now()),
            refresh_lock: AsyncMutex::new(()),
        }
    }

    /// 获取有效 token，必要时刷新
    pub async fn get_token(&self) -> Result<String, String> {
        // 快速路径: token 未过期
        {
            let expires = *self.expires_at.lock().unwrap();
            let token = self.access_token.lock().unwrap().clone();
            if let Some(t) = token {
                if token_is_fresh(Instant::now(), expires) {
                    return Ok(t);
                }
            }
        }

        // 需要刷新 — 拿锁
        let _lock = self.refresh_lock.lock().await;

        // Double-check（可能被其他协程刷新了）
        {
            let expires = *self.expires_at.lock().unwrap();
            let token = self.access_token.lock().unwrap().clone();
            if let Some(t) = token {
                if token_is_fresh(Instant::now(), expires) {
                    return Ok(t);
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

        *self.access_token.lock().unwrap() = Some(data.access_token);
        *self.expires_at.lock().unwrap() = expires_at;

        log::info!("QQ token 已刷新，有效期 {} 秒", expires_in);
        Ok(token)
    }

    /// 强制清除缓存 token
    pub fn invalidate(&self) {
        *self.access_token.lock().unwrap() = None;
        *self.expires_at.lock().unwrap() = Instant::now();
    }

    /// 测试构造：预设固定 token（不触发刷新；集成测试避免打真实 QQ API）。
    #[cfg(test)]
    pub(crate) fn for_testing(token: String) -> Self {
        let auth = Self::new(Client::new(), "test-app".to_string(), "test-secret".to_string());
        *auth.access_token.lock().unwrap() = Some(token);
        *auth.expires_at.lock().unwrap() = Instant::now() + Duration::from_secs(3600);
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
    use super::token_expiry;
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
}
