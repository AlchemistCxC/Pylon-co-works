# ADR-0025 异味清偿批次二：结构性拆分形态（dispatcher 六缝提取 / 错误边界三层统一 / 原子写下沉）

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0025-smell-batch2-structural-split.md`

- **日期**：2026-09-25
- **状态**：已采用
- **关联**：issue #317 批次二；批次一（机械修复层）已随 PR #319 入 main

## 背景与约束

全仓异味审计（2026-09-25）遗留四项结构性条目，批次一完工时明确「架构裁断留给用户」：

1. `start_notification_dispatcher` 1003 行事件泵（`dispatcher/mod.rs:1706-2708`）：崩溃重连状态机（~269 行）、私有交互路由（~210 行）、批次 flush 决策（~140 行）、host 工具门（~123 行）全部内联。
2. `createAgentWorkbenchSessionRuntime` 1101 行工厂（`agentWorkbenchSession.ts:365-1465`）：`bind`/`refresh` 两块共享 6 个竞态闭包变量，TurnClock 子系统被 4 个外部块读写。
3. 命令边界 7 型错误并存（140 命令位：PylonError 95 / 裸 String 16 / GatewayInstanceError 8 / pylon-session 四件套 17 / infallible 2），6 份逐字同构手写 Serialize；前端 `{code,message}` 提取逻辑 9 处重写（errorPayload.ts 自称唯一解释点仅 1 消费方）。
4. 两套原子写并存：正身 `agent_config/atomic_write.rs:255`（fsync + MoveFileExW WRITE_THROUGH）vs `pylon-foundations/workspace.rs:542`（无 fsync、remove+rename 丢窗口）；crate 依赖方向阻止宿主实现下沉复用。

约束：wire 格式、命令名、错误码 code 表不变；#315/#316 刚出园（dispatcher 域冲突解除）；routing.rs 已确立「决策/副作用分离」惯例；#316 留有纯函数提取先例（`session_workspace_root`、`match_pending_elicitation`）。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 仅做低风险两项（TS 工厂 + 错误机械层），dispatcher 与原子写另批 | 用户裁断四项一次推进（2026-09-25 决策 D1），#316 出园后 dispatcher 冲突窗已关闭，分批反而两次触碰同一调用面 |
| dispatcher 仅提取纯决策函数（延续 #316 最小步） | 269 行重连状态机与 210 行私有交互路由仍内联主泵，主函数不减负，审计条目未实质清偿 |
| 错误统一止步第 1 层（Serialize 去重 + 前端收口） | 用户裁断三层全做（D3）：33 命令签名收编与 AcpError 区分度是一次性清偿，且 wire 形状不变使风险可控 |
| 原子写不动、加豁免注释 | 弱实现无 fsync 且 remove+rename 有数据丢失窗口，注释不消除风险；依赖方向可经「正身下沉」解决 |
| localStorage/SQLite 双写在本批一并处置 | identity 双写是 browser 模式权威 / Tauri 模式缓存+revision baseline 的刻意设计（identityStore.ts:279 等），处置需产品级讨论，与本批机械/结构清偿性质不同 |

## 决定

1. **范围与顺序**（D1）：批次二四项全做，顺序 ① TS 工厂拆分 → ② 错误边界三层统一 → ③ 原子写下沉 → ④ dispatcher 六缝提取；同一 issue 下分 commit 序列，任一序列可独立 revert。
2. **dispatcher**（D2）：按既有分缝提取子模块——崩溃/自动重连、私有交互路由、canonical 批次 flush、host 工具门、权限分支（已薄，随迁）、兜底+SessionUpdate 委派；主函数瘦身为装配 + `tokio::select!` 骨架；沿用 routing.rs 决策/副作用分离惯例；不改事件名、路由顺序与锁持有范围。
3. **错误边界**（D3）三层全做：(a) 6 份手写 Serialize 以宏/公共实现去重，序列化输出逐字节不变；(b) 16 条 String 命令按语义映射 PylonError 既有变体，17 条 session 四件套命令经既有 `#[from]` 收编，code 表逐字保留；(c) AcpError 边界区分度保留（新增映射变体，`protocol_error` 仅留真协议层），前端按 code 消费点逐个核对登记；前端 8 处提取逻辑收口 errorPayload.ts 单点。
4. **持久化**（D4）：原子写正身下沉 pylon-foundations（前置核实其依赖纯净度），workspace.rs 改用正身；localStorage/SQLite 双写从 #317 剥离另立 issue + ADR 讨论。

## 后果

- 正面：主泵可读可测（六缝各自可单测）；命令边界错误单源、前端解释单点；原子写单一强实现，消除丢窗口路径。
- 负面：33 命令签名扫荡一次性触碰面大（签名 + 调用方 map_err 链）；dispatcher 拆分后主函数仍非小型（select 循环 + 装配属本质复杂度）。
- 风险：错误收编漏改调用方会改变错误文案——以「wire 形状不变 + DEL-05 错误矩阵测试双侧守恒」为判据；AcpError 新增 code 是唯一对外语义扩展，出现兼容问题以「恢复折叠 protocol_error」单点回滚；dispatcher 模块提取不改锁序，回归矩阵（p1 wire 16+ 用例、auto_reconnect 集成 5 用例）兜底。

## 证据

- dispatcher 结构与分缝实测：`src-tauri/src/dispatcher/mod.rs:1706-2708`（C 块 1778-2046、M 块 2447-2594、G 块 2128-2198 + 调用点 2076/2183/2661/2680）
- 工厂公共面：`src/sheets/agent-workbench/agentWorkbenchSession.ts:365-1465`；9 个测试文件全经 10 公共成员驱动，无一触内部闭包
- 错误类型分布：`src-tauri/src/error.rs:10,94-101`、`src-tauri/src/gateway/instance.rs:122,159-166`、`src-tauri/pylon-session/src/{event_repo/error.rs:8,msg_repo/mod.rs:211,user_data.rs:86,retention.rs:113}`；AcpError 折叠点 `src-tauri/src/acp/mod.rs:26-35`
- 前端重写点：`src/infrastructure/tauri/errorPayload.ts:14,26`（1 消费方）；`src/runtimeError.ts:180`、`src/userDataRepository.ts:46`、`src/components/chat/messagePersistence.ts:204`、`src/infrastructure/events/canonicalEventRepository.ts:55`、`src/retentionPolicyRepository.ts:51`、`src/components/settings/AgentRuntimePanel.tsx:103`、`src/cli/pylonCliDomainPorts.ts:35`、`src/components/chat/chatReplayTrace.ts:107`
- 原子写对照：`src-tauri/src/agent_config/atomic_write.rs:255` vs `src-tauri/pylon-foundations/src/workspace.rs:542-573`
- 双轨持久化（剥离项）：`src/identityStore.ts:279,443-447`、`src/retentionPolicyRepository.ts:67-127`、`src-tauri/src/permission.rs:668-694`
