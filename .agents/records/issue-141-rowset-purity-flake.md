# Dev Record — #141 issue55.rowSetPurity 行集纯度用例全量跑偶发红

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-141-rowset-purity-flake.md`

## 元信息

- issue：GitHub `AlchemistCxC/Pylon-co-works#141`（`bug(test)`：全量跑下 `issue55.rowSetPurity` 的「55 段规模 + token 级切片」用例偶发红，`waitFor` 等待解析落地超时）
- 分支：`Ru5t/Reflector`（AGENTS §2.5：专心在单个分支上工作）
- 提交范围：`67e7165c..d1b48530`
- 日期：2026-09-17
- 环境：Windows 10.0.22631 / 20 逻辑核 / Git Bash / bun 1.4.0 / vitest 4.1.11

## 目标与范围

**要达成**：全量跑稳定绿，且**不削弱**该文件锁定的 #55 行集不变式——`.term-md-skeleton` 作为解析中的合法加载态，不得再让「无空块」断言超时。

**不做**：不改产品代码（`MarkdownContent.solid.tsx`、`markdownRenderModel.ts`、`streamingMarkdownSplit.ts`）；不改 `vitest.config.ts` 的 `testTimeout` / retry 策略（retry 已在 #106 退役）；不改其他测试文件。

**判据取向**：修复落在测试侧。骨架是 P57 S3-R8 明文契约的合法加载态（产品行为无缺陷），有缺陷的是测试里「1s 内解析必落地」这一对运行环境负载的隐含假设。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/chat/__tests__/issue55.rowSetPurity.solid.test.tsx` | 判据助手区段（新增 `parseSkeletons` / `rowElements` / `MARKDOWN_PARSE_TIMEOUT_MS` / `waitForMarkdownParsed`）+ 三处用例的等待点 + 文件末尾新增 1 条回归用例 | 修改 |

## 方案要点

**根因**：`emptyBlockSignature()`（`textContent` 为空即空块）与 `blankBlocks()`（`trim()` 后为空即空白块）都直接把解析骨架 `DIV.term-md-skeleton` 命中——该元素没有文本、没有行内容。于是 `:207` 那条 `waitFor(emptyBlockSignature == [])` 同时承担了两件事：**等异步解析落地**（时间相关）与**断言无空块**（不变量相关）。`waitFor` 默认超时 1000ms（`@testing-library/dom` 的 `asyncUtilTimeout`），而并发负载下落地会越过它——断言就落在「解析还在进行」的中间态上。

**修法**（把两件事拆开）：

1. `rowElements(container)` = `container.children` 去掉骨架，作为「什么算行内容」的唯一定义；`blockTexts` / `emptyBlockSignature` / `blankBlocks` 一律从它派生 ⇒ 缺陷判据与解析进度解耦（含 `:220` 的 `blankBlocks`，否则同类误判只会在下一个等待点复现）。
2. `blockSignature()` **不**豁免骨架：它比两次快照的 DOM 形状，基线在落地后取，任一侧还在解析都应当判为不同 ⇒「签名相等」蕴含「已落地」，被蕴含的冗余等待直接删除。
3. `waitForMarkdownParsed(container)` + `MARKDOWN_PARSE_TIMEOUT_MS = 10_000`：显式表达「等落地」，预算取 10s（与 `MarkdownContent.solid.test.tsx` 既有异步解析等待同档，对实测最差值 1547ms 有 6 倍余量）。落地后 `emptyBlockSignature` 由等待降为即时断言。
4. 新增回归用例不依赖负载：`createResource` 的 fetch 最早在微任务后 resolve，故 `render()` 返回后的**同一次 tick** 里骨架必然在 DOM 中——此时断言 `parseSkeletons` 非空、两条缺陷判据为空、落地后仍为空。这条锁住的正是「加载态 ≠ 空块缺陷」这一契约。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| A1 该文件全绿 | ✅ 6 passed |
| A2 判据豁免可判定（pending 时两条判据为空且骨架在 DOM） | ✅ 新增用例锁定；判据回退的变异版本必红 |
| A3 全量跑连续 3 轮全绿、无 retry | ✅ 三轮均 `Test Files 572 passed` / `Tests 3817 passed`，EXIT=0 |
| A4 不变式零削弱 | ✅ `blockSignature` 仍逐块比对原始 DOM（含文本）；块数 ≤ 段落数、无空块、无空白块、直排文本行无结构前导空行四条断言全部保留 |
| A5 tsc / lint | ✅ `tsc -p tsconfig.solid.json --noEmit` 退出 0；eslint 该文件无输出 |

## 测试处置

- 新增：`issue 141: 解析中的骨架不是空块缺陷 > 解析 pending 时「无空块 / 无空白块」判据为空，落地后仍为空`（1 条，确定性）。
- 修改等待点（断言语义无放宽，逐个点名）：
  1. `回退 / 换挡 / 终态重发之后，行集合等于对同一文本的直接推导`：基线前等待改为 `waitForMarkdownParsed`；签名相等等待加预算；末尾的空块等待降为即时断言。
  2. `终态后重复发布同一文本不再新增块（幂等）`：签名相等等待加预算。
  3. `55 段规模 + token 级切片…`：「最后一段可见 + 骨架消失」合并为一个预算内等待，删除被相等性蕴含的冗余等待；末尾四条不变式断言原样保留。
- 未删除任何断言；`blockTexts` / `edgeWhitespaceBlocks` / `plainRowsWithLeadingBlankLine` 语义不变（仅 `blockTexts` 的取元素范围随 `rowElements` 排除骨架）。

## 证据

**机理实测**（探针文件不入库；把该用例的等待点复制成探针，测「喂完全部 token 切片 → 骨架全部消失」）：

| 条件 | 落地耗时 |
| --- | --- |
| 单跑 | 164 ms |
| 16 个 CPU 占用进程 | 251 ms |
| 与全量跑并发（4 次） | 573 / 620 / **1547** / 748 ms |

即并发下跨过 1s 默认阈值，与 issue 报告的「约 1/3 全量跑红」吻合；同期两次基线全量跑（`572 / 3816`）本次恰好全绿，说明复现靠负载而非固定序列。

**慢解析夹具（把解析延迟到 1.5s，模拟实测最差落地窗口；变体文件不入库）**：

| 变体 | 结果 |
| --- | --- |
| 原文件 + 慢解析 | ❌ `AssertionError: expected [ 'DIV.term-md-skeleton' ] to deeply equal []`（1.0s 处，与 issue 原文一致） |
| 修复后 + 慢解析 | ✅ 6 passed（第 4 用例 1687ms，在预算内落地） |
| 修复后但 `rowElements` 回退为不豁免骨架 + 慢解析 | ❌ 新增用例红（`expected [ 'DIV.term-md-skeleton' ] to deeply equal []`）⇒ 回归锁有判别性 |

**并发压测（issue 的原始条件）**：在一轮全量跑进行中，目标用例连续跑 8 次 → **8/8 退出码 0**（每次 `6 passed`）；同批全量跑 `572 passed / 3817 passed` 绿。修复前同样的并发会把落地耗时推过 1s 默认阈值（上表 1547ms 那次）。

**门禁**：

- `bun run build:example-plugin` → 成功
- `bun x vitest run src/renderers/solid-workbench/chat/__tests__/issue55.rowSetPurity.solid.test.tsx` → `6 passed`
- `bun run test` × 3 → `572 passed (572)` / `3817 passed (3817)`，`EXIT=0`（基线 3816 + 新增 1 条）
- `./node_modules/.bin/tsc -p tsconfig.solid.json --noEmit` → 退出 0
- `bun x eslint <该文件>` → 无输出

## 与 spec 的偏差

无。spec 的五条方案与验收标准全部落地；第 6 条（合并两个等待以控制最坏耗时）实际按「合并 + 删除被蕴含的冗余等待」执行。

## 未解问题

无。遗留观察已单独立案调查并收敛（**登记为 #148**，调查记录 `.agents/records/issue-148-tail-parse-cost.md`）：增长尾块以 `{ cache: false }` 绕 LRU 的重复解析，在**生产帧节奏下并不产生浪费**（60Hz 两组实测 0 次结果过期；纯解析 0.2–7.3ms 远快于 16.7ms 帧间隔），真正的成本形态是「每帧重解析整个尾块」，热点在长单块（数千字单块 ~7ms/帧）；本记录早先「浪费的解析会拉长落地时间」的说法只在**同步突发**（测试的 token 级切片是最极端形态，92% 解析结果落地即过期）下成立——那也正是本 issue 偶发红的机制。是否施工由 #148 裁决，本 issue 不需要它。

## 并行交集

- 本次只碰 `src/renderers/solid-workbench/chat/__tests__/issue55.rowSetPurity.solid.test.tsx` 与 `.agents/`（本记录 + `L.md` 声明条目）。
- 未触碰 `src/renderers/solid-workbench/input/**`、`tools/webview2-mcp/**`、`src-tauri/**`，也未连带提交工作区里的任何其他改动。
- 基线时 `.agents/L.md` 上 #110（Huygens）声明其文件域含 `src/renderers/solid-workbench/chat/content/SessionSurfaceCard.solid.tsx` 与 `src/infrastructure/**` 等——与本文件无交集。
