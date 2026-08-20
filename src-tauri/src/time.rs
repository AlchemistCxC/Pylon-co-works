//! 时间戳类型（R4 去字符串化：Timestamp）。
//!
//! Unix 毫秒（u64）newtype。wire 序列化为字符串 `"1722500000000"`——
//! 与历史 `runtime_log::timestamp() -> String` 的对外契约逐字一致；
//! 内部以 u64 参与算术，消除 `parse().unwrap_or(0)` 字符串往返。

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

/// 一天的毫秒数（UTC 日历天判定用）。
const DAY_MS: u64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Timestamp(pub u64);

impl Timestamp {
    pub fn new(millis: u64) -> Self {
        Self(millis)
    }

    /// 当前 Unix 毫秒（SystemTime 失败/早于纪元时回退 0，与旧 timestamp() 一致）。
    pub fn now() -> Self {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0) as u64;
        Self(millis)
    }

    pub fn as_u64(self) -> u64 {
        self.0
    }

    /// 距更早时刻的毫秒差（saturating，不会下溢）。
    pub fn elapsed_since(self, earlier: Timestamp) -> u64 {
        self.0.saturating_sub(earlier.0)
    }

    /// UTC 日历天序号（Unix 毫秒 → 天；会话过期 reset="daily" 判定用）。
    pub fn day_number(self) -> u64 {
        self.0 / DAY_MS
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let raw = String::deserialize(deserializer)?;
        raw.parse::<u64>()
            .map(Timestamp::new)
            .map_err(|_| D::Error::custom(format!("invalid timestamp: {raw}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_string_preserving_wire_contract() {
        let value = serde_json::to_value(Timestamp::new(1_722_500_000_000)).expect("serialize");
        assert_eq!(value, serde_json::json!("1722500000000"));
        let deserialized: Timestamp = serde_json::from_value(value).expect("deserialize");
        assert_eq!(deserialized, Timestamp::new(1_722_500_000_000));
    }

    #[test]
    fn elapsed_is_saturating() {
        assert_eq!(
            Timestamp::new(2000).elapsed_since(Timestamp::new(1500)),
            500
        );
        assert_eq!(Timestamp::new(1000).elapsed_since(Timestamp::new(2000)), 0);
    }

    #[test]
    fn day_number_divides_by_day_ms() {
        assert_eq!(Timestamp::new(DAY_MS * 3 + 123).day_number(), 3);
    }

    #[test]
    fn rejects_non_numeric_timestamp() {
        assert!(serde_json::from_str::<Timestamp>("\"t1\"").is_err());
    }
}
