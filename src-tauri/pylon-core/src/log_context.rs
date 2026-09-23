//! 结构化日志记录的上下文与功能域词汇（#247 自宿主 runtime_log 下沉——
//! pylon-acp 的日志汇端口与宿主 hub 需要共享同一形状，而 core 不得反向依赖宿主）。
use serde::{Deserialize, Serialize};

/// 日志功能域词汇：前端注入日志。
pub const LOG_CATEGORY_FRONTEND: &str = "frontend";
/// 日志功能域词汇：agent 原始 stderr。
pub const LOG_CATEGORY_STDERR: &str = "stderr";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogContext {
    /// 机器可读错误码（稳定契约，前端可分支）。值域：agent 结构化 stderr 自报码
    /// （agent 命名空间）或 Pylon wire_code（DEL-05 词汇），不得发明新码；
    /// agent_unavailable 等内部测试码不进该字段（DEL-05 CR-002）。
    pub code: Option<String>,
    /// 日志功能域分类（词汇见 [`LOG_CATEGORY_STDERR`] / [`LOG_CATEGORY_FRONTEND`]）。
    pub category: Option<String>,
    /// 该错误是否可重试/自愈（语义由填充方定义；stderr 文本行不可判定 → None）。
    pub recoverable: Option<bool>,
    /// 是否需用户操作介入（同上；本卡无填充站点）。
    pub user_action_required: Option<bool>,
    /// 该条是否承载真实原始文本（可能经脱敏；区别于历史 B 型占位符"Agent stderr output"）。
    pub raw_available: Option<bool>,
}
