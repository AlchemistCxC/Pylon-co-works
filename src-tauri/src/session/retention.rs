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
//!   A1-c/B5：执行目标已切到 `canonical_events`（canonical 事件流为唯一会话
//!   数据源；by_count = 每 owner 保留最近 N 条事件）。

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
#[allow(dead_code)] // 默认档位（UI 预设展示）
pub(crate) const DEFAULT_TIME_DAYS: u32 = 30;
/// 选择按数量保留时的默认档位（条）。
#[allow(dead_code)] // 默认档位（UI 预设展示）
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
    #[allow(dead_code)] // 默认策略（UI 预设）
    pub(crate) fn default_policy() -> RetentionPolicy {
        RetentionPolicy {
            mode: RetentionMode::Permanent,
            days: None,
            count: None,
        }
    }

    /// 从 JSON 解析策略；任何非法输入（解析失败 / 未知模式 / 对应档位缺失 /
    /// 档位不在契约档位内）一律回退为永久保存（D-15 回退语义）。
    #[allow(dead_code)] // 策略 JSON 解析（UI 预设导入）
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

// ============================================================================
// I14-W9：保留策略执行接口——policy 读写 + preview + prune service（为 ISSUE-13 提供）。
// 存储：msg_repo retention_policy 单行表（version + revision + payload，schema v5）。
// 执行（B5）：MsgRepo::retention_candidates / prune_by_policy——筛选与删除均针对
// canonical_events（owner 键控；by_count 每 owner 保留最新 N 条事件）。
// spawn_blocking 边界 + 结构化错误。
// ============================================================================

use std::sync::Arc;

use serde::ser::SerializeMap;
use serde::Serialize as SerdeSerialize;

use crate::error::PylonError;
use crate::session::msg_repo::{MsgRepo, RetentionPolicyRow, RetentionPreview};

/// 保留策略执行错误（B1.2：前端按 code 分支）。
#[derive(Debug, thiserror::Error)]
pub(crate) enum RetentionError {
    #[error("保留策略非法：{0}")]
    InvalidPolicy(String),
    #[error("保留策略执行失败：{0}")]
    Unavailable(String),
    /// I13-W3：写入 revision 冲突（期望与后端当前 revision 不符，旧写不覆盖新写）。
    #[error("保留策略 revision 冲突：期望 {expected}，实际 {actual}")]
    Conflict { expected: i64, actual: i64 },
    /// I13-W4：prune 前策略 revision 已变化（预览后策略被改）→ 拒绝按旧统计执行清理。
    #[error("保留策略已变化：期望 revision {expected}，实际 {actual}；请重新预览")]
    StalePreview { expected: i64, actual: i64 },
}

impl RetentionError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::InvalidPolicy(_) => "invalid_retention_policy",
            Self::Unavailable(_) => "retention_unavailable",
            Self::Conflict { .. } => "retention_revision_conflict",
            Self::StalePreview { .. } => "retention_stale_preview",
        }
    }
}

impl SerdeSerialize for RetentionError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        map.end()
    }
}

/// 保留策略 service：spawn_blocking 边界 + 命令层 DTO（与 MessageService 同构）。
pub(crate) struct RetentionService {
    repo: Arc<MsgRepo>,
}

impl RetentionService {
    pub(crate) fn new(repo: Arc<MsgRepo>) -> Self {
        Self { repo }
    }

    /// 读取保留策略行；无 → None（调用方按默认永久保存处理，D-15）。
    pub(crate) async fn get_policy(&self) -> Result<Option<RetentionPolicyRow>, RetentionError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.retention_policy_get())
            .await
            .map_err(|error| {
                RetentionError::Unavailable(format!("retention get task failed: {error}"))
            })?
            .map_err(|error| RetentionError::Unavailable(error.to_string()))
    }

    /// 写入保留策略：先校验（mode/days/count 档位契约，D-15）——非法拒绝（前端先校验，
    /// 后端不静默落 permanent）；合法 → revision+1 原子落盘。
    /// CR-001：直接 serde_json 反序列化判定（RetentionPolicy::parse 对一切非法回退
    /// Permanent，is_valid 恒真 → 原守卫是死代码）；落库 canonical 序列化（规范档位，
    /// 非原始串）。
    /// I13-W3：expected_revision Some(e) → 与后端当前 revision 原子比对，不匹配 →
    /// Conflict（旧写不覆盖新写）；None → 盲写（首写）。
    pub(crate) async fn set_policy(
        &self,
        json: String,
        expected_revision: Option<i64>,
    ) -> Result<i64, RetentionError> {
        let policy: RetentionPolicy = serde_json::from_str(&json)
            .map_err(|error| RetentionError::InvalidPolicy(format!("非合法策略 JSON：{error}")))?;
        if !policy.is_valid() {
            return Err(RetentionError::InvalidPolicy(format!(
                "非法保留策略（越档/缺档位）：{json}"
            )));
        }
        let canonical = serde_json::to_string(&policy)
            .map_err(|error| RetentionError::InvalidPolicy(format!("策略序列化失败：{error}")))?;
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            repo.retention_policy_set(1, &canonical, expected_revision)
        })
        .await
        .map_err(|error| {
            RetentionError::Unavailable(format!("retention set task failed: {error}"))
        })?
        .map_err(|error| match error {
            PylonError::RevisionConflict { expected, actual } => {
                RetentionError::Conflict { expected, actual }
            }
            other => RetentionError::Unavailable(other.to_string()),
        })
    }

    /// 校验执行策略（CR-002：preview/prune 执行前拒绝畸形策略——by_time 缺 days /
    /// by_count 缺 count 会退化为"删除全部消息"（cutoff=now / limit=0），与 D-15
    /// "禁止因默认值变化自动删除历史"相悖）。
    fn validate_policy(&self, policy: &RetentionPolicy) -> Result<(), RetentionError> {
        if !policy.is_valid() {
            return Err(RetentionError::InvalidPolicy(format!(
                "非法保留策略（越档/缺档位）：{policy:?}"
            )));
        }
        Ok(())
    }

    /// preview：统计将删除的候选（不执行删除）。
    pub(crate) async fn preview(
        &self,
        policy: RetentionPolicy,
    ) -> Result<RetentionPreview, RetentionError> {
        self.validate_policy(&policy)?;
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.retention_candidates(&policy))
            .await
            .map_err(|error| {
                RetentionError::Unavailable(format!("retention preview task failed: {error}"))
            })?
            .map_err(|error| RetentionError::Unavailable(error.to_string()))
    }

    /// prune：事务内统计候选 + 执行删除（与 preview 同一筛选）；返回实际删除计数。
    /// I13-W4：expected_policy_revision Some(e) 且与策略行当前 revision（无行 = 0）不匹配 →
    /// StalePreview（用户预览后策略被改，拒绝按旧统计执行清理）。
    pub(crate) async fn prune(
        &self,
        policy: RetentionPolicy,
        expected_policy_revision: Option<i64>,
    ) -> Result<RetentionPreview, RetentionError> {
        self.validate_policy(&policy)?;
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.prune_by_policy(&policy, expected_policy_revision))
            .await
            .map_err(|error| {
                RetentionError::Unavailable(format!("retention prune task failed: {error}"))
            })?
            .map_err(|error| match error {
                PylonError::StalePreview { expected, actual } => {
                    RetentionError::StalePreview { expected, actual }
                }
                other => RetentionError::Unavailable(other.to_string()),
            })
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

    // ── I14-W9 CR-001/CR-002：set 校验与 preview/prune 畸形策略拒绝 ──

    fn test_service() -> RetentionService {
        RetentionService::new(Arc::new(
            crate::session::msg_repo::MsgRepo::open_in_memory().expect("repo"),
        ))
    }

    #[tokio::test]
    async fn set_policy_rejects_invalid_inputs_cr001() {
        let service = test_service();
        for bad in [
            r#"{"mode":"by_time","days":999}"#,
            r#"{"mode":"garbage"}"#,
            "not json",
            "",
        ] {
            let error = service
                .set_policy(bad.to_string(), None)
                .await
                .expect_err("must reject");
            assert_eq!(error.code(), "invalid_retention_policy", "输入 {bad}");
        }
        // 拒绝后未落库
        assert!(service.get_policy().await.expect("get").is_none());
    }

    #[tokio::test]
    async fn set_policy_accepts_valid_and_persists_canonical_cr001() {
        let service = test_service();
        for good in [
            r#"{"mode":"permanent"}"#,
            r#"{"mode":"by_time","days":30}"#,
            r#"{"mode":"by_count","count":1000}"#,
        ] {
            service
                .set_policy(good.to_string(), None)
                .await
                .expect("valid set");
        }
        let row = service.get_policy().await.expect("get").expect("present");
        assert_eq!(row.version, 1);
        assert_eq!(row.revision, 3, "三次合法 set revision 递增");
    }

    #[tokio::test]
    async fn set_policy_expected_revision_conflict_detected() {
        let service = test_service();
        // 首写（expected=None 盲写）→ revision 1
        let rev = service
            .set_policy(r#"{"mode":"permanent"}"#.to_string(), None)
            .await
            .expect("first");
        assert_eq!(rev, 1);
        // expected 正确 → 通过并推进
        assert_eq!(
            service
                .set_policy(r#"{"mode":"by_time","days":30}"#.to_string(), Some(1))
                .await
                .expect("ok"),
            2
        );
        // expected 过期 → Conflict（旧写不覆盖新写）
        let error = service
            .set_policy(r#"{"mode":"by_count","count":1000}"#.to_string(), Some(1))
            .await
            .expect_err("stale expected must conflict");
        assert_eq!(error.code(), "retention_revision_conflict");
        // 冲突后未覆盖
        let row = service.get_policy().await.expect("get").expect("present");
        assert_eq!(row.revision, 2);
        assert!(row.payload.contains("by_time"));
    }

    #[tokio::test]
    async fn preview_prune_reject_malformed_policy_cr002() {
        // 畸形但可反序列化的策略（by_time 缺 days / by_count 缺 count）执行前必须拒绝
        // ——否则退化为全量删除（cutoff=now / limit=0），与 D-15 安全意图相悖
        let service = test_service();
        let malformed_time: RetentionPolicy =
            serde_json::from_str(r#"{"mode":"by_time"}"#).expect("parse");
        assert_eq!(
            service
                .preview(malformed_time.clone())
                .await
                .expect_err("reject")
                .code(),
            "invalid_retention_policy"
        );
        assert_eq!(
            service
                .prune(malformed_time, None)
                .await
                .expect_err("reject")
                .code(),
            "invalid_retention_policy"
        );
        let malformed_count: RetentionPolicy =
            serde_json::from_str(r#"{"mode":"by_count"}"#).expect("parse");
        assert_eq!(
            service
                .prune(malformed_count, None)
                .await
                .expect_err("reject")
                .code(),
            "invalid_retention_policy"
        );
        // 合法策略仍可 preview/prune（不误伤）
        let valid: RetentionPolicy =
            serde_json::from_str(r#"{"mode":"permanent"}"#).expect("parse");
        assert!(service.preview(valid).await.is_ok());
    }

    #[tokio::test]
    async fn prune_rejects_stale_policy_revision() {
        let service = test_service();
        service
            .set_policy(r#"{"mode":"by_time","days":30}"#.to_string(), None)
            .await
            .expect("set rev1");
        service
            .set_policy(r#"{"mode":"by_time","days":90}"#.to_string(), None)
            .await
            .expect("set rev2");
        // 预览基于 rev 1，但策略已推进到 rev 2 → 拒绝按旧统计执行清理
        let stale_policy: RetentionPolicy =
            serde_json::from_str(r#"{"mode":"by_time","days":30}"#).expect("parse");
        let error = service
            .prune(stale_policy, Some(1))
            .await
            .expect_err("stale must reject");
        assert_eq!(error.code(), "retention_stale_preview");
        // 当前 revision 匹配 → 可执行（permanent 无候选，返回 0 计数）
        let current: RetentionPolicy =
            serde_json::from_str(r#"{"mode":"permanent"}"#).expect("parse");
        let preview = service
            .prune(current, Some(2))
            .await
            .expect("current revision prune");
        assert_eq!(preview.total_candidates, 0);
    }
}
