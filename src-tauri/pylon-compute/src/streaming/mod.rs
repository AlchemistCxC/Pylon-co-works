//! WP3：流式文本管线——切分与揭示预算引擎。
//!
//! 纯函数 / 纯状态：**不读时钟**（`tick` 的 `now` 由 JS 传入）、不做 IO、不动 DOM。
//! 语义契约（D1 预算逐行递减、D2 UTF-16 计量且不劈字素、60fps 发布节奏、400ms 追赶
//! 窗口）与 TS 基线逐字对齐；帧源（requestAnimationFrame）仍由 JS 注入。
//!
//! 模块：
//!
//! - [`split`]：stable/unstable 顶层块边界切分与文末开放围栏尾块提取（TS 基线
//!   `chat/streamingMarkdownSplit.ts` 的移植）。
//! - [`budget`]：揭示预算引擎——文本镜像（单写者 `reset`/`feed`，`tick` 只读、
//!   漂移可断言）+ D1/D2/追赶窗口的计算核（TS 基线 `streamingDisplayScheduler.ts`
//!   的**计算**部分移植）。TS 基线里的编排路径（帧源/定时器、replacement flush、
//!   终态微任务合并、判据 A/C、诊断缓冲）按 ADR-0018 留在 JS。
//!
//! 迁移期纪律：与 TS 基线只允许作为差分校验并存（parity 测试
//! `src/renderers/solid-workbench/__tests__/streamingComputeParity.test.ts`）；
//! parity 绿后 TS 基线退役，不留长期双实现。

pub mod budget;
pub mod split;
