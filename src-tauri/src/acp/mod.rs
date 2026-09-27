//! ACP 宿主适配层（#247 起）：协议引擎核已抽至 `pylon-acp` crate，本目录
//! 只保留实例注册表与依赖宿主 harness（test_utils / AppState）的表征测试。
//!
//! 路径保活：下方 glob 重导出维持 `crate::acp::{AcpClient, engine, negotiated,
//! error, …}` 全部既有调用点（消费者迁移另立期）；`From<AcpError> for
//! PylonError` 与 `capture_negotiated_snapshot` 因涉及宿主类型而留在此处。
pub use pylon_acp::*;

pub(crate) mod instance_registry;

#[cfg(test)]
mod catalog_driven_tests;
#[cfg(test)]
mod golden_trace_tests;
#[cfg(test)]
mod p1_wire_regression_tests;
#[cfg(test)]
mod real_acp_smoke;
#[cfg(test)]
mod tests;

// #247：原 pylon-acp::error 内的实现随宿主类型（PylonError）留驻——
// 孤儿规则要求本 impl 与 PylonError 同 crate。
// #317 批次二 2c：边界区分度保留——除既有 ReplayLoadInProgress→Storage 特判外，
// 其余变体整包委托 PylonError::AcpDomain（细分 code 经 AcpError::code 委托，
// 词汇表与 persist.rs 回放契约逐字一致）；protocol_error 不再吞 ACP 域失败。
impl From<pylon_acp::AcpError> for crate::error::PylonError {
    fn from(error: pylon_acp::AcpError) -> Self {
        if let pylon_acp::AcpError::ReplayLoadInProgress = error {
            return crate::error::PylonError::Storage(
                pylon_session::SessionError::ReplayLoadInProgress,
            );
        }
        crate::error::PylonError::AcpDomain(error)
    }
}

/// 从运行时现场捕获能力协商快照（#247 自 pylon-acp::negotiated 迁入——
/// 它持有 &AgentRuntime 的锁序约定，属宿主编排面）。
pub async fn capture_negotiated_snapshot(
    runtime: &crate::runtime::AgentRuntime,
) -> Result<NegotiatedCapabilitySnapshot, String> {
    let generation = runtime
        .client_generation
        .load(std::sync::atomic::Ordering::Acquire);
    let acp = runtime.acp.lock().await;
    let declared: Vec<String> = acp.establishment_order().to_vec();
    let consumers = negotiated::registered_capability_consumers();
    Ok(NegotiatedCapabilitySnapshot::from_parts(
        acp.capabilities(),
        &declared,
        generation,
        &consumers,
    ))
}
