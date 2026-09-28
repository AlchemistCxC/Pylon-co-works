# Dev Record — #440/#441/#443/#446/#449 前端性能/内存热点清偿批次

> 承接规格 `.agents/spec/440-449-perf-mem-hotspots.md`（不入库）。调查底稿：本会话两轮调查（初查 + 两个深挖子代理），关键事实已抄录进各 issue 正文。

## 元信息

- issue：#440、#441、#443、#446、#449（#447 避让 #439 在途域，顺延）
- 分支：共享线施工中途由 `kumo/prometheus` 演进为 `kumo/439-review-fixes`（#452 已并），本批提交在其上、以 `kumo/perf-mem-hotspots` 推远端开 PR
- 基准提交：`c2a3a190`（L.md 开工声明）；base = `82ca7e68`（已并入 main）
- 日期：2026-09-29

## 目标与范围

清偿首轮调查+深挖确认的热点：live 每帧 O(N)（#440）、显示链每发布 O(N)（#441）、高亮缓存无字节预算（#443）、诊断无上限累积（#446）、perf-bench 盲区（#449）。**不做**：⧖ 三条待裁决项（text 族 timeline 收窄扩 K20 / event.unknown data 收窄（#405 冲突）/ interactions C11）、#447（canonicalEventSink 在 #439 在途域）、messages 追加拷贝（快照身份地基）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | applyLive 的 priorUser 段：`[...messages].reverse().find` → 倒序下标扫描（#440） | 修改 |
| `src/domains/workbench/workbenchRuntime.ts` | freezeDocument 对 appliedEventIds/appliedRanges 改 freezeItems 同款（引用相等沿用；小数组整体冻结、大数组解冻基线）（#440-b） | 修改 |
| `src/domains/workbench/messageListPort.ts` | 自 WorkbenchContent 抽出 `reuseMessageListItems`（P57 S2-R3 原样）+ 稳态「输出喂回」引用门（#441-A） | 修改 |
| `src/renderers/solid-workbench/WorkbenchContent.solid.tsx` | viewMessages 引用门 + 链路改走门控缝（#441-A） | 修改 |
| `src/components/chat/messagePipeline.ts` | `prepareMessagesOf` 单槽引用门（#441-A） | 修改 |
| `src/components/chat/messageLookups.ts` | `messageLookupsOf` 单槽引用门（#441-A） | 修改 |
| `src/components/chat/chatRowPipeline.ts` | `chatRowDescriptorsOf` 门 + `buildChatRowDescriptorsIncremental` 前缀增量（lookups 非空即回退全量）（#441-A/B） | 修改 |
| `src/components/chat/codeHighlight.ts` | 2M 字符预算 + 单条 64K 不缓存 + `highlightCacheStats()` 只读读数 + 过时头注修正（FileTabView 已退役）（#443） | 修改 |
| `src/domains/workbench/workbenchProjector.ts` | `addDiagnostic`：同 code+message 计数环 / 256 条目环 / 256KB data 字节预算环（error 豁免，`count`/`dataOmitted` 可选字段）（#446） | 修改 |
| `scripts/perf-bench/` | 新域 `display-chain`（append-delta / usage-only 两 pair）+ projector 域 `reduceWorkbenchEvent(live)` pair + 共享夹具 `fixtures/foldedDocuments.ts`（memo + 惰性构造）+ memory 语料补 text/thinking（增量 chunk）+ memorySuite 折叠前过 `mergeAdjacentDeltaChunks`（batch/逐delta 双档）+ README 判据行（#449） | 修改+新增 |
| `docs/说明书/Pylon-模块维护地图.md` | 前端计算核行的 perf-bench 句补两域与 text 族判据挂起一句 | 修改 |
| 测试 | `displayChainMemo.test.ts`（新增 6 例）、`codeHighlight.test.ts`（+3 例）、`workbenchProjector.test.ts`（+#446 组 5 例） | 新增 |

## 方案要点

1. **#440-a**：`reverse().find(role==='user')` ≡ 倒序取末条 user，零分配等价改写；`priorUser` 全仓唯一读者是 `isUserStart` 的 `?.running === true`。
2. **#440-b**：live 每个 coverage 事件投影器都新建 applied 数组 ⇒ runtime 引用必失配 ⇒ 旧代码整表拷贝+逐项冻结。改 #204③ 同款。**实测警示**：live-l 只降 ~4%（12.67→11.3–12.2ms/事件）——折叠加逐档的主导成本在别处（timeline 整表拷贝 / freezeDeepValue 嫌疑），#440 因此**不关闭**，留 profile 口。
3. **#441-A**：四道单槽引用门（viewMessages / prepare / lookups / descriptors+items），安全性前提是既有的快照冻结 + COW 纪律（与 freezeItems 指针短路、toSolidMessage WeakMap 同一前提，非新增假设）。`reuseMessageListItems` 的门键在**输出**（组件稳态把上一拍输出喂回当 previous；键在输入会永远差一拍）。
4. **#441-B**：descriptors 前缀增量——按下标对齐沿用 descriptor 对象，首个失配下标起重建。安全阀：**两侧 lookups 任一非空即整段回退全量构建**（工具行视觉状态可被别的消息改写，引用稳定推不出内容稳定）；canonical 生产三 Set 恒空 ⇒ 恒走增量。
5. **#443**：对齐 `markdownRenderModel` 的 2M 字符口径 + 64K 单条不缓存（与 canonical raw 同量级；超限块重算可让出不卡帧）。
6. **#446**：计数环键为 **code+message**（event.unknown 卡片标题取变体名，不同 originalType 必须各自成卡——保 #405 语义）；data 预算 256KB 从最旧非 error 条目摘 `data` 置 `dataOmitted`（卡片与 message 保留）；预算记账按数组引用 memo（同 orphanActivityIdsMemo 先例），每次诊断事件只 stringify 增量那条。**已标记边界**：event.unknown 的 data 在预算内会被压力摘除（有标记）——与 #405「原始载荷留在事件详情」的冲突面在 issue 评论区留了决策口，如需豁免改一处表。
7. **#449**：基准夹具惰性构造（xs/s 档不为 l 档的 240k 事件折叠付费——首版急切构造曾让 xs 档白烧数分钟 CPU）；memorySuite 折叠前过 `mergeAdjacentDeltaChunks`（此前直折 rows 不过 sink，per-chunk 行永不折 batch，正是语料缺口）；**text 族驻留判据挂起**（实测 3.119×，tool 族 1.2× 口径对文本族不成立——WorkbenchMessage content/parts 双字段固有 2×，M2 收窄也只能到 ≈2×），阈值归 M2 裁决包。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| #440-a 行为等价 | agentWorkbenchSession / rebindIndicator / workbenchRuntime turnEpoch 组全绿（66 例） |
| #441 引用复用契约（P57 S2-R3 / #243 / #55） | solid-workbench 全组 + PlainMessageList 全绿；新增门语义 6 例 |
| #443 缓存契约 | `codeHighlight.test.ts` 37 例全绿（缓存+pending 去重原样，+预算 3 例） |
| #446 既有契约 | workbenchProjector / Lifecycle / usageBudget 42 例全绿（#405 event.unknown data 形状原样）+ 新 5 例 |
| perf-bench / memory 判据 | `bun run perf-bench`（m/full）exit 0；`bun run perf-bench:memory` exit 0（text 驻留为挂起读数） |
| 读数 | 见下表 |

**读数对照**（bun/V8，本机；不同批次有负载噪声，同表内成对比较才可靠）：

| pair（case） | 改前 | 改后 | 说明 |
| --- | --- | --- | --- |
| displayChain usage-only（rows-m 10k） | 3.5–4.1ms/发布 | **0.003ms** | 四门全命中——tool/usage 事件显示链成本归零（#441-A 契约兑现） |
| displayChain usage-only（rows-l 40k） | 12.87ms | **≈0** | 同上 |
| displayChain append-delta（rows-l 40k） | 12.39ms（0.31µs/行） | 见审查轮校正 | 尾行交替修复后 B 的失配段每拍重建，读数含真实重建成本 |
| reduceWorkbenchEvent(live)（live-l） | 见审查轮校正 | 见审查轮校正 | **初版读数作废**——fixture 终态栅栏缺陷（见审查轮一节） |
| memory text 驻留 | （无语料） | **3.119×**（挂起读数） | 深挖 3S 模型实测坐实；M2 裁决证据 |
| memory text 粒度对照 | （无语料） | batch 3.55× 于逐 delta | 折叠缺失的代价值 |
| memory text 拍敏 | （无语料） | 1.01×（≤1.5× PASS） | batch 折叠下天然低拍敏 |

## 测试处置

- 新增：`displayChainMemo.test.ts`（6）、codeHighlight 预算组（3）、workbenchProjector `#446 diagnostics 环` 组（5）。
- 修改既有行为测试：**无**（既有断言全部原样通过；`workbenchProjector.test.ts:108-130` 的批量等价、`PlainMessageList.solid.test.tsx` 引用门、`issue55.rowSetPurity`、`issue243` 均绿）。

## 证据

- 提交：本记录同批次的 pathspec 提交序列（见 git log；分支 `kumo/prometheus`）。
- 测试：`npx vitest run src/components/chat/__tests__/ src/renderers/solid-workbench/__tests__ src/renderers/solid-workbench/chat/__tests__/ src/domains/workbench/__tests__/ src/sheets/agent-workbench/__tests__/ src/__tests__/replay/` → **1662 passed / 0 failed**（B 字段修正后复跑）；`bun run lint` 0 error（1 条存量 warning 在 GatewaySheetView.tsx，他人域）。
- 基准：`bun scripts/perf-bench.mts`（m 与 PERF_SCALE=full）与 `bun run perf-bench:memory` 均 exit 0，读数见上。

## 与 spec 的偏差

1. **#441-B 从「依读数决定」改为落地**：A 的读数显示 usage-only 归零但 append-delta 仍 O(N)，且风险由「两侧 lookups 全空」安全阀兜住（legacy 回退全量），决定实施。
2. **#446 计数环键含 message（审查轮后加 level）**：spec 写的是「同 (code)」；实施时发现 event.unknown 的卡片标题取变体名，按 code 折叠会丢 #405 的变体区分，收紧为 code+message；审查轮再收紧为 code+message+level（info→warning 的升级证据不能被首条 level 吞掉）。
3. **#449 text 族判据从 1.2× 改挂起**：深挖与实测都表明 WorkbenchMessage 双字段固有 2×，1.2× 对文本族结构性不可达——阈值归 M2 裁决包，避免门禁假红。

## 审查轮（两独立子代理，2026-09-29）

**结论：语义审查 APPROVE WITH NITS；基准审查 BLOCK（两处口径失实，均已修复）。**

- **[P0] live pair fixture 终态栅栏（已修）**：`mixedJournal` 以 `session.completed` 收尾 ⇒ 基文档是终态会话，64 连拍全部被 `late-event-after-terminal` 栅栏丢弃——初版 pair **根本没在折消息**，其读数与「#440-b 治理占 ~4%」的归因一并作废。修复：连拍前先喂一条 `session.status-updated running`（真实「新回合开始」形状）；pair note 重写为真实口径——本 pair 只量**投影器归约层**（timeline 整表拷贝为主项），runtime `freezeDocument`（#440-b 治理面）与 publish 扇出**不在读数内**，#440-b 的成本需单独量（导出 freezeDocument 单列 pair 或 applyLive 打点）。
- **[P1] #446 dataOmitted 违约态（已修）**：合并携带旧标记会造出 `data` 与 `dataOmitted:true` 并存——恢复 data 时剥掉标记（结构解构去键），新增测试锁。
- **[P2] 已修**：计数环键加 level；条目环改单趟 filter 保持到达序（error 不再被前置重排，error center 展示序不变）；环触发后重算全表（防幻影字符把有效预算压零）；`cacheResult` 双记防御；displayChain append-delta 尾行双变体交替（fixture 引用全稳会让 B 增量「零行重建」低估成本）；wiredAt 范围与 stale note 修正；README/memorySuite 把 `mergeAdjacentDeltaChunks` 限定为「测试期参考合并器，生产折叠归 Rust fold.rs」。
- **补锁测试**：workbenchProjector 审查组 3 例（dataOmitted 恢复、level 不成环、环保到达序）+ displayChainMemo 的 B≡全量 `toStrictEqual` 等价断言。
- **修复的入库方式**：审查修复完成并验证（2026-09-29 02:13 全量 1662 绿）后，前端结构全修批次开始施工并声明携带本批未提交 hunks 随迁移入库（L.md d3ac84c2 披露）；本记录落定时修复内容已确认在新落点完好（`workbenchProjector.ts` 留原地，chat 三件迁 `src/domains/chat/`），迁移树上针对性复跑 **61 passed / 0 failed**。
- **审查确认无 finding 的域**：#441 四道门（含 COW 前提全量核查、增量路径逐字段等价论证、跨消费者安全）、#440 applied 集合「冻结后写入」路径追索（live/batch/foldPage/updateRuntimeState 全无复现）、#443 LRU 与并发去重、3437af7a 归属与无冲突。
- **遗留（范围外，列供后续）**：live 单事件幂等判据仍 Θ(N)（`appliedEventIds.includes` + spread，workbenchProjector.ts:434/:448）——#440 跟踪。

## 未解问题

1. **live 折叠的主导热点**：初版 pair 读数作废（fixture 缺陷），修复后的真实读数见审查轮校正表；#440-b（freezeDocument 治理）的单独成本需导出 freezeDocument 单列 pair 或 applyLive 打点才能归因。嫌疑主项仍是 timeline 整表拷贝与 freezeDeepValue。#440 保持开放。
2. **live 单事件幂等判据 Θ(N)**（`appliedEventIds.includes` + spread）：范围外残留，#440 跟踪。
3. **⧖ M2**：text 族 timeline 收窄（扩 K20，一行改动）——证据已齐（3.119×、无生产读者），待仓库主裁决。
4. **⧖ event.unknown data 预算豁免与否**（#405 冲突面，见 #446 评论区）。
5. **⧖ interactions C11**：维持不动。
6. **#447**：避让 #439，待其合入后实施（seeding 队列 cap + droppedCount 上报；pending 红线维持现状）。
