//! Adapter Catalog：平台类型级能力描述（I12-A-BE-01 契约冻结；D-01 平台类型层）。
//!
//! catalog 描述"平台类型"（qq/wechat/...），与 Bot 实例（instance）分离：
//! 同一平台可有多个实例（D-01）；catalog 项本身无状态、无凭据值、无实例字段。
//! 凭据字段只描述（key/label/secret 标记），**不携带任何值**（D-02）。
//!
//! 未实现平台的状态必须稳定（不可伪造"可用"）：NotInstalled 平台能力全空、
//! 无凭据字段、前端不可启用（ISSUE-12 §6.13 L2 承载）。

use serde::Serialize;

/// 平台可用性（未实现平台状态稳定——绝不伪造可用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformAvailability {
    /// 有真实 adapter 且已打包（QQ）。
    BuiltIn,
    /// 有 schema 但无真实 adapter（微信等）——展示"未安装/待支持"，不可启用。
    NotInstalled,
    /// 平台不受支持（未来才可能进入 catalog）。
    #[allow(dead_code)] // 未来平台预留
    Unsupported,
}

/// 凭据字段描述：catalog 告知前端"创建实例需要填什么"。
/// secret=true 的字段（密钥/口令）值永不回传（D-02）；普通标识字段亦然——
/// catalog 永远只描述字段，不携带值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialField {
    /// 字段 key（配置/凭据文件索引）。
    pub key: String,
    /// 展示名。
    pub label: String,
    /// true = 敏感字段（secret）；false = 普通标识字段。
    pub secret: bool,
    /// 创建实例是否必填。
    pub required: bool,
}

/// 平台能力描述。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    /// 支持出站文本投递（deliver_text）。
    pub deliver_text: bool,
    /// 支持出站事件投递（pylon:done/error）。
    pub deliver_event: bool,
    /// 支持入站 ingest。
    pub ingest: bool,
    /// 单条文本上限（字符）；0 = 未知/不适用。
    pub max_message_len: usize,
}

/// Adapter Catalog 项：平台类型级描述（只读 wire 形状）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCatalogItem {
    /// 平台 key（"qq"/"wechat"…；同时是 source 前缀）。
    pub platform: String,
    /// 展示名。
    pub label: String,
    pub availability: PlatformAvailability,
    /// 创建实例所需凭据字段描述（只描述，不携带值）。
    pub credential_fields: Vec<CredentialField>,
    pub capabilities: AdapterCapabilities,
}

/// 内置平台 catalog（契约冻结）：qq = built-in；wechat = 未安装（稳定不可用）。
/// 平台新增时在此登记；实例/生命周期一律不在此层（D-01 分离）。
pub fn builtin_catalog() -> Vec<AdapterCatalogItem> {
    vec![
        AdapterCatalogItem {
            platform: "qq".into(),
            label: "QQ".into(),
            availability: PlatformAvailability::BuiltIn,
            credential_fields: vec![
                CredentialField {
                    key: "appId".into(),
                    label: "App ID".into(),
                    secret: false,
                    required: true,
                },
                CredentialField {
                    key: "clientSecret".into(),
                    label: "Client Secret".into(),
                    secret: true,
                    required: true,
                },
            ],
            capabilities: AdapterCapabilities {
                deliver_text: true,
                deliver_event: true,
                ingest: true,
                max_message_len: 4000,
            },
        },
        AdapterCatalogItem {
            platform: "wechat".into(),
            label: "微信".into(),
            availability: PlatformAvailability::NotInstalled,
            credential_fields: Vec::new(),
            capabilities: AdapterCapabilities {
                deliver_text: false,
                deliver_event: false,
                ingest: false,
                max_message_len: 0,
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_wire_shape_pinned_camel_case() {
        let qq = builtin_catalog()
            .into_iter()
            .find(|c| c.platform == "qq")
            .expect("qq 必须在 catalog");
        let value = serde_json::to_value(&qq).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "platform": "qq",
                "label": "QQ",
                "availability": "builtIn",
                "credentialFields": [
                    { "key": "appId", "label": "App ID", "secret": false, "required": true },
                    { "key": "clientSecret", "label": "Client Secret", "secret": true, "required": true },
                ],
                "capabilities": { "deliverText": true, "deliverEvent": true, "ingest": true, "maxMessageLen": 4000 },
            }),
            "catalog wire 形状（camelCase + 无实例字段）: {value}"
        );
    }

    #[test]
    fn catalog_has_no_instance_fields_platform_type_separated() {
        // D-01：catalog 只描述平台类型——无 id/enabled/status/凭据值等实例字段
        for item in builtin_catalog() {
            let mut keys: Vec<String> = serde_json::to_value(&item)
                .expect("serialize")
                .as_object()
                .expect("对象")
                .keys()
                .cloned()
                .collect();
            keys.sort();
            assert_eq!(
                keys,
                vec![
                    "availability".to_string(),
                    "capabilities".to_string(),
                    "credentialFields".to_string(),
                    "label".to_string(),
                    "platform".to_string(),
                ],
                "catalog 项字段集合必须固定（与实例字段分离）"
            );
        }
    }

    #[test]
    fn unimplemented_platform_status_stable_not_available() {
        // L1：未实现平台状态稳定——wechat 恒为 notInstalled、能力全空，不得伪造可用
        let wechat = builtin_catalog()
            .into_iter()
            .find(|c| c.platform == "wechat")
            .expect("wechat 必须在 catalog");
        assert_eq!(wechat.availability, PlatformAvailability::NotInstalled);
        assert_eq!(
            serde_json::to_value(&wechat.availability).unwrap(),
            serde_json::json!("notInstalled")
        );
        assert!(!wechat.capabilities.deliver_text);
        assert!(!wechat.capabilities.deliver_event);
        assert!(!wechat.capabilities.ingest);
        assert_eq!(wechat.capabilities.max_message_len, 0);
        assert!(
            wechat.credential_fields.is_empty(),
            "未实现平台无凭据字段（不可创建）"
        );
    }

    #[test]
    fn secret_credential_field_marked_but_never_valued() {
        // D-02：clientSecret 标记为 secret 字段，但 catalog 中不存在任何值承载
        let qq = builtin_catalog()
            .into_iter()
            .find(|c| c.platform == "qq")
            .expect("qq 必须在 catalog");
        let secret = qq
            .credential_fields
            .iter()
            .find(|f| f.key == "clientSecret")
            .expect("clientSecret 字段必须描述");
        assert!(secret.secret);
        let text = serde_json::to_string(&qq).unwrap();
        assert!(!text.contains("sk-"), "catalog 不得携带任何凭据值: {text}");
    }

    #[test]
    fn builtin_catalog_deterministic_order() {
        let platforms: Vec<String> = builtin_catalog().into_iter().map(|c| c.platform).collect();
        assert_eq!(
            platforms,
            vec!["qq".to_string(), "wechat".to_string()],
            "catalog 顺序必须稳定（qq 在前）"
        );
    }
}
