# ADR-0004 ACP 能力矩阵：canonical 嵌套路径为真源，根级 loadSession 兼容 alias 与 fail-closed 迁移

- **日期**：2026-09-15
- **状态**：已采用
- **关联**：issue #98；spec `.agents/spec/issue-acp-capability-lifecycle-closed-loop.md`；实现 `src-tauri/src/acp/negotiated.rs`、`src/infrastructure/acp/agentContracts.ts`

## 背景与约束

issue #98 之前，能力判断散落三处且互不一致：

1. session 建立链（`session_establishment_channels`）读标准嵌套 `sessionCapabilities.resume/loadSession` 且要求 **object 值**；
2. 重连 continuity probe（`lifecycle/mod.rs`）读**根级** `loadSession` 且要求 **boolean true**——同一 Agent 可能在建立时判支持 load、重连时判不支持；
3. 前端 `agentContracts.ts` 读根级 `loadSession === true`、嵌套布尔 `sessionCapabilities.resume/fork === true`（与 Rust 的 object 协商永不相等），并对 `sessionClose`/`mcpHttp`/`mcpSse` 用「缺失即 true」的 fail-open 缺省。

约束：

- 不能写死 Peri/Hermes 等单个 Agent 的能力名分支；兼容形状必须是协议级别；
- 前端存在零消费能力布尔（含 fork ghost capability——展示已建模、执行链不存在），语义翻转不破坏实际 UI，但测试契约必须同步；
- wire method、协议版本、session identity/generation 语义不变。

## 备选方案

| 方案 | 否决/采用理由 |
| --- | --- |
| A. 三处各自修对齐（probe 改嵌套、TS 改嵌套 object） | 依然是三份独立判断，下一个能力照旧复制路径字符串——正是 issue 要消除的形态 |
| B. **单一 canonical 矩阵（`CAPABILITY_MATRIX`），声明—协商—消费者三列，全调用方消费同一快照（采用）** | — |
| C. 保留 TS 侧 fail-open 缺省（sessionClose/mcp 缺失即 true） | 违反 fail-closed 默认方向：未协商能力被投影成可用；且零生产消费方，无真实回退需求 |
| D. 前端独立复刻矩阵解析 raw capabilities | 两份实现必然漂移；IPC 已有结构化通道，无必要 |

## 决定

1. **canonical 路径真源**：标准嵌套 `sessionCapabilities.*`（object 能力要求 object 值；boolean 能力要求显式 `true`）。全仓能力判断收敛到 `NegotiatedCapabilitySnapshot`（Unknown/Advertised/Negotiated/Usable 四态 + 诊断）；session 建立、resume/load/new 排序、重连 continuity probe、`agent_status.capabilitySnapshot` 全部消费它。
2. **兼容 alias（唯一登记）**：根级 `loadSession: true`（boolean，Peri 形状实证）仅在 canonical 缺失时读取；canonical 与根级同时存在视为冲突，canonical 决定结论并产出诊断；canonical 类型错误不回退 alias（fail-closed）。snapshot/diagnostics 标记 `source: "root-alias"`。
3. **兼容窗口**：根级 alias 自本 ADR 起进入弃用流程——保留读取兼容（不扩大新广告面），计划在 ACP 标准嵌套路径被主流 Agent 全面采用后的下一个大版本移除；移除前新增/修改 fixture 一律使用 canonical 嵌套路径。`sessionClose`/`mcpHttp`/`mcpSse` 的「缺失即 true」缺省**即刻废除**：缺失 = Unknown = false（fail-closed），显式 `true`/object 才为可用。
4. **三层投影**：`advertised/negotiated/usable` 随 `agent_status.capabilitySnapshot` 下发；IPC/UI 只消费 `usable`（消费者已注册），诊断保留 advertised 原文（`capabilities` 字段原样透传不变）。fork 在消费者（`session/fork` raw RPC 链）注册前/不可用时恒 usable=false。
5. **扩展方式**：新增能力 = 在 `CAPABILITY_MATRIX` 登记路径、类型、消费者 + 矩阵测试；禁止在 lifecycle、session/create、前端 projection 复制独立判断。

## 后果

- 同一 Agent 的 load 能力判定在建立与重连两链路恒一致（AC1-AC4）；
- 仅广告根级形状的旧 Agent 继续工作，但诊断可见 alias 来源与弃用提示；
- 依赖旧 fail-open 缺省的下游（如有）会看到 sessionClose/mcp 从 true 变 false——2026-09 全仓检索确认这些布尔零生产消费方，实际 UI 行为不变；
- 后端权威、前端薄投影：能力语义变更只改 Rust 矩阵一处。

## 证据

- Rust 矩阵与四态：`src-tauri/src/acp/negotiated.rs`（29 项矩阵测试）
- 探针消费快照：`src-tauri/src/lifecycle/mod.rs`（probe_unknown_session_continuity）
- 建立链消费快照：`src-tauri/src/session/create.rs`（revive_session_slot）
- IPC 投影：`src-tauri/src/lib.rs`（agent_status_payload.capabilitySnapshot/pendingInteractions）
- TS 消费：`src/infrastructure/acp/agentContracts.ts`（35 项契约测试）
