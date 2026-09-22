//! 运行时结构化日志的汇端口（#247）。
//!
//! 引擎核对结构化日志的唯一依赖面：client/stderr 只要求「能推一条带上下文的
//! 记录」，不知道 ring buffer / 查询 / 脱敏等宿主细节。宿主 RuntimeLogHub
//! 实现本 trait（端口-适配器；方法名与 hub 既有签名同形，转发即零行为变更）。
use pylon_core::correlation::RuntimeCorrelation;
use pylon_core::log_context::RuntimeLogContext;
use pylon_foundations::time::Timestamp;

pub trait RuntimeLogSink: Send + Sync {
    #[allow(clippy::too_many_arguments)]
    fn push_with_context(
        &self,
        timestamp: Timestamp,
        level: String,
        source: String,
        session: Option<String>,
        message: String,
        fields: serde_json::Map<String, serde_json::Value>,
        correlation: Option<RuntimeCorrelation>,
        context: RuntimeLogContext,
    );
}
