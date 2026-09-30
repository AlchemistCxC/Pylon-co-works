//! pylon-session — 会话存储核（#247 自宿主 session/ 下沉）。
//!
//! 零 tauri / 零 AppState：canonical 事件仓库、消息仓库、用户数据仓库、
//! 保留策略、turn 聚合与持久化启动单元。宿主 session/ 命令编排层经模块
//! 重导出消费本 crate；依赖方向铁律：本 crate 只依赖 pylon-canonical-types
//! 与 pylon-foundations，绝不依赖回宿主（持久化层禁止触达 UI）。

pub mod error;
pub mod event_repo;
pub mod msg_repo;
pub use msg_repo::connect;
pub mod owner;
pub mod persistence_bootstrap;
pub mod retention;
pub mod turn_boundary;
pub mod turn_rollup;
pub mod user_data;

pub use error::SessionError;
// #205 折叠预算 Rust 侧单源：宿主写侧（dispatcher）预算应改引此处，不再各写一份；
// #439 起前端 `CANONICAL_BATCH_LIMITS` 已随自写轨退役，本处是唯一单源
// （TS 侧仅测试本地硬拷贝期望值，不构成漂移面）。
pub use event_repo::{MAX_FOLDED_CHUNKS, MAX_FOLD_BYTES};
pub use owner::DurableSessionOwner;
// #442 Step1：回合边界判据与 wire 形状单源（宿主 load 响应的 turnBoundary 组装消费）。
pub use turn_boundary::{TurnBoundary, TurnBoundaryKind};

/// B1.2 结构化错误 wire 形状的单源实现：`{ "code", "message" }` 两键 map。
/// 本 crate 四个仓库错误类型（EventError/MessageError/UserDataError/RetentionError）
/// 共用（code 由各类型 `code()` 提供，message 走 Display）；与宿主 crate 的同名宏
/// 同构——序列化输出与既往手写 impl 逐字节一致（DEL-05 矩阵测试看守）。
#[macro_export]
macro_rules! impl_wire_code_message_serialize {
    ($ty:ty) => {
        impl serde::Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("code", self.code())?;
                map.serialize_entry("message", &self.to_string())?;
                map.end()
            }
        }
    };
}

#[cfg(test)]
mod del01_schema_audit;
#[cfg(test)]
mod del02_tombstone_migration;
#[cfg(test)]
mod del05_error_code_matrix;
#[cfg(test)]
mod storage_write_bench;
