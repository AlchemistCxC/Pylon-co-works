# Dev Record — #439 canonical sink 自写轨退役

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#439（同 PR 附带 #444 批次①）
- 分支：`kumo/prometheus`
- 提交范围：`d69afd32..8811adb8`（批次① `9da72d00`、批次 1 `7ab6a3c3`、批次 2、批次 3 `8811adb8`）
- 日期：2026-09-29

## 目标与范围

canonical journal 收敛 **kernel 严格单写者**：删除前端「第二写者」死代码（canonicalEventSink 自写轨：本地 sequence 分配 / conflict rebase / `*.delta.batch` 写入 / debounce 落盘）与后端 `evt_append` 非 kernel 写入口；`*.delta.batch` 预算常量随写侧退役、`fold.rs` 成唯一单源。

**不做什么**：cursor/gap 回填（另一议题）、投影、draft 前端对账、batch 常量 generate-* 代码生成（写侧删除即单源，生成链无必要）、`mergeAdjacentDeltaChunks` 物理搬迁（#449 基准在途依赖，见「顺延」）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/infrastructure/events/canonicalEventSink.ts` | 全文件 | 删除 |
| `src/infrastructure/events/canonicalEventPersistScheduler.ts` | 全文件 | 删除 |
| `src/infrastructure/events/__tests__/canonicalEventSink.test.ts` 等 3 个直测 | 全文件 | 删除 |
| `src/components/chat/__tests__/canonicalEventDoubleWrite.test.ts` | 全文件 | 删除（双写契约消失，两项行为由 feed 测试承载） |
| `src/infrastructure/events/canonicalEventFeed.ts` | offer/flush/flushAsync 接口、sink 实例、工厂注入缝（Deps/ForTests）、noop sink；discard 退化 cursor.forget | 修改 |
| `src/infrastructure/events/canonicalEventRepository.ts` | append/appendImpl、头注释 | 修改 |
| `src/infrastructure/events/canonicalEventBatch.ts` | CANONICAL_BATCH_LIMITS/CanonicalBatchLimits/batchEventTypeOf 删；mergeAdjacentDeltaChunks 降级「测试期参考合并器」（预算字面量内联） | 修改 |
| `src/app/lifecycle/drainPersistentStateBeforeClose.ts` | 接口删 flushCanonical、收敛 identity 单链 | 修改 |
| `src/App.tsx` | drain 接线、多余 import | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | resolveDraft 空转 flush 摘除（**hunk 分账提交**，同文件 #440 在途 hunk 未带入） | 修改 |
| `src/application/hooks/canonicalHookProjection.ts` | 注释随迁 | 修改 |
| `src/__tests__/replay/canonicalEventFeed.test.ts` | 注入缝摘除 | 修改 |
| `src/__tests__/replay/absoluteOracle.test.ts` | 预算常量改测试本地硬拷贝 | 修改 |
| `src/app/lifecycle/__tests__/drainPersistentStateBeforeClose.test.ts` | 用例随接口收敛 | 修改 |
| `src/infrastructure/events/__tests__/canonicalEventRepository.test.ts` | append 用例迁移 revision 载体 | 修改 |
| `scripts/perf-bench/suites/eventsSuite.ts` | 注释随迁 | 修改 |
| `src-tauri/src/session/mod.rs` / `lib.rs` | `evt_append` 命令与注册删除 | 修改 |
| `src-tauri/pylon-session/src/event_repo/fold.rs` | 单源注释收口 | 修改 |

## 方案要点

1. **删除而非迁移**：sink 生产 `.offer()` 调用方为零（turn_rollup.rs 头注佐证 kernel 单写者），第二写者实现只构成「复活即双写」隐患。
2. **evt_append 必须同批删**：它不在 `check:ipc` 的 IPC_EXEMPT 清单，前端停调后门禁会以「后端注册但前端零调用」报红——两侧同批删除后双向一致恢复。
3. **常量单源靠删除达成**：`CANONICAL_BATCH_LIMITS` 的唯一生产消费者是 sink 写侧合并；删除后 `fold.rs` 注释自陈的「彻底单源需走 generate-* 代码生成」前提消失，无需生成器。
4. **读侧/写侧分离**：`canonicalBatchSpanOf/ChunksOf/isCanonicalBatchDeltaType` 是投影展开的读侧契约，保留；写侧合并规则降级为测试造数器。
5. **共享文件 hunk 分账**：`agentWorkbenchSession.ts` 用私有 index 只提交本批 hunk，#440 的在途 applyLive 改动留在工作树。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `check:ipc` 双向一致 | 绿（228 注册 / 159 invoke，豁免 52） |
| `tsc -b` | 绿 |
| `bun run lint` | 0 errors（1 warning 位于 GatewaySheetView.tsx，非本批文件） |
| replay+events 测试 | 504 passed / 1 todo |
| 生产源码无 `.offer(` 调用 / `evt_append` invoke | 确认（grep 零命中） |
| `CANONICAL_BATCH_LIMITS`/`mergeAdjacentDeltaChunks` 残留 | 仅 test-only（absoluteOracle 本地常量 + replay 造数器 + memorySuite） |
| `cargo build` / `cargo test --workspace --lib` / `check:clippy` / `bun run test` 全量 | 见下方「证据」补充 |

## 测试处置

- **删除**：`canonicalEventSink.test.ts`、`canonicalEventPersistScheduler.test.ts`、`canonicalEventSink.batch.test.ts`（测的是退役实现本身）、`canonicalEventDoubleWrite.test.ts`（双写契约消失；其「只投影不落盘」「gap 回填」两行为由 `canonicalEventFeed.test.ts` 既有用例承载）。
- **修改**：`drainPersistentStateBeforeClose.test.ts`（canonical 链用例删、单链化）、`canonicalEventRepository.test.ts`（append 映射用例删；conflict/code 透传用例载体 append→revision，语义不变）、`canonicalEventFeed.test.ts`（摘 sinkFactory 注入缝，断言不变）、`absoluteOracle.test.ts`（常量本地化）。

## 证据

- `check:ipc`：`ok — 后端注册 228 个命令，前端 invoke 159 个，双向一致（豁免 52）`。
- `bun run test` 全量：**660 文件 / 5102 passed**（1 skipped / 1 todo）。
- `cargo test --workspace --lib`：9 target 全绿，合计 **1619 passed / 0 failed**（961/186/9/36/137/87/22/0/181）。
- `check:clippy`：`added: []`（基线外零新增诊断）。
- `cargo build` dev profile：Finished（1m49s）。
- lint：`0 errors`（1 warning 为 GatewaySheetView.tsx 既有，非本批）。

## 顺延与联动

- **3b（顺延）**：`mergeAdjacentDeltaChunks` 物理搬迁至 `src/test-utils/`——#449（perf-bench 基准）在途新增对它的依赖，收工后随迁 import（replay 10 文件 + fixtures.ts + memorySuite.ts）。
- **#447 处置**：canonicalEventSink seeding 队列 cap 随 sink 退役失去对象，建议关闭（或其「文档化部分」转移——sink 语义已消，无文档可留）。
- browser 预览模式不受影响（非 Tauri 本为 noop sink，现已无此分支）。

## 审查修正（2026-09-29，独立审查裁决「需修正后合并」后补记）

- **B1 · 批次 2 丢失一个测试删除**：`canonicalEventSink.batch.test.ts` 的 `git rm` 未随批次 2 的 pathspec 提交落盘（`git commit -- <paths>` 不包含未 add 的删除），分支 tip 由 **`cf29a865` 代修补落**（修正 §2.5 纪律事故：staged 删除务必随批核 `git status`）。本记录初版所载门禁读数（tsc 绿 / vitest 5102）系**共享工作树测量**（含该未提交删除），对 4038e309 提交树不成立；cf29a865 后提交树与工作树重新一致。
- **C6 · 测试迁移表述修正**：初版「载体 append→revision，语义不变」高估——`event_revision_conflict`/`event_invalid`/`event_session_deleted` 对 revision 载体**不可达**（RevisionConflict 仅 append 比对 expected_revision 时产生）；用例实际语义从「adapter 透传后端真实可达错误」弱化为「mock 驱动的错误归一函数测试」（`asCanonicalEventRepositoryError` 为全命令共享路径，用例仍有价值）。生产代码已无任何路径能收到 `event_revision_conflict`（唯一按它分支的 sink 已删）。
- **C2/C3 已修**：`pylon-session/src/lib.rs` 单源注释与 fold.rs 的内部矛盾、`session/mod.rs` evt_revision 的 scheduler 失效指涉。
- **C4（移交后续小批）**：`evt_append` 命令名注释指涉清理——Rust 侧 8 文件（del01/del03/del05/user_data/event_repo tests/draft_flush:272/dispatcher mod.rs:867/**session mod.rs:81**，复审补遗）+ 前端注释与死 fixture（src/obs06/deleteErrorForensics.ts:18、src/obs06/devTrigger.ts:14、obs06 测试:236 的 `cmd:'evt_append'` 取证分类字符串）+ 测试头注释对已删测试文件的指涉（replay/harness.ts:19,32-33、del05_p4DeleteMatrix.test.ts:9-11）+ canonicalEventRepository.ts:15-17 模块头错误码清单的 `event_revision_conflict`（生产不可达，随批收敛）——gate 语义本体（`EventService::append_events`）仍存活，命令名指涉失效，留独立清理批。
- **C5（移交 #449）**：`scripts/perf-bench/README.md:222` 仍指导 invoke 已删除的 `evt_append`——README 在 #449 在途域，已 L.md 移交随迁修正；「全仓 grep evt_append 零命中」应限定为「生产 src/」。
- **N2（实测关闭）**：跨测试文件 import `extractBraceBlock` 的「describe 双注册」担忧经实测否定（sanitize 单文件跑 = 14 tests，acp-vocabulary 用例未重复注册；全量计数亦吻合）。
