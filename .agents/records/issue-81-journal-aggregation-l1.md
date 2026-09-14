# Dev Record — #81 存储层聚合（L1：写入窗口聚合 + 双读修复）

> 入库保留。规格文档（spec，`.agents/spec/issue-81-journal-aggregation.md`）不保留，其目标、范围、方案与验收结论在此承接。L2/L3 已裁决、待排期，不在本次范围。

## 元信息

- issue：[#81](https://github.com/AlchemistCxC/Pylon-co-works/issues/81)
- 分支：基于 `Ru5t/Reflector`（cf8f4919）提交，PR 分支引用 `Ru5t/issue-81-journal-l1`
- 提交范围：`cf8f4919..<head>`
- 日期：2026-09-15
- 署名：Laplace（并行施工协调见 `.agents/L.md` [2026-09-15 00]）

## 目标与范围

把流式 delta 的落盘粒度从"每 chunk 一行"抬到"写入窗口聚合"（L1），并搭车修复合话打开时 canonical 事件**双读**（占位 `loadAll` + 权威恢复再次 `loadAll`）。

**做什么**：sink 落盘前合并批次内相邻同类 delta 为 batch 行（跨度占用 sequence）；读侧按 `seqSpan` 展开重建原始 eventId；权威恢复改增量补读；默认 debounce 300→1000 ms（裁决 3）。

**不做什么**（与 spec 一致）：不改 live 渲染链路（`reduceWorkbenchEvent`/渲染器零改动）；不引入第二份事实表；不动 Rust wire 级 replay/ACP 协商；kernel-committed 轨（Rust ingest）保持逐 chunk；不做 `PRAGMA optimize`/`ANALYZE`（裁决 5）；L2 rollup / L3 裁剪待排期。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/infrastructure/events/canonicalEventBatch.ts` | 新模块：合并规则纯函数（`mergeAdjacentDeltaChunks`、`canonicalBatchSpanOf`、`canonicalBatchChunksOf`、上限常量） | 新增 |
| `src/infrastructure/events/canonicalEventSink.ts` | `processReady`/rebase 的 `markDirty` 改传合并行；persist 成功按 seqSpan 覆盖移除 pending chunk；默认 `debounceMs` 1000 | 修改 |
| `src/domains/events/eventSchema.ts` | `CANONICAL_EVENT_TYPES` 增 `assistant.text.delta.batch` / `assistant.thinking.delta.batch`（裁决 2） | 修改 |
| `src/domains/events/messageProjectionRules.ts` | delta 分支增两个 batch case（text=拼接、role 映射一致） | 修改 |
| `src/domains/workbench/events/workbenchEventSchema.ts` | `CANONICAL_SEMANTIC_PROJECTION_REGISTRY` 增两 batch 条目（类型全盖；正常消费走展开） | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | `canonicalRowToWorkbench` 拆出 `normalizeCanonicalRowToEnvelopes`；新增 `expandCanonicalBatchRow`（seqSpan 重建 id；损坏行退单行归一） | 修改 |
| `src/infrastructure/events/canonicalEventRepository.ts` | 新增 `loadCanonicalEventsIncremental`（revision + 前向区间读补差量；失败回退 `loadAll`） | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchLifecycle.ts` | 占位行保留为游标基线；`startPersistedLoad` 的 `loadCanonical` 改增量补读 | 修改 |
| `src-tauri/src/session/event_repo.rs` | `mod tests` 增 batch 行落盘契约测试（跨度占用、revision=MAX(sequence)、eventId 一致性、回读不变形） | 修改 |
| `src/infrastructure/events/__tests__/canonicalEventSink.batch.test.ts` | 合并边界/上限切断/还原/revision/rebase/force/默认窗口 | 新增 |
| `src/domains/events/__tests__/messageProjection.batchEquivalence.test.ts` | 逐 chunk vs 聚合 Message[] 逐字节等价 golden | 新增 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.batch.test.ts` | replay/live 文档逐字节等价 + appliedEventIds 重建 + 损坏行兜底 | 新增 |
| `src/infrastructure/events/__tests__/canonicalEventRepository.test.ts` | `loadCanonicalEventsIncremental` 4 例（差量/无差量/回退×2） | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §8.4 `canonical_events` 条目补聚合行为表述 | 修改 |

## 方案要点

1. **pending 保持逐 chunk，合并发生在 markDirty 之前**。`processReady` 与 conflict rebase 都只重排 chunk sequence，再经同一 `mergeAdjacentDeltaChunks` 产出落盘行——裁决口径"id 分配与 rebase 用同一合并规则、不分叉"由此按构造成立，rebase 代码本身零改动。
2. **跨度占用**：batch 行取 run 内末条 `sequence`/`eventId`，`typedPayload.seqSpan=[first,last]`，中间编号不占用。全仓无 sequence 连续性假设（Rust 只验 `eventId == owner#sequence` 一致 + expected_revision=MAX(sequence)），写后 revision 与未合并完全一致；读侧按 `owner#(seqSpan[0]+i)` 重建 sub-envelope id ⇒ `appliedEventIds` 与逐 chunk 存储逐一相同，`projectWorkbench` 去重与 `refresh()` 幂等零改动。
3. **合并条件**：类型 ∈ 两 delta 且相邻同类；**identity 全字段相等**（比 spec 的三元组口径更严：合并更少、绝不少并行为不同的事件）；run 内 rawPayload 字节与 foldedCount 超限即切断（不截断）。单条 run 保持原事件（不合成 foldedCount=1 的行，最大化既有行为保真）。
4. **字节预算 48 KiB，非裁决字面的 256 KiB**（偏差，见下）：Rust `retain_raw_payload` 在 64 KiB 处截断替换 rawPayload，256 KiB 预算会触发 `raw_truncated`，直接违反"不截断、rawPayload 可逐字节还原"的裁决意图。取 48 KiB（25% 余量，吸收 Rust 侧 redaction 尺寸抖动与 UTF-8 计量差）。
5. **读侧展开**：`canonicalRowToWorkbench` 遇 batch 类型按 seqSpan 逐 chunk 调 `normalizeAgentEvent`；形状不互洽（数组长度 ≠ foldedCount ≠ 跨宽）的损坏行走单行归一兜底（产出 `event.unknown`，raw 不丢）。
6. **双读修复**：`readCanonicalPlaceholder` 的行保留为基线，权威恢复以 `revision()` + `loadCanonicalEventRange` 补差量；任何失败回退 `loadAll`。等价性按构造（基线 ≤ 游标升序 + 差量 > 游标升序 = 全量升序），新增断言对照 `loadAll` 快照。
7. **时间戳语义**：batch 行沿用 run 首条时间戳。逐 chunk 行每 chunk 的 `receivedAt` 不进入文档字节（message `time`/thinking 起点只取 run 首条；append 不更新 time；timeline entry 无 time 字段），等价性因此不依赖时间戳巧合——测试中逐 chunk 行携带互不相同的 receivedAt 以锁定该性质。

## 验收标准与结果（L1，spec 编号）

| 验收项 | 结果 |
| --- | --- |
| 1. 同段 wire 两路径落盘，delta 行数下降 ≥10× | ✅ 按构造成立（sink.batch 测试：3 chunk→1 行；2002 chunk 小 wire→多行无缝铺满）。真机复验待办（见未解问题） |
| 2. 两路径 `Message[]` 逐字节相等 | ✅ `messageProjection.batchEquivalence` 7 例（含 identity 变化/类型切换/工具卡切断/空文本/终态后续流） |
| 3. 写后 revision（MAX(sequence)）相等；expected_revision 行为不变 | ✅ sink.batch + Rust `batch_row_occupies_span_tail_and_revision_follows_max_sequence` |
| 4. 重放 == 增量：appliedEventIds 相同、文档逐字节相等 | ✅ `agentWorkbenchSession.batch` replay/live 两例（JSON 全文比对） |
| 5. 未知事件与非 delta 事件逐字节一致 | ✅ 合并函数对非 delta 原样透传（sink.batch 断言 user/tool 行原事件） |
| 6. rawPayload 可还原（逐字节、顺序不变） | ✅ sink.batch + projection equivalence 断言 `rawPayload == wire 数组` |
| 7. force 语义不变 | ✅ sink.batch force 例（false 不落盘 / true 立即） |
| 8. 上限生效切断成多行、无 `raw_truncated` | ✅ sink.batch 字节切断例 + 纯函数 foldedCount 注入例；Rust 断言 `!raw_truncated` |
| 9. 实时渲染零 diff | ✅ `reduceWorkbenchEvent`/渲染器文件零改动（git diff 佐证） |
| 10. 双读修复：结果与全量重读一致；第二次 loadAll 不再发生 | ✅ repository 增量 4 例（loadAll 计数断言） |

## 测试处置

**新增**：`canonicalEventSink.batch.test.ts`（13）、`messageProjection.batchEquivalence.test.ts`（7）、`agentWorkbenchSession.batch.test.ts`（3）、`canonicalEventRepository.test.ts` 增 `loadCanonicalEventsIncremental` describe（4）、Rust `event_repo.rs` 增 2 例。

**修改**：无既有断言削弱（`canonicalEventSink.test.ts` 等显式传 `debounceMs: 300`，不受默认值变更影响，原样全绿）。`workbenchEventSchema` 注册表类型全盖新增两条目（编译器强制）。

**删除**：无。

## 证据

- 测试（Windows / bun 1.x / vitest 4.1.11 / cargo）：
  - `vitest run src/domains/events src/infrastructure/events src/sheets/agent-workbench src/renderers/solid-workbench src/components/chat/__tests__/canonicalEventDoubleWrite.test.ts` → **84 文件 / 831 通过**（exit 0）
  - `tsc -p tsconfig.solid.json --noEmit` → exit 0
  - `bun run lint` → **0 error**（1 个 pre-existing warning：`RightRailHost.tsx` exhaustive-deps，HEAD 上已存在）
  - `bun run check:solid` → exit 0
  - `cargo test --lib`（全量，含 b11/obs03/p1）→ **971 通过 / 0 失败**
  - `bun run check:frontend` → **被并行 WIP 阻塞**（见"并行交集"）：4 个失败断言全部位于 [#82] 的 hooks/API 1.3 未完成改动（`packageManifest.test.ts`×2、`sdk.test.ts`×1：断言 api=1.3 应被拒而其 WIP 已放行；`pluginCompositionRoot.test.ts` 1 例隔离复跑即通过，属负载抖动）。干净 HEAD（stash 后）该两文件通过 ⇒ 与 #81 无关。#81 文件域内的门禁（上述 vitest/tsc/lint/check:solid/cargo）在合并树上全绿。

## 与 spec 的偏差

1. **单行字节预算 48 KiB（spec/裁决 4 字面 256 KiB）**：Rust 64 KiB 截断阈值使 256 KiB 必然产生 `raw_truncated`，与裁决 4 自身"不截断、不改 raw_truncated 语义"矛盾；取能保证落盘不截断的最大安全预算。属实施期调参，合并判定逻辑不变。已在本记录与 L.md 标注，待仓库主追认。
2. **合并条件 identity 全字段相等（spec 口径为 messageId/turnId/toolCallId 三元组）**：更严而非更松（合并更少），workbench envelope identity 展开因此逐字段保真。不减少裁决意图下的收益（流式 run 内 identity 恒定）。
3. **单条 run 不合成 batch 行**：spec 未明确 foldedCount=1 是否成批；选择保持原事件以最大化"未知/单条事件逐字节一致"。
4. **`workbenchEventSchema` 注册表加两 batch 条目**：spec 未点名，但注册表类型为全盖 `Record<CanonicalEventType, …>`，新增类型必须补条目（编译器强制）；语义与单条 delta 一致，仅为兜底路径。

## 未解问题

- 真机单轮复验（真实 Agent 流式一轮后 `canonical_events` 行数对比、会话打开耗时前后对比）需真机环境，留待下一会话/仓库主验证；spec 基线：top-6 owner 54,799 delta。
- `check:frontend` 全绿依赖 #82 完成其测试同步；#81 文件域门禁已全绿（见证据）。
- L2/L3 按 spec 待排期；L2 开工前需先补 seqRange 覆盖判断等价性测试（spec 已注明）。

## 并行交集

- 本会话与 [#82 Fibonacci] 同仓并行（其 WIP：hooks/API 1.3、`browser_agent/` 等，不在我的域）。双方均未改写对方文件；`agentWorkbenchLifecycle.ts` 同时含双方独立改动（我：`activate`/`startPersistedLoad` 增量接线；他：`invokeSessionStartHook` 迁至 `sessionHookTransactions`），语义互不依赖，已确认共存。
- 本记录的提交**只含 #81 文件域**；`AGENTS.md` 修改、`docs/` 删除项、`src-tauri/loader-error.txt`、#82 全部文件一律未纳入。
