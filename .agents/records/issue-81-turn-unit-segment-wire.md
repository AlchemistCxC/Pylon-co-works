# Dev Record — #81 回归修复：`turn.unit` 段内事件改走 EVT-01 canonical 形状 + 读边界归一 + 段级隔离

> 入库保留。规格文档（spec，`.agents/spec/issue-81-turn-unit-segment-wire.md`）不保留，其目标、范围、方案与验收结论在此承接。
> 承接 `issue-81-journal-aggregation-l1.md` / `issue-81-journal-aggregation-l2-l3.md`。

## 元信息

- issue：[#81](https://github.com/AlchemistCxC/Pylon-co-works/issues/81)（bug 回归登记于 #81 评论区，[comment-5675009523](https://github.com/AlchemistCxC/Pylon-co-works/issues/81#issuecomment-5675009523)）
- 分支：`Ru5t/Reflector`（沿用，未新建单 issue 分支）
- 提交范围：`cfe4b79a..<head>`（本记录与代码同提交）
- 日期：2026-09-15
- 署名：Lebesgue

## 目标与范围

**用户报障（引用原话）**：「该项目在完成了对后端存储的优化后，出现了重启应用后无法重放会话的bug」「发送消息完成会话交互-关闭应用-启动应用-刚才那一轮会话没有作为会话历史被正确重放」。

**根因**（一处，两个症状）：`turn.unit` 单元行的整行 segment 经 `serde_json::to_value(CanonicalEventRow)` 落盘，得到的是**数据库扁平列形状**（无嵌套 `owner`），而前端唯一契约是**嵌套 owner 的 canonical 事件**（EVT-01）。嵌在 payload 里的行绕过了读边界的归一化：

1. `canonicalRowToWorkbench` 以 `'owner' in row` 为门槛 ⇒ 段不可读 ⇒ 触发"整单元退单行归一"兜底 ⇒ **整轮塌成一条 `event.unknown`**（重启后历史丢失）；
2. `expandTurnUnitRows` 把扁平段事件原样投进消息投影 ⇒ `messageProjectionRules` 取 `event.owner.localSessionId` **抛 TypeError**（首屏占位 `agentWorkbenchLifecycle` 与跨会话搜索 `searchService` 同路径，即不只是"空历史"）。

**只在重启后出现的原因**：单元行**从不发布给前端**——`dispatcher/routing.rs` 的 `commit_live_event` 只取 `result.events.into_iter().next()`（终态行）；单元行仅存于库中，唯一读取路径是重启后的 `evt_load_compact`（以及搜索）。

**做什么**：①Rust 侧落 EVT-01 canonical 事件（载荷自描述）；②前端解析边界归一嵌入事件（幂等兜底，关闭 TypeError 路径）；③段级隔离（坏段只退化该段）。

**不做什么**：不做存量数据迁移与 sha 兼容（仓库主裁准破坏性更新；且读边界归一后存量单元行仍可正常重放，L3 裁剪仅因 sha 输入形状变化而安全跳过、不删行）；不改 `delta-run` 段结构；不改 `evt_list`/`evt_load_compact` 的扁平 wire 契约；不在领域规则里容忍缺 owner 的事件（那是把不变式 violation 当正常输入）；不改 `obs04` 证据镜像语义；不触碰他人文件域。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/event_repo.rs` | 新增 `canonical_event_wire`（`parse_canonical_event` 的逆）+ 2 测试；扩展 turn 单元段形状断言 | 修改 |
| `src-tauri/src/session/turn_rollup.rs` | `fold_segments` 的整行 segment 改用 `canonical_event_wire`；文件头契约表述同步 | 修改 |
| `src/domains/events/canonicalEventRow.ts` | 从 `infrastructure/events/canonicalEventRepository.ts` **原样迁出** `CanonicalEventWireRow` / `CanonicalEventRow` / `normalizeCanonicalEventRow`（扁平↔嵌套归一的唯一转换点） | 新增（迁出） |
| `src/infrastructure/events/canonicalEventRepository.ts` | 改为从域模块导入；保留 `CanonicalEventRow` 的 re-export（7 处消费者）；不再 re-export 已无消费者的 `normalizeCanonicalEventRow`/`CanonicalEventWireRow` | 修改 |
| `src/infrastructure/events/canonicalEventCursor.ts` | 归一函数改从域模块导入（唯一消费者迁移） | 修改 |
| `src/domains/events/canonicalUnit.ts` | `parseTurnUnitPayload` 在解析边界归一 `kind:'event'` 段；先按载荷原文校验 `sequence` 再归一（避免归一兜底值放行坏形状） | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | `expandCanonicalUnitRow` 由"整单元退单行归一"改为**段级隔离** | 修改 |
| `src/domains/events/__tests__/canonicalUnit.test.ts` | 新增：两种段载荷归一、等语义、消息投影不抛异常、缺 sequence 判定 | 新增 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.batch.test.ts` | 新增生产形状（多轮、用户消息在跨度内）等价、扁平/规范等价、段级隔离 3 例 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §8.4 `turn.unit` 段落补 segment 两类形状与读边界归一/段级隔离表述 | 修改 |

## 方案要点

1. **载荷自描述优先**：新增 `canonical_event_wire(row) -> Value`，紧邻 `parse_canonical_event` 定义并与之互逆（往返测试锁定）：`owner{profileId,agentId,localSessionId,remoteSessionId?}`、`provenance{origin,trust,provider?,importId?}`、`rawMetadata{truncated,originalBytes,retainedBytes,omittedBytes,reason?}`、`identity?`/`typedPayload?`/`rawPayload`/`schemaVersion`。rollup 覆盖列属行存储细节，不属 EVT-01，故不输出。
2. **已知且刻意的不对称**：`raw_*` 截断元数据由 `rawPayload` 重算，已裁剪载荷很短 ⇒ 重解析会报"未截断"。故 wire 显式携带 `rawMetadata`（前端取证需要），但不指望它经 `parse_canonical_event` 往返——用 `canonical_event_wire_keeps_truncation_metadata_in_payload` 把这个不对称钉成事实。
3. **形状归一上移到领域层**：`canonicalEventRow` 是 pure function 模块（无 IPC、无副作用）。原先它与 IPC 仓储同文件，导致纯投影模块若要用它就得 import 拉到 `@tauri-apps/api/core`。迁出后依赖方向单一：域模块只 import `./eventSchema`（type-only），仓储与游标反向依赖域模块。
4. **解析边界先校验后归一**：`normalizeCanonicalEventRow` 会把缺失的 `sequence` 兜底为 `0`，若先归一后校验会放行形状损坏的段 ⇒ 先在载荷原文上要求 `sequence` 是数字，再归一。不可解析的单元仍整体走单行兜底（raw 证据不丢，且其覆盖行本就不在 compact 读返回集内）。
5. **段级隔离**：坏段退化为 `normalizeCanonicalRowToEnvelopes` 的单行归一（`event.unknown`，raw 保留），coverage 取该段自身 `[seq,seq]`；eventId 缺失时用 `<unit.eventId>#segment-<i>` 保唯一，避免两条坏段共用 id 被 `appliedEventIds` 去重吃掉一条。替代 L2 审核时定下的"嵌套失败整单元退单行归一"决策（本回归的放大源）。
6. **Rust 测试断言形状而不只是计数**：L2 的测试只断言 `segments[*].event.eventType`，扁平与嵌套形状都能通过——缺的正是"必须有嵌套 owner"这一条；本次补上（并断言不得出现 `profileId` 等扁平列）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 生产形状单元行（用户消息在跨度内、多轮）经 compact 读展开后 `messages` 与逐 chunk 逐字节相等 | ✅ `agentWorkbenchSession.batch.test.ts` 新增用例（`['第一问','答案','第二问','结论完毕']`，`appliedRanges == [[1,9]]`） |
| `projectMessagesFromCanonical` 对含单元行输入不抛异常且与逐 chunk 等价 | ✅ `canonicalUnit.test.ts` 3 例（规范/遗留扁平两种载荷） |
| `parse_canonical_event(canonical_event_wire(row))` 与 `row` 逐字段相等（除 `created_at`/截断元数据） | ✅ `canonical_event_wire_round_trips_through_parse` |
| 新写 `turn.unit` 行的 `segments[*].event` 含嵌套 `owner` | ✅ `terminal_ingest_appends_turn_unit_and_compact_read_skips_covered_rows` 扩展断言 |
| 段级隔离：单个不可读段不抹掉整轮正文 | ✅ 用户段损坏时 `messages == ['答案']`、`event.unknown` 诊断存在、终态证据仍可得 |
| 遗留扁平与规范段载荷展开结果等语义 | ✅ 两侧 `expandTurnUnitRows` 语义字段一致（额外取证字段允许保留） |
| 既有 L1/L2/L3 行为不回退 | ✅ 65 个测试文件 436 例通过（events/infrastructure/sheets/search/chat） |

## 测试处置

**新增**：

- Rust：`canonical_event_wire_round_trips_through_parse`、`canonical_event_wire_keeps_truncation_metadata_in_payload`
- `src/domains/events/__tests__/canonicalUnit.test.ts`（4 例）

**修改**（均为扩展断言，未削弱既有断言）：

- `src-tauri/src/session/event_repo.rs`：`terminal_ingest_appends_turn_unit_and_compact_read_skips_covered_rows` 增加"段事件必须嵌套 owner、不得扁平列"断言
- `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.batch.test.ts`：新增生产形状 describe（3 例），既有 L2 用例未改

**删除**：无。

## 证据

- commit：（本记录同提交）
- Rust：`cd src-tauri && cargo test --lib` → 见下"未解问题"对基线的说明；`cargo test --lib session::` → **201 passed / 0 failed**；`cargo fmt --check` → 清洁
- 前端：`vitest run src/domains/events src/infrastructure/events src/sheets/agent-workbench src/domains/search src/components/chat` → **436 passed / 65 files**；`tsc -p tsconfig.solid.json --noEmit` → exit 0；`bun run lint` → 0 error（1 条既存 warning：`RightPanel/RightRailHost.tsx` 的 `react-hooks/exhaustive-deps`，非本域）
- 复现对照（修复前，harness 与 `agentWorkbenchSession.batch.test.ts` 同一 bind 路径，仅把 segment 换成 Rust 落盘形状）：逐行 `[user:问题, assistant:答案]` vs 单元 `[]` + `event.unknown`；消息投影抛 `TypeError: Cannot read properties of undefined (reading 'localSessionId')`。修复后同一用例断言逐字节相等。
- 真机复验：**未做**（未启动真实应用与真实 Agent）。

## 与 spec 的偏差

1. spec 原列"修改 `src/domains/events/__tests__/messageProjection.batchEquivalence.test.ts`"：**改为在新增的 `canonicalUnit.test.ts` 覆盖**（同一投影入口、同一断言），避免两处重复用例；spec 的原意（锁定消息侧不抛异常且等价）已达成。
2. spec 未写"迁出 `canonicalEventRow` 域模块"：实现中判定扁平↔嵌套归一是域契约（纯函数、无 IPC），留在 IPC 仓储文件会让纯投影模块 import 到 `@tauri-apps/api/core`，故迁出并保留 `CanonicalEventRow` re-export。属结构改进，不改变行为。
3. spec 的验收 4（`canonical_event_wire` 往返）在实现中补了一条已知例外（截断元数据）并单独测试，spec 原文按"逐字段相等"表述过强。

## 未解问题

- `cargo test --lib` 全量基线：本改动触及的 `session::` 模块 201/201 通过；全量结果受工作区他人 WIP（#82/#85）影响，与本次改动无关的失败需按他人域处理。
- 真机指标（重启后真实会话重放、L3 裁剪后体积）未复验——本轮只做单元/集成级证明。
- **转呈他人域**：`src/plugin-runtime/packageManifest.ts` 的 `JSON.parse(source)` 未包裹 try/catch，pi-lens 在生成物 `src-tauri/resources/sdk/pylon-plugin-sdk.js` 上报两个 🔴。该生成物由 `scripts/build-plugin-sdk.mjs` 产出（模块图 = `src/sdk/index.ts` + `plugin-runtime/*` + `domains/theme/visualSemantics.ts`，**不含本域任何文件**），改生成物会被下次 build 覆盖，真值在源码（#37 Kepler 声明域）。已核对该构造在 HEAD 即存在（`git show HEAD:…` 第 95 行同形），非本次引入；已记两条 pi-lens false-positive 并在 `.agents/L.md` 转呈。
- `retention_policy.trim_rolledup` 对"sha 输入形状变化"的存量单元行的跳过行为是安全的（保留行、不删），但会造成这些 turn 永久不裁剪——当前无用户，按裁决不处理。

## 并行交集

- `docs/说明书/Pylon-项目架构参考.md`（§8.4 单段）；`.agents/L.md`（已按协议追写并被后续他人提交带入）。
- 严格未触碰工作区他人未提交改动：`src-tauri/resources/sdk/pylon-plugin-sdk.js`、`pylon-plugin-manifest.schema.json`、`src-tauri/src/browser_bridge.rs`、`docs/` 下三个删除项、`blobs_tmp.txt`、`src-tauri/loader-error.txt`。
- 提交一律显式 pathspec，只含上表文件域。
