//! Controlled first-party Agent runtime discovery. No recursive disk scan and no ACP initialize.
//!
//! D-split：原单文件按自然接缝拆分（与宿主 `agent_config` D-split 同构）——
//! - `types`：证据/诊断/报告/候选/预算与选项值类型
//! - `locate`：路径规范化、launcher 解析、根集合与命令定位
//! - `evidence`：provider 证据、config 证据、排序与身份合并纯函数
//! - `probe`：版本探测子进程机器（输出上限/JobObject/有界读取/诊断构造）
//! - `probe_cache`：探测缓存 + npm 版本回退
//! - `scan`：扫描管线（`detect_agent_runtime_candidates[_inner]`）
//! - `snapshot`：DetectionSnapshot / DetectionOutcome / 组装与指纹
//! - `tests`：领域测试（原 mod tests 原样搬移）
//!
//! 拆分为纯机械搬移：子模块内原私有项统一 `pub(crate)`（对 crate 外可见性不变），
//! mod.rs glob 再导出保证 `pylon_core::agent_detection::X` 既有引用路径零改动
//! （宿主 `pub use pylon_core::agent_detection::*` 依赖通配再导出，src/agent/detection.rs:18）。

mod evidence;
mod locate;
mod probe;
mod probe_cache;
mod scan;
mod snapshot;
mod types;

pub use evidence::*;
// 检测内部项经 glob 供 tests.rs（use super::*）消费；非 test 编译下 lint 静音（同 lifecycle __cmd__ 先例）。
#[allow(unused_imports)]
pub(crate) use locate::*;
#[allow(unused_imports)]
pub(crate) use probe::*;
pub use probe_cache::*;
pub use scan::*;
pub use snapshot::*;
pub use types::*;

// tests.rs 的 `use super::*` 依赖原单文件头部的模块级 import 作用域；
// 这里以 cfg(test) 精确复刻（非 test 编译零引入，同 lifecycle `#[cfg(test)] use` 先例）。
#[cfg(test)]
use crate::agent_preflight::ToolVersion;
#[cfg(test)]
use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::process::Stdio;
#[cfg(test)]
use std::time::{Duration, Instant};

#[cfg(test)]
mod tests;
