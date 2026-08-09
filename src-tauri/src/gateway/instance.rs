//! Adapter Instance：Bot 实例身份层（I12-A-BE-01 契约冻结；D-01 实例 identity）。
//!
//! 实例以稳定 instanceId 为主键（route 引用它；不以 platform key 代替实例身份）。
//! 凭据只暴露 credentialRef + 脱敏状态（D-02）：wire DTO 无任何凭据值字段，
//! 内部态经 [`InstanceState::to_dto`] 映射时 secret 一律丢弃。
//! [`InstanceState`] 有意不实现 Serialize——杜绝内部凭据值误序列化的路径。

use serde::Serialize;

/// 实例状态机（BE-02 生命周期收敛的目标态；本卡只冻结契约与 wire 形状）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstanceStatus {
    /// 已创建未启动 / 已停止。
    Stopped,
    /// 启动中（连接未就绪）。
    Starting,
    /// 已连接（可 ingest/deliver）。
    Connected,
    /// 启动/运行错误（last_error 携带结构化原因）。
    Error,
}

/// 凭据脱敏状态（secret 不回传；前端只看到是否配置/缺失/错误）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStatus {
    /// 未配置（创建后未填凭据）。
    Missing,
    /// 已配置（凭据引用有效）。
    Configured,
    /// 凭据存在但校验失败/损坏。
    Invalid,
}

/// Adapter Instance DTO（只读 wire 快照；无凭据值字段）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInstance {
    /// 稳定主键（route 引用它）。
    pub id: String,
    /// 所属平台 key（catalog.platform）。
    pub platform: String,
    /// 用户展示名。
    pub label: String,
    pub enabled: bool,
    /// D-06：独立 autoStart（仅应用重启后的自动启动策略；手动启停不受影响）。
    pub auto_start: bool,
    pub status: InstanceStatus,
    /// status=Error 时的结构化原因（不得包含 secret）。
    pub last_error: Option<String>,
    pub credential_status: CredentialStatus,
    /// 凭据引用 id（指向加密凭据文件；D-02）。缺失 = null。
    pub credential_ref: Option<String>,
}

/// 内部实例状态（BE-02 生命周期将维护真实实例；本卡冻结 DTO 映射规则）。
/// 内部态允许持有凭据值；映射为 wire DTO 时只保留 credential_ref + credential_status，
/// secret 一律不携带（D-02 冻结）。**本类型刻意不实现 Serialize**——内部凭据值
/// 不可能经本类型直接序列化（编译期即排除泄露路径）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceState {
    pub id: String,
    pub platform: String,
    pub label: String,
    pub enabled: bool,
    pub auto_start: bool,
    pub status: InstanceStatus,
    pub last_error: Option<String>,
    pub credential_ref: Option<String>,
    pub credential_status: CredentialStatus,
    /// 内部凭据值（secret）——仅内部持有，[`Self::to_dto`] 丢弃。
    pub credential_secret: Option<String>,
}

impl InstanceState {
    /// 内部态 → 只读 DTO：secret 永不进入 wire（D-02 冻结）。
    pub fn to_dto(&self) -> AdapterInstance {
        AdapterInstance {
            id: self.id.clone(),
            platform: self.platform.clone(),
            label: self.label.clone(),
            enabled: self.enabled,
            auto_start: self.auto_start,
            status: self.status,
            last_error: self.last_error.clone(),
            credential_ref: self.credential_ref.clone(),
            credential_status: self.credential_status,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_state() -> InstanceState {
        InstanceState {
            id: "qq-bot-1".into(),
            platform: "qq".into(),
            label: "主 QQ Bot".into(),
            enabled: true,
            auto_start: true,
            status: InstanceStatus::Connected,
            last_error: None,
            credential_ref: Some("cred-qq-bot-1".into()),
            credential_status: CredentialStatus::Configured,
            credential_secret: Some("sk-super-secret".into()),
        }
    }

    #[test]
    fn instance_dto_wire_shape_pinned_no_secret_fields() {
        let dto = sample_state().to_dto();
        let value = serde_json::to_value(&dto).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "id": "qq-bot-1",
                "platform": "qq",
                "label": "主 QQ Bot",
                "enabled": true,
                "autoStart": true,
                "status": "connected",
                "lastError": null,
                "credentialStatus": "configured",
                "credentialRef": "cred-qq-bot-1",
            }),
            "instance wire 形状必须固定（camelCase，无凭据值字段）: {value}"
        );
    }

    #[test]
    fn to_dto_drops_credential_secret_never_serialized() {
        // D-02：内部 secret 值经 to_dto 映射后必须消失；只留 credentialRef + credentialStatus
        let dto = sample_state().to_dto();
        let text = serde_json::to_string(&dto).unwrap();
        assert!(
            !text.contains("sk-super-secret"),
            "secret 不得序列化回前端: {text}"
        );
        assert_eq!(dto.credential_ref.as_deref(), Some("cred-qq-bot-1"));
        assert_eq!(dto.credential_status, CredentialStatus::Configured);
    }

    #[test]
    fn status_enums_serialize_stable_wire_values() {
        for (status, wire) in [
            (InstanceStatus::Stopped, "stopped"),
            (InstanceStatus::Starting, "starting"),
            (InstanceStatus::Connected, "connected"),
            (InstanceStatus::Error, "error"),
        ] {
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                serde_json::json!(wire)
            );
        }
        for (status, wire) in [
            (CredentialStatus::Missing, "missing"),
            (CredentialStatus::Configured, "configured"),
            (CredentialStatus::Invalid, "invalid"),
        ] {
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                serde_json::json!(wire)
            );
        }
    }

    #[test]
    fn error_status_carries_structured_last_error_without_secret() {
        let mut state = sample_state();
        state.status = InstanceStatus::Error;
        state.last_error = Some("连接超时（认证失败）".into());
        let dto = state.to_dto();
        let value = serde_json::to_value(&dto).unwrap();
        assert_eq!(value["status"], "error");
        assert_eq!(value["lastError"], "连接超时（认证失败）");
        let text = serde_json::to_string(&dto).unwrap();
        assert!(
            !text.contains("sk-super-secret"),
            "错误状态下 secret 同样不得泄露"
        );
    }
}
