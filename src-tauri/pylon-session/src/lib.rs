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
pub mod turn_rollup;
pub mod user_data;

pub use error::SessionError;
pub use owner::DurableSessionOwner;

#[cfg(test)]
mod del01_schema_audit;
#[cfg(test)]
mod del02_tombstone_migration;
#[cfg(test)]
mod del05_error_code_matrix;
#[cfg(test)]
mod storage_write_bench;
