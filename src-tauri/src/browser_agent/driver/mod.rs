//! Agent 浏览器驱动层：快照枚举（JS，跨平台）与可信操作传输（CDP，Windows）。
//!
//! 分层（spec §2 矩阵的实现化裁剪）：
//! - **快照**：JS 单轮枚举（role/name/center/selector），两平台一致——CDP AX 树
//!   不携带几何信息，逐节点 `DOM.getBoxModel` 需要几百次往返，收益不成比例；
//!   见开发记录的偏差说明。
//! - **操作**：Windows 优先 CDP `Input.*` 可信事件（`isTrusted=true`），失败自动
//!   降级 JS 合成事件；结果 `driver` 字段标注实际传输。
//! - **感知**：截图/MHTML/网络观测/请求拦截仅 CDP；等待策略两平台都有
//!   （CDP 用网络事件环形缓冲，JS 用轮询）。

pub(crate) mod js;
// CDP 传输在 `browser_agent::cdp`（文件级 `#![cfg(windows)]`：非 Windows 编译为空
// 模块，能力缺失由命令层显式返回 `unsupported_on_platform`）。

/// 一次页面快照中的可交互元素（ref 序列由 Rust 侧分配）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotElement {
    pub(crate) reference: String,
    pub(crate) role: String,
    pub(crate) name: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) selector: String,
    /// link 角色的 href（其余为 null）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) href: Option<String>,
}

/// 网络请求观测条目（环形缓冲，per-tab）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkEntry {
    pub(crate) request_id: String,
    pub(crate) url: String,
    pub(crate) method: String,
    pub(crate) status: Option<u32>,
    pub(crate) resource_type: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) state: &'static str,
    pub(crate) at_ms: u64,
}

/// `browser_wait` 的等待语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WaitUntil {
    Load,
    NetworkIdle,
    Selector,
}

impl WaitUntil {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "load" => Some(Self::Load),
            "network_idle" => Some(Self::NetworkIdle),
            "selector" => Some(Self::Selector),
            _ => None,
        }
    }
}

/// 每标签网络环形缓冲：请求在飞计数 + 最近活动时间 + 最近条目。
#[derive(Debug, Default)]
pub(crate) struct NetworkRing {
    pub(crate) entries: std::collections::VecDeque<NetworkEntry>,
    pub(crate) inflight: i64,
    pub(crate) last_activity_ms: u64,
}

impl NetworkRing {
    pub(crate) const CAP: usize = 200;

    pub(crate) fn note_activity(&mut self, at_ms: u64) {
        self.last_activity_ms = at_ms;
    }

    pub(crate) fn push(&mut self, entry: NetworkEntry) {
        while self.entries.len() >= Self::CAP {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    pub(crate) fn upsert_finish(
        &mut self,
        request_id: &str,
        state: &'static str,
        status: Option<u32>,
        mime_type: Option<String>,
        at_ms: u64,
    ) {
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry.request_id == request_id)
        {
            entry.state = state;
            if status.is_some() {
                entry.status = status;
            }
            if mime_type.is_some() {
                entry.mime_type = mime_type;
            }
        }
        self.note_activity(at_ms);
    }
}

/// 内置基础广告/追踪过滤域名（精简 EasyList 头部高频域，仅拦截、不计重定向）。
pub(crate) const AD_FILTER_DOMAINS: &[&str] = &[
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "google-analytics.com",
    "analytics.google.com",
    "googletagmanager.com",
    "googletagservices.com",
    "adnxs.com",
    "adsrvr.org",
    "criteo.com",
    "criteo.net",
    "taboola.com",
    "outbrain.com",
    "scorecardresearch.com",
    "quantserve.com",
    "hotjar.com",
    "mouseflow.com",
    "crazyegg.com",
    "optimizely.com",
    "branch.io",
    "amplitude.com",
    "mixpanel.com",
    "segment.io",
    "segment.com",
    "heap.io",
    "fullstory.com",
    "clarity.ms",
    "bat.bing.com",
    "ads-twitter.com",
    "analytics.tiktok.com",
    "connect.facebook.net",
    "facebook.net",
    "snap.licdn.com",
    "cdn.onesignal.com",
    "onesignal.com",
    "pushwoosh.com",
    "pushcrew.com",
    "adcolony.com",
    "applovin.com",
    "unityads.unity3d.com",
    "chartboost.com",
    "inmobi.com",
    "mopub.com",
    "pubmatic.com",
    "rubiconproject.com",
    "openx.net",
    "indexww.com",
    "casalemedia.com",
    "33across.com",
    "bidswitch.net",
    "sharethrough.com",
    "spotxchange.com",
    "teads.tv",
    "yieldmo.com",
    "liveintent.com",
    "zemanta.com",
];

/// 判断 URL 是否命中内置广告过滤域名表（host 后缀匹配，剥端口与末尾点）。
pub(crate) fn is_ad_domain(url: &url::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    AD_FILTER_DOMAINS
        .iter()
        .any(|domain| host == *domain || host.strip_suffix(&format!(".{domain}")).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wait_until_parses_known_values() {
        assert_eq!(WaitUntil::parse("load"), Some(WaitUntil::Load));
        assert_eq!(
            WaitUntil::parse("network_idle"),
            Some(WaitUntil::NetworkIdle)
        );
        assert_eq!(WaitUntil::parse("selector"), Some(WaitUntil::Selector));
        assert_eq!(WaitUntil::parse("dom"), None);
    }

    #[test]
    fn network_ring_upserts_finish_state() {
        let mut ring = NetworkRing::default();
        ring.push(NetworkEntry {
            request_id: "r1".into(),
            url: "https://example.com/api".into(),
            method: "GET".into(),
            status: None,
            resource_type: Some("XHR".into()),
            mime_type: None,
            state: "pending",
            at_ms: 10,
        });
        ring.inflight = 1;
        ring.upsert_finish(
            "r1",
            "finished",
            Some(200),
            Some("application/json".into()),
            20,
        );
        assert_eq!(ring.entries.len(), 1);
        let entry = &ring.entries[0];
        assert_eq!(entry.state, "finished");
        assert_eq!(entry.status, Some(200));
        assert_eq!(entry.mime_type.as_deref(), Some("application/json"));
        assert_eq!(ring.last_activity_ms, 20);
    }

    #[test]
    fn network_ring_caps_entries() {
        let mut ring = NetworkRing::default();
        for index in 0..(NetworkRing::CAP + 20) {
            ring.push(NetworkEntry {
                request_id: format!("r{index}"),
                url: "https://example.com".into(),
                method: "GET".into(),
                status: Some(200),
                resource_type: None,
                mime_type: None,
                state: "finished",
                at_ms: index as u64,
            });
        }
        assert_eq!(ring.entries.len(), NetworkRing::CAP);
        assert_eq!(ring.entries.front().unwrap().request_id, "r20");
    }

    #[test]
    fn ad_filter_matches_known_trackers_and_innocent_hosts() {
        assert!(is_ad_domain(
            &url::Url::parse("https://www.googletagmanager.com/gtag.js").unwrap()
        ));
        assert!(is_ad_domain(
            &url::Url::parse("https://stats.g.doubleclick.net/j").unwrap()
        ));
        assert!(!is_ad_domain(
            &url::Url::parse("https://example.com/page").unwrap()
        ));
        assert!(!is_ad_domain(
            &url::Url::parse("https://evil.com/?u=googletagmanager.com").unwrap()
        ));
    }
}
