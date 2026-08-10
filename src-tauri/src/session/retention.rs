//! 消息历史保留策略契约（I13-A-FE-02）。
//!
//! 本模块是保留策略的**实施契约**：设置页（前端）与后端清理调度均以此为准。
//! 契约来源：ISSUE-13 D-03（设置中提供消息历史保留策略）、ISSUE-06 D-15
//! （默认永久保存，字段缺失/解析失败回退永久保存，用户选择非永久策略必须显示
//! 预计影响，保存策略不等于立即清理）。
//!
//! - 默认永久保存：新安装、字段缺失、解析失败、未知模式、越档值一律回退
//!   `Permanent`，禁止因默认值变化自动删除历史（D-15）。
//! - 档位即契约：`TIME_DAYS_TIERS` / `COUNT_LIMIT_TIERS` 是前端下拉与后端
//!   清理调度的唯一合法取值，越档值视为非法。
//! - 本模块**只定义策略，不执行任何删除**；实际删除由消息仓库
//!   （`msg_repo`）在事务边界安全调度（D-11/D-15），设置页不得绕过。

use serde::{Deserialize, Serialize};

/// 保留模式（D-03：永久保存 / 按时间保留 / 按每 Session 消息数量保留）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RetentionMode {
    Permanent,
    ByTime,
    ByCount,
}

/// 按时间保留的档位（天）。档位即契约：越档值视为非法 → 回退永久保存。
pub(crate) const TIME_DAYS_TIERS: [u32; 5] = [7, 30, 90, 180, 365];
/// 按数量保留的档位（每 Session 消息条数）。
pub(crate) const COUNT_LIMIT_TIERS: [u32; 5] = [100, 500, 1000, 5000, 10000];
/// 选择按时间保留时的默认档位（天）。
pub(crate) const DEFAULT_TIME_DAYS: u32 = 30;
/// 选择按数量保留时的默认档位（条）。
pub(crate) const DEFAULT_COUNT_LIMIT: u32 = 1000;

/// 保留策略：`mode` 为唯一入口；`days`/`count` 仅在对应模式下有意义。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RetentionPolicy {
    pub(crate) mode: RetentionMode,
    #[serde(default)]
    pub(crate) days: Option<u32>,
    #[serde(default)]
    pub(crate) count: Option<u32>,
}

impl RetentionPolicy {
    /// D-15 默认：永久保存（不执行自动清理）。
    pub(crate) fn default_policy() -> RetentionPolicy {
        RetentionPolicy {
            mode: RetentionMode::Permanent,
            days: None,
            count: None,
        }
    }

    /// 从 JSON 解析策略；任何非法输入（解析失败 / 未知模式 / 对应档位缺失 /
    /// 档位不在契约档位内）一律回退为永久保存（D-15 回退语义）。
    pub(crate) fn parse(json: &str) -> RetentionPolicy {
        let policy: Result<RetentionPolicy, _> = serde_json::from_str(json);
        match policy {
            Ok(policy) if policy.is_valid() => policy,
            _ => RetentionPolicy::default_policy(),
        }
    }

    /// 校验策略是否满足实施契约：`permanent` 无条件合法；
    /// `by_time` 必须携带天数且为 `TIME_DAYS_TIERS` 之一；`by_count` 同理。
    pub(crate) fn is_valid(&self) -> bool {
        match self.mode {
            RetentionMode::Permanent => true,
            RetentionMode::ByTime => self
                .days
                .is_some_and(|days| TIME_DAYS_TIERS.contains(&days)),
            RetentionMode::ByCount => self
                .count
                .is_some_and(|count| COUNT_LIMIT_TIERS.contains(&count)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_permanent() {
        let p = RetentionPolicy::default_policy();
        assert_eq!(p.mode, RetentionMode::Permanent);
        assert_eq!(p.days, None);
        assert_eq!(p.count, None);
    }

    #[test]
    fn parse_permanent() {
        let p = RetentionPolicy::parse(r#"{"mode":"permanent"}"#);
        assert_eq!(p.mode, RetentionMode::Permanent);
        assert!(p.is_valid());
    }

    #[test]
    fn parse_by_time_keeps_tier_days() {
        let p = RetentionPolicy::parse(r#"{"mode":"by_time","days":90}"#);
        assert_eq!(p.mode, RetentionMode::ByTime);
        assert_eq!(p.days, Some(90));
        assert!(p.is_valid());
    }

    #[test]
    fn parse_by_count_keeps_tier_limit() {
        let p = RetentionPolicy::parse(r#"{"mode":"by_count","count":500}"#);
        assert_eq!(p.mode, RetentionMode::ByCount);
        assert_eq!(p.count, Some(500));
        assert!(p.is_valid());
    }

    #[test]
    fn parse_garbage_falls_back_to_permanent() {
        assert_eq!(
            RetentionPolicy::parse("not json"),
            RetentionPolicy::default_policy()
        );
        assert_eq!(
            RetentionPolicy::parse(""),
            RetentionPolicy::default_policy()
        );
        assert_eq!(
            RetentionPolicy::parse(r#"{"mode":"permanent","days":null}"#),
            RetentionPolicy::default_policy()
        );
    }

    #[test]
    fn parse_unknown_mode_falls_back_to_permanent() {
        assert_eq!(
            RetentionPolicy::parse(r#"{"mode":"monthly"}"#),
            RetentionPolicy::default_policy()
        );
    }

    #[test]
    fn parse_missing_field_falls_back_to_permanent() {
        // D-15：配置字段缺失 → 永久保存（不得因缺字段自动清理）
        assert_eq!(
            RetentionPolicy::parse(r#"{"mode":"by_time"}"#),
            RetentionPolicy::default_policy()
        );
        assert_eq!(
            RetentionPolicy::parse(r#"{"mode":"by_count"}"#),
            RetentionPolicy::default_policy()
        );
        assert_eq!(
            RetentionPolicy::parse(r#"{}"#),
            RetentionPolicy::default_policy()
        );
    }

    #[test]
    fn parse_out_of_tier_value_falls_back_to_permanent() {
        assert_eq!(
            RetentionPolicy::parse(r#"{"mode":"by_time","days":25}"#),
            RetentionPolicy::default_policy()
        );
        assert_eq!(
            RetentionPolicy::parse(r#"{"mode":"by_count","count":250}"#),
            RetentionPolicy::default_policy()
        );
        assert_eq!(
            RetentionPolicy::parse(r#"{"mode":"by_time","days":0}"#),
            RetentionPolicy::default_policy()
        );
    }

    #[test]
    fn time_tiers_match_contract() {
        assert_eq!(TIME_DAYS_TIERS, [7, 30, 90, 180, 365]);
        assert_eq!(DEFAULT_TIME_DAYS, 30);
    }

    #[test]
    fn count_tiers_match_contract() {
        assert_eq!(COUNT_LIMIT_TIERS, [100, 500, 1000, 5000, 10000]);
        assert_eq!(DEFAULT_COUNT_LIMIT, 1000);
    }

    #[test]
    fn validate_rejects_off_contract_policy() {
        assert!(!RetentionPolicy {
            mode: RetentionMode::ByTime,
            days: Some(25),
            count: None,
        }
        .is_valid());
        assert!(!RetentionPolicy {
            mode: RetentionMode::ByCount,
            days: None,
            count: Some(250),
        }
        .is_valid());
        assert!(!RetentionPolicy {
            mode: RetentionMode::ByTime,
            days: None,
            count: None,
        }
        .is_valid());
        assert!(!RetentionPolicy {
            mode: RetentionMode::ByCount,
            days: None,
            count: None,
        }
        .is_valid());
        assert!(RetentionPolicy::default_policy().is_valid());
    }

    #[test]
    fn serde_roundtrip_preserves_policy() {
        for json in [
            r#"{"mode":"permanent"}"#,
            r#"{"mode":"by_time","days":180}"#,
            r#"{"mode":"by_count","count":5000}"#,
        ] {
            let p = RetentionPolicy::parse(json);
            let encoded = serde_json::to_string(&p).expect("serialize");
            let decoded = RetentionPolicy::parse(&encoded);
            assert_eq!(decoded, p, "roundtrip 后策略不变: {json}");
        }
    }
}
