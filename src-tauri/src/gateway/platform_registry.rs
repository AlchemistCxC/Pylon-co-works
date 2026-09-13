//! 平台注册表（P78）：gateway 适配器插件化的单一真源。
//!
//! 新增平台的全部改动收敛于 [`platform_entries`] 中的一个条目（对照 Hermes
//! `gateway/platform_registry.py` 平台清单 + `run._create_adapter` 工厂分发 +
//! ADDING_A_PLATFORM 的 env_enablement 引导位）：
//!
//! - **catalog 条目**：前端可见能力/凭据字段；NotImplemented 平台状态稳定不可用
//!   （`NotInstalled` 能力全空，绝不伪造可用——catalog.rs L1 契约）。
//! - **factory 构造器**：真实适配器（`None` = 无 adapter，不可 start）。
//! - **env 引导**：无实例配置时的环境变量启动路径（legacy `PYLON_QQ_*`）。
//!
//! 宿主 lib.rs 只调用 [`register_platform_factories`] 与 [`bootstrap_env_adapters`]
//! 两个平台无关入口；[`super::catalog::builtin_catalog`] 亦从本表导出——
//! 新增平台（微信/飞书…）不再触碰 lib.rs 与 catalog.rs。

use std::sync::Arc;

use reqwest::Client;

use super::catalog::{
    AdapterCapabilities, AdapterCatalogItem, CredentialField, PlatformAvailability,
};
use super::instance::{AdapterFactory, GatewayInstanceService};
use super::GatewayCore;

/// factory 构造器：依应用级依赖（core + 共用 HTTP client）构造平台 factory。
type PlatformFactoryBuilder = fn(Arc<GatewayCore>, Client) -> Arc<dyn AdapterFactory>;

/// 平台注册表条目：catalog + 可选 factory + 可选 env 引导（字段语义见模块头）。
pub(crate) struct PlatformEntry {
    pub catalog: AdapterCatalogItem,
    /// 真实适配器 factory 构造器；None = 未实现平台（不可创建可运行实例）。
    pub factory: Option<PlatformFactoryBuilder>,
    /// env-only 引导（legacy 路径）；None = 无。
    pub env_bootstrap: Option<fn(&Arc<GatewayCore>)>,
}

/// 平台清单：当前仅 QQ 有真实适配器；微信为 NotInstalled 稳定占位（预留，
/// ISSUE-12 §6.13 L2）。顺序即 catalog wire 顺序（确定性测试锁定，qq 在前）。
pub(crate) fn platform_entries() -> Vec<PlatformEntry> {
    vec![
        PlatformEntry {
            catalog: AdapterCatalogItem {
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
            factory: Some(qq_factory),
            env_bootstrap: Some(super::qq::factory::env_bootstrap),
        },
        PlatformEntry {
            catalog: AdapterCatalogItem {
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
            factory: None,
            env_bootstrap: None,
        },
    ]
}

fn qq_factory(core: Arc<GatewayCore>, http: Client) -> Arc<dyn AdapterFactory> {
    Arc::new(super::qq::factory::QqAdapterFactory::new(core, http))
}

/// 把全部带真实适配器的平台 factory 一次性注册进实例服务（lib.rs setup 调用）。
/// 未实现平台（factory=None）跳过——其实例 start 返回结构化 AdapterUnavailable。
pub(crate) fn register_platform_factories(
    service: &GatewayInstanceService,
    core: Arc<GatewayCore>,
    http: Client,
) {
    for entry in platform_entries() {
        let Some(factory) = entry.factory else {
            continue;
        };
        service.register_factory(factory(core.clone(), http.clone()));
    }
}

/// env-only 引导（legacy）：凭环境变量存在的适配器启动时注册进 core 并拉起
/// 连接循环（当前仅 QQ；不创建实例身份，与实例路径并存，语义不变）。
pub(crate) fn bootstrap_env_adapters(core: &Arc<GatewayCore>) {
    for entry in platform_entries() {
        if let Some(bootstrap) = entry.env_bootstrap {
            bootstrap(core);
        }
    }
}

/// catalog 导出（`gateway_catalog` 命令数据源；wire 形状由 catalog.rs 测试锁定）。
pub(crate) fn catalog_items() -> Vec<AdapterCatalogItem> {
    platform_entries()
        .into_iter()
        .map(|entry| entry.catalog)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_order_and_capabilities_are_stable() {
        let entries = platform_entries();
        let platforms: Vec<&str> = entries
            .iter()
            .map(|e| e.catalog.platform.as_str())
            .collect();
        assert_eq!(
            platforms,
            vec!["qq", "wechat"],
            "平台顺序即 catalog wire 顺序"
        );
        let [qq, wechat] = entries.as_slice() else {
            panic!("恰好两个平台条目");
        };
        assert_eq!(qq.catalog.availability, PlatformAvailability::BuiltIn);
        assert!(qq.factory.is_some(), "qq 必须有真实适配器 factory");
        assert!(
            qq.env_bootstrap.is_some(),
            "qq 保留 env 引导（legacy 路径）"
        );
        assert_eq!(
            wechat.catalog.availability,
            PlatformAvailability::NotInstalled
        );
        assert!(wechat.factory.is_none(), "未实现平台不得伪造 factory");
        assert!(wechat.env_bootstrap.is_none());
        assert!(
            wechat.catalog.credential_fields.is_empty(),
            "未实现平台无凭据字段（不可创建）"
        );
    }

    #[test]
    fn catalog_items_mirror_entry_catalogs() {
        let entries = platform_entries();
        let items = catalog_items();
        assert_eq!(items.len(), entries.len());
        for (item, entry) in items.iter().zip(entries.iter()) {
            assert_eq!(item.platform, entry.catalog.platform);
            assert_eq!(item.availability, entry.catalog.availability);
        }
    }

    #[tokio::test]
    async fn register_platform_factories_enables_qq_instance_start_path() {
        // 注册表接线证明：经 register_platform_factories 注册后，qq 实例 start
        // 能走到 factory.create（无凭据 → QQ factory 的 credential_missing，
        // 而非「adapter factory 未注册」的 AdapterUnavailable）。
        let service = GatewayInstanceService::new();
        register_platform_factories(&service, Arc::new(GatewayCore::new()), Client::new());
        service
            .create(super::super::instance::CreateInstanceInput {
                id: "qq-reg-1".into(),
                platform: "qq".into(),
                label: "registry qq".into(),
                enabled: true,
                auto_start: false,
            })
            .await
            .expect("create ok");
        let error = service
            .start("qq-reg-1")
            .await
            .expect_err("无凭据 start 必须失败");
        assert_eq!(
            error.code(),
            "credential_missing",
            "factory 已注册 → 走到凭据校验: {error}"
        );
    }

    #[tokio::test]
    async fn unimplemented_platform_start_is_adapter_unavailable() {
        // 预留平台的失败形态：wechat 实例 start → 结构化 AdapterUnavailable
        // （不可用状态稳定，绝不伪造可运行）。
        let service = GatewayInstanceService::new();
        register_platform_factories(&service, Arc::new(GatewayCore::new()), Client::new());
        service
            .create(super::super::instance::CreateInstanceInput {
                id: "wx-1".into(),
                platform: "wechat".into(),
                label: "wx".into(),
                enabled: true,
                auto_start: false,
            })
            .await
            .expect("create ok");
        let error = service
            .start("wx-1")
            .await
            .expect_err("无 factory 必须失败");
        assert_eq!(error.code(), "adapter_unavailable");
    }
}
