//! QQ 平台 factory（WI-12-02）：把 WI-12-01 `AdapterFactory` seam 接到真实 QQ 适配器。
//!
//! 凭据：单 opaque `credential_secret`，格式 `app_id:client_secret`（首冒号切分；
//! QQ client_secret 为固定长度密文，不含冒号）。`create()` 依实例凭据构造
//! `QqAuth` + `QqAdapter`，并给出 cancel 感知的托管连接循环（T12-4：stop →
//! cancel → 收敛退出 → 关闭适配器 → 不留后台残余）。
//!
//! 本模块持有应用级依赖（`GatewayCore` + HTTP client），在 composition root 构造；
//! lib.rs 接线（register_factory）属后续 wave（当前 wave 文件范围不含 lib.rs）。

use std::sync::Arc;

use reqwest::Client;
use tokio_util::sync::CancellationToken;

use crate::gateway::instance::{
    AdapterFactory, BoxRunFuture, GatewayInstanceError, InstanceNotifier, InstanceState,
};
use crate::gateway::{GatewayCore, PlatformAdapter};

use super::auth::QqAuth;
use super::ws;
use super::QqAdapter;

/// QQ 平台 factory：按实例凭据构造运行期适配器与连接循环。
pub struct QqAdapterFactory {
    core: Arc<GatewayCore>,
    http: Client,
}

impl QqAdapterFactory {
    pub fn new(core: Arc<GatewayCore>, http: Client) -> Self {
        Self { core, http }
    }

    /// 解析 `app_id:client_secret` 凭据；缺失/空段 → CredentialMissing。
    /// 错误消息只含掩码值（不泄露 secret 明文，D-02 精神）。
    fn parse_credentials(secret: &str) -> Result<(String, String), GatewayInstanceError> {
        let mut parts = secret.splitn(2, ':');
        match (parts.next(), parts.next()) {
            (Some(app_id), Some(client_secret))
                if !app_id.is_empty() && !client_secret.is_empty() =>
            {
                Ok((app_id.to_string(), client_secret.to_string()))
            }
            _ => Err(GatewayInstanceError::CredentialMissing(format!(
                "QQ 凭据需为 app_id:client_secret 格式（收到 {} 个字符）",
                secret.chars().count()
            ))),
        }
    }
}

impl AdapterFactory for QqAdapterFactory {
    fn platform_key(&self) -> &str {
        "qq"
    }

    fn create(
        &self,
        state: &InstanceState,
        cancel: CancellationToken,
        notifier: InstanceNotifier,
    ) -> Result<(Arc<dyn PlatformAdapter>, BoxRunFuture), GatewayInstanceError> {
        let secret = state.credential_secret.as_deref().ok_or_else(|| {
            GatewayInstanceError::CredentialMissing(format!(
                "instance '{}' 未配置 QQ 凭据",
                state.id
            ))
        })?;
        let (app_id, client_secret) = Self::parse_credentials(secret)?;
        let auth = Arc::new(QqAuth::new(self.http.clone(), app_id, client_secret));
        let adapter = QqAdapter::new(self.core.clone(), self.http.clone(), auth.clone());
        let run: BoxRunFuture = Box::pin(ws::run_managed_ws_loop(
            self.http.clone(),
            auth,
            adapter.clone(),
            cancel,
            notifier,
        ));
        Ok((adapter, run))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::instance::{CreateInstanceInput, GatewayInstanceService, InstanceStatus};

    fn factory() -> QqAdapterFactory {
        QqAdapterFactory::new(Arc::new(GatewayCore::new()), Client::new())
    }

    #[test]
    fn platform_key_is_qq() {
        assert_eq!(factory().platform_key(), "qq");
    }

    #[test]
    fn parse_credentials_splits_on_first_colon() {
        let (app_id, secret) = QqAdapterFactory::parse_credentials("102000000:sk-abc-123").unwrap();
        assert_eq!(app_id, "102000000");
        assert_eq!(secret, "sk-abc-123");
        // client_secret 自身可含冒号：首冒号切分后其余原样保留。
        let (app_id, secret) = QqAdapterFactory::parse_credentials("102000000:a:b:c").unwrap();
        assert_eq!(app_id, "102000000");
        assert_eq!(secret, "a:b:c");
    }

    #[test]
    fn parse_credentials_rejects_missing_or_empty_segments() {
        for bad in ["no-colon", "app:", ":secret", ""] {
            let err = QqAdapterFactory::parse_credentials(bad).unwrap_err();
            assert_eq!(
                err,
                GatewayInstanceError::CredentialMissing(format!(
                    "QQ 凭据需为 app_id:client_secret 格式（收到 {} 个字符）",
                    bad.chars().count()
                ))
            );
            if !bad.is_empty() {
                assert!(
                    !err.to_string().contains(bad),
                    "错误消息不得泄露凭据值: {err}"
                );
            }
        }
    }

    #[tokio::test]
    async fn start_without_credential_is_credential_missing_and_rolls_back() {
        // 服务级（InstanceNotifier 字段私有，仅 instance.rs 可构造——这里走
        // 真实 start() 流程）：注册真实 QQ factory 后 start，create() 读
        // credential_secret=None → CredentialMissing，start 前置失败回滚 Stopped。
        let service = GatewayInstanceService::new();
        service.register_factory(Arc::new(factory()));
        service
            .create(CreateInstanceInput {
                id: "qq-bot-1".into(),
                platform: "qq".into(),
                label: "主 QQ Bot".into(),
                enabled: true,
                auto_start: true,
            })
            .await
            .expect("create ok");
        let err = match service.start("qq-bot-1").await {
            Ok(_) => panic!("无凭据时 start 必须失败"),
            Err(error) => error,
        };
        assert_eq!(err.code(), "credential_missing");
        assert!(err.to_string().contains("未配置 QQ 凭据"));
        let dto = service.get("qq-bot-1").await.expect("get ok");
        assert_eq!(
            dto.status,
            InstanceStatus::Stopped,
            "start 前置失败应回滚到 Stopped"
        );
    }
}
