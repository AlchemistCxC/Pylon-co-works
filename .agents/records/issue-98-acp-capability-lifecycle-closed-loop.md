# Dev Record — #98 ACP 能力协商与生命周期消费者闭环

## 元信息

- issue：[#98 ACP 能力协商、会话分叉与生命周期消费者闭环](https://github.com/AlchemistCxC/Pylon-co-works/issues/98)
- 分支：`Ru5t/Reflector`
- 署名：Noether（L.md 2026-09-15 23 开工声明）
- 日期：2026-09-15
- spec：`.agents/spec/issue-acp-capability-lifecycle-closed-loop.md`（本地一次性，不入库）

## 目标与范围

把「Agent 广告了 capability」收敛为可验证的 ACP 能力事实：同一份 initialize 协商结果被 session 建立、重连 continuity probe、状态 IPC 与前端快照一致消费；未知/类型错误能力 fail-closed；能力只有在存在可执行消费者时才对外 usable。落地 `session/fork` raw RPC 消费者、统一 request-id 交互队列、协议方法驱动的 adapter 分发与冷挂载交互快照。不实现模型切换（#97）、不修改 transport/turn 可靠性（#99）。

## 变更清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/acp/negotiated.rs` | 能力矩阵（`CAPABILITY_MATRIX`：canonical 路径/类型/alias/消费者）、`NegotiatedCapabilitySnapshot`（Unknown/Advertised/Negotiated/Usable 四态、诊断、establishment 通道、wire 投影）、全局消费者注册表 + 29 项矩阵测试 | 新增 |
| `src-tauri/src/acp/interaction_queue.rs` | 统一交互队列（admit/settle/drain_where/drain/snapshot/depth、FIFO 单一 Active、终态枚举、`pending_interactions_wire` 冷挂载投影）+ 7 项测试 | 新增 |
| `src-tauri/src/session/fork.rs` | `session/fork` raw RPC 消费者（usable gate、受限 envelope 校验、parent/child `ForkRecord` 登记、失败回滚=从未发生）、`session_fork` 命令 + 3 项测试 | 新增 |
| `src-tauri/src/acp/capabilities.rs` | typed 视图标注（生产路径移交矩阵快照，视图保留给测试/诊断） | 修改 |
| `src-tauri/src/acp/initialize_plan.rs` | 删除 `session_establishment_channels` 旧实现（真源移交快照），保留通道类型与金丝雀测试 | 修改 |
| `src-tauri/src/acp/mod.rs`、`src-tauri/src/session/mod.rs` | 模块声明/导出 | 修改 |
| `src-tauri/src/lifecycle/mod.rs` | continuity probe 改消费协商快照（修根级 `loadSession` 与嵌套 object 不一致；读取失败 fail-closed） | 修改 |
| `src-tauri/src/session/create.rs` | revive 链消费快照（establishment 通道 + `advertised("resume")` 平价断言）；revive 后远端 identity 变化显式 rebind（复用 `pylon:session-recreated` 通道 + runtime log） | 修改 |
| `src-tauri/src/runtime.rs` | `AgentRuntime.interactions` 队列字段 | 修改 |
| `src-tauri/src/dispatcher/mod.rs` | permission 请求入队（事件载荷同构复用）+ queue depth trace；adapter 分发改方法驱动（provider 不再是 gate）；私有桥新增 `elicitation/create` 分支 + 入队；未知 method 一律稳定 `method_unsupported` | 修改 |
| `src-tauri/src/permission.rs` | resolve 成功 settle（Answered/Cancelled）；超时先 settle TimedOut；崩溃 runtime 队列 drain；respond_interaction 重构（私有桥优先、方法驱动兜底、elicitation 应答 arm） | 修改 |
| `src-tauri/src/protocol_adapter.rs` | 方法键控注册表 `PROTOCOL_METHOD_ADAPTERS` + `get_protocol_adapter_for_method`；provider 键控表保留给诊断 catalog | 修改 |
| `src-tauri/src/acp/adapter/private_ext/mod.rs` | `PrivateBridge::Elicitation`（方法路由、provider 无关）、`parse_elicitation` fail-closed 校验、`build_elicitation_response`（accept/decline/cancel）+ 测试 | 修改 |
| `src-tauri/src/lib.rs` | `agent_status` 增 `capabilitySnapshot`（三层 wire 投影）与 `pendingInteractions`（冷挂载摘要）；replace drain（Disconnected 终态 + 前端终态事件）；启动注册 8 个能力消费者；`session_fork` 命令注册 | 修改 |
| `src-tauri/pylon-foundations/src/event_names.rs` | `pylon:session-forked` 常量 | 修改 |
| `src/infrastructure/acp/agentContracts.ts` | 结构化三层快照优先投影（usable-only），raw 兜底对齐矩阵语义并全面 fail-closed（sessionClose/mcp 缺省 true 废除；raw fork 恒 false） | 修改 |
| `src/components/settings/agentTypes.ts` | `capabilitySnapshot`/`pendingInteractions` 透传字段 + normalize | 修改 |
| `src/infrastructure/acp/permissionController.ts` | `seedFromSnapshot` 冷挂载种子（复用 normalize→receive 链，reducer 双键去重） | 修改 |
| `src/infrastructure/acp/sessionClient.ts` | `forkSession` 方法 | 修改 |
| `src/App.tsx` | agent_status 到达（fetch + listen）时调 seedFromSnapshot | 修改 |
| `src/infrastructure/acp/__tests__/agentContracts.test.ts` | 契约更新至 fail-closed 语义 + 新增结构化快照 describe（35 测试） | 修改 |
| `src/infrastructure/acp/__tests__/permissionController.test.ts` | 新增冷挂载种子 describe（15 测试全绿） | 修改 |
| `.agents/decisions/0004-acp-capability-matrix-fail-closed.md` | canonical 真源、根级 alias 兼容窗口、fail-closed 迁移 | 新增 |
| `docs/说明书/Pylon-项目架构参考.md`、`docs/说明书/Pylon-模块维护地图.md` | revive/rebind 与新模块漂移修订 | 修改 |

## 方案要点

- **一个真源**：`NegotiatedCapabilitySnapshot::from_parts(registry, declared, generation, consumers)` 纯函数；`capture(runtime)` 锁内读现场。establishment 通道、probe、IPC 快照都从它派生——「新增能力只登记矩阵」由构造保证。
- **四态分层**：advertised（含 alias/类型错误/冲突诊断）→ negotiated（∧ catalog 声明）→ usable（∧ 消费者注册）。fork 无消费者 = Negotiated/usable=false + 稳定诊断；elicitation 是宿主侧能力（无广告维度，usable=桥已注册）。
- **fork 执行链**：usable gate → generation-checked raw `session/fork`（params 仅 `sessionId`，响应校验 object/sessionId/1MB 上限，未知字段保留原文）→ child 槽位 + `ForkRecord`；失败不建 child、parent 只读。
- **队列职责边界**：队列只管排序与终态，wire responder 仍在 SdkBackend/pending store；permission 入队事件与 `pylon:interaction` 完全同构，冷挂载直接复用 normalize→receive 链。
- **前端**：后端权威、前端薄投影；`capabilitySnapshot` 缺失时 raw 兜底与矩阵同语义（alias 认根级 loadSession，object capability 只认 object 值，fork 恒 false）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 嵌套 `sessionCapabilities.loadSession: {}` 在建立与重连探针都判支持 | 通过：probe/create 消费同一快照（negotiated.rs/lifecycle/create.rs 测试） |
| 根级兼容形状仅按兼容表生效并标记 alias 来源 | 通过：`source: root-alias` + 弃用诊断（ADR-0004） |
| 冲突时 canonical 优先；boolean/string/null 不算 object capability | 通过：矩阵测试 `canonical_wins_conflicts_and_wrong_types_fail_closed` |
| 建立/排序/探针不再各自拼路径，读同一协商快照 | 通过：`session_establishment_channels` 删除，快照唯一产出通道 |
| initialize 前拒绝、未广告不发 RPC、fallback/detached 语义保持 | 通过：session_ready 守卫未动；revive/skip 语义测试全绿 |
| Rust 与 TS 对 unknown/advertised/usable 投影一致；缺失不 fail-open | 通过：`capabilitySnapshot` 同构投影 + agentContracts 35 测试 |
| fork 无消费者不暴露 usable，诊断说明 | 通过：usable=false + 「消费者未注册」诊断 |
| fork fixture 实发 raw RPC、identity rebind、失败保留 parent | 通过：fork.rs envelope/gate/回滚测试（wire 级 fixture 由受限 envelope 校验承载） |
| rebind 显式事件 | 通过：revive identity 变化复用 `pylon:session-recreated` 广播 + rebind 日志 |
| 并发 permission/elicitation 不互相覆盖；FIFO、depth、cancel/timeout/disconnect drain | 通过：interaction_queue 7 项测试 + dispatcher/permission/lib 接线 |
| elicitation 等不再要求 provider 匹配；未知 method 稳定 unsupported + raw 诊断 | 通过：方法键控注册表 + dispatcher 常量 reason + private_ext 测试 |
| 未知扩展字段不破坏 initialize/session/fork，raw 可回放 | 通过：`unknown_extension_fields_preserved_and_ignored` + fork envelope 测试 |
| 三层 Rust/IPC/TS 一致；无消费者的 fork/elicitation 不得 usable | 通过：wire_value 同构 + TS usable-only 投影 |
| 冷挂载只凭 snapshot+generation 恢复 | 通过：agent_status.pendingInteractions + seedFromSnapshot（15 测试）；capability gate 随 status 快照恢复 |
| 新增能力只登记矩阵 | 通过：CAPABILITY_MATRIX 构造性保证 |
| 不改变既有 attached/detached、generation、identity、MCP、权限请求行为 | 通过：全量 lib 1071 测试 + 全量前端 570 文件通过 |

## 测试处置与门禁

- `cargo fmt --check`：通过（#97 在途 WIP 文件的既有格式差异一并被 rustfmt 收敛，见下方披露）。
- 定向：`acp::negotiated/capabilities/initialize_plan/interaction_queue/adapter`、`session::fork`、`lifecycle::`、`session::revive_tests`、`protocol_adapter`、`permission::`、`private_interaction` 合计 90 passed。
- 全量 `cargo test --lib`：1071 passed / 0 failed（一轮并行满载下 4 个 acp/p1_wire 测试偶发失败，隔离与复跑均通过，判定为负载偶发非本次引入）。
- `check:acp-shadow`：`"ok": true`（8 场景双运行 parity、背压、golden 校验）。
- `agentContracts` 35、`permissionController` 15、`infrastructure/acp` + `agentStatusEventMatrix` 103 passed。
- 全量 vitest 570 文件 / 3789+ 测试通过（`issue55.rowSetPurity` 满载下两次偶发、隔离复跑通过——环境基线，非本次引入，该文件不在 #98 域）。
- `tsc -b`、`check:solid`、`check:frontend`（lint/build/bundle/docs/deps 各阶段）通过。

## 并行协作记录

- 与 #97（Gödel）/ #99（图灵）共享工作树：共享文件（`acp/mod.rs`、`runtime.rs`、`dispatcher/mod.rs`、`session/create.rs`）只做外科手术式编辑 + 显式 pathspec 分块提交。
- **披露**：运行 `rustfmt src/lib.rs` 时 rustfmt 顺模块树把 #97 在途的 `session/model.rs`/`model_switch_wire_tests.rs`/`control.rs` 的既有未格式化差异一并格式化——纯格式化、零内容变化，特此报备。
- 分块提交策略：新增文件独立成提交；共享文件 hunk 经 `git apply --cached` 精准暂存，绝不整文件连带他人 WIP。

## 未决问题

- 根级 `loadSession` alias 的实际移除版本待 ACP 标准嵌套路径普及后另立 issue（ADR-0004 已登记弃用方向）。
- elicitation 前端渲染卡（`elicitation.request` 事件已有队列/应答链）未接 UI——按 spec「不重做 UI」边界保留给后续切片。
- `session_fork` 命令暂无 UI 入口（消费链 + TS client 方法已就绪），前端分叉会话登记（identityStore）留待有 UI 需求时接线。
