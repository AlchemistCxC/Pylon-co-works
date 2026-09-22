# Dev Record — #234 投影批量折叠的超线性（部分闭合：消除三处 Θ(N²)，未全部线性化）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/234（bug；assignee AlchemistCxC，用户当轮指定开工）
- 分支：`Ru5t/Reflector`
- 提交范围：`649e477d`（L.md 开工声明）→ `ec745fb4`
- 日期：2026-09-22
- 上游：issue #233 的产品路径基准（`projector` 域）测出；机制定位见 #234 正文
- 关联：#205（投影线性化的前一轮，未解问题 ①/③）、#226

## 目标与范围

**做**：消除 `projectWorkbench`（批量冷重放折叠）在 tool / 诊断密集 journal 上的**主要**超线性来源，
用 CPU profile 定位而不是猜。

**不做（本轮明确划界）**：把「草稿所有权」扩到**全部**文档切片。剩下的 `activities.find` /
`upsertActivity` / `diagnostics` 展开 / `messages.slice` 同样是「每事件 O(数组)」，要全部线性化
需要改归约器一大片函数签名——见「未解问题」，本轮不硬上。

**一句话结论**：**#234 未闭合**。三处主要 Θ(N²) 已消除（tool-same 与 delta 已线性），
但 tool-unique / diagnostic / mixed 仍超线性。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/workbenchProjector.ts` | ① `ProjectionContext.draft` + 批量路径置位；② timeline 派生索引「尾条补丁不整表重扫」；③ `updateTimeline` draft 原地替换尾条；④ orphan id 集合尾部增量补齐；⑤ `refreshOrphans` 先探测后分配；⑥ `reduceTool` 透传 context | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/issue55.streamingContainers.solid.test.tsx` | #237（同一提交内的另一件事，见该记录） | 修改 |

**未触碰**：`reduceWorkbenchEvent`（live 单事件路径）的语义与形状；`projectWorkbench` 之外的任何入口；
`src/__tests__/replay/**` 的判据。

## 方案要点（全部由 profile 定位，不是猜）

CPU profile（12,000 张工具卡 = 36,000 事件，`bun --cpu-prof`）当时的自身耗时占比：

| 项 | 占比 | 处置 |
| --- | --- | --- |
| `new Set(activities.map(...))`（orphan id 集合每事件重建） | **47.9%** | ④ 按尾部增量补齐（见下「不变式」） |
| `activities.map(...)`（`refreshOrphans` 的无条件 map） | **21.8%** | ⑤ 先探测（只读一个字段、不分配）后分配 |
| `reduceTool` 自身 | 12.5% | 未动（每事件常数项） |
| `updateTimeline` 的整表 `.map` | （未单列，但为 tool-same 的主项） | ③ draft 原地替换尾条 |

三处改动的**正确性论证**（都要能说清，因为这是中央模块）：

1. **尾条补丁不重扫索引**：`updateTimeline` 按 `eventId` 打补丁，而带本轮 eventId 的条目**恒是
   本轮刚 push 的那条**（`timelineEntry` 用本轮 envelope 的 eventId 建条目；非 span 信封由
   `applied` 去重，不会出现第二条同 eventId 的条目）。它**尚未进索引**——`indexedEntries` 只覆盖
   到它的前一条。三个索引读的是 `kind` / `streamBoundary` / `data.*`，补丁里唯一能翻转谓词的是
   tool 的 `streamBoundary=false→true`，被翻转的正是那条尚未索引的尾条。故前缀索引仍然成立。
   判据写成 O(1) 的两条：长度不变 **且** 尾条 eventId == 本轮 eventId；否则退回整表重建。
2. **draft 原地替换尾条**：批量路径下 `document.timeline` 就是它自己独占的工作数组（入口复制过一次，
   中间文档一律丢弃），尾条对象本轮新建、不与任何已发布文档共享，故原地换掉它是安全的。
   live 路径不传 `draft`，`updateTimeline` 走原 `.map` 分支，一字不变。
3. **orphan id 集合增量补齐**：不变式 = `orphanIds` 恰是 `orphanActivities` 前 `orphanIds.size` 个
   元素的 id 集合，**且 activities 只在尾部增长**。该不变式由两个生产者保证：`upsertActivity`
   新增节点追加在末尾、按 id 命中时原位替换（id 与位置不变）；`refreshOrphans` 保序保长。
   长度回退时退回整集合重建（防御，非热路径）。

## 验收标准与结果

#234 原本写的判据是「tool-only / diagnostic-only 行源的每事件成本随 N 恒定」。**该判据本轮未达成**，
结果如实分档（本机 20 核，`bun` 直跑，3 轮取中位；同一探针形状前后对比）：

| 行源 | 规模 | 改前 | 改后 | 每事件成本 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **tool-same**（同一卡上多事件） | 12,000 事件 | 1152.7ms | **28.3ms** | 2.15–2.36µs，**随 N 恒定** | ✅ **已线性**（36×） |
| **delta-only** | 24,000 事件 | 164.5ms | 164.5ms | 4.07–5.77µs，恒定 | ✅ 本就线性（未回退） |
| **tool-unique**（每卡新 id） | 12,000 事件 | 2732.7ms | 512.9ms | 11.2 → 42.7µs，**随 N 上升** | ⚠️ 改善 5.3×，**仍超线性** |
| **diagnostic-only** | 4,000 事件 | 138.3ms | 124.7ms | 3.2 → 31.2µs，**随 N 上升** | ⚠️ 基本持平，**仍超线性** |
| **mixed**（生产形状，bench m 档） | 2,251 事件 | 124ms | **41.6ms** | 55.1 → 18.5µs | ⚠️ 改善 3.0× |
| **mixed**（bench l 档） | 22,501 事件 | 10,200ms | **2,154ms** | 453 → 95.7µs | ⚠️ 改善 4.7×，**仍超线性** |

> 读数的可信边界：探针逐次运行的绝对耗时抖动可达 ~1.8×（同形状两次跑出 1482.9ms 与 2732.7ms），
> 所以上表的**倍数**只当量级看；**「随 N 恒定 / 随 N 上升」这个方向**在多轮里稳定，是可以当依据的那一半。
> bench 档（`PERF_SCALE` + 5 轮中位）比临时探针稳定，以它为准。

## 测试处置

- 新增测试：**无**（本轮不加新契约）。
- 修改/删除既有行为测试：**无**。
- 回归证据：全量 `npx vitest run` → **623 文件 / 4678 用例通过，0 失败**（含 `src/__tests__/replay/**`
  的不变量、粒度无关性、跨层组合、绝对 oracle、真机 fixture，以及 `src/domains/workbench` 全套）。
  另 `tsc -b` exit 0、`eslint src/` 0 error。

## 证据

- profile：`bun --cpu-prof`（12,000 卡 / 36,000 事件）→ 上表分工占比；改后 profile 的首项变成
  `refreshOrphans`（22.2%）与 `.map`（29.8%）。
- 逐档曲线：tool-same / tool-unique / diag / delta 四组各 3 档 × 3 轮中位（一次性 scratch 探针，未入库）。
- bench：`PERF_SCALE=m bun scripts/perf-bench.mts` 的 `projector` 域（`mixed-m` 41.60ms / 18.48µs 每事件）；
  l 档用 `mixedJournal(2000)` 单独探针（2222 行读数见上表）。
- 提交：`ec745fb4`。

## 未解问题（#234 的剩余部分，已定好指向）

1. **`activities` 仍是每事件 O(A)**：`document.activities.find(...)`（选上一节点）、`upsertActivity` 的
   `findIndex` + `map`、`refreshOrphans` 的探测扫描，共约 3 次 O(A) 遍历/事件。要线性化需要：
   ① draft 模式独占 activities 数组（入口复制一次）+ `Map<id, node>` 查表；
   ② `upsertActivity` 原地替换/追加；
   ③ orphan 改为**单写者**——节点创建/更新时就地算 `orphan`，只在「新 id 到达」时用反向索引
   `Map<parentId, childIds>` 翻转受影响节点（反向索引更新是 O(1)，全折叠摊还 O(引用数)）。
   这要求把 `context` 透传进 `reduceActivity`。
2. **`diagnostics` 每事件整表展开**：`[...document.diagnostics, diagnostic]` 是 O(D)；同时
   `addDiagnostic` 里的 `updateTimeline` 也还没走 draft（它没有 context）。要修需把 `context` 透传进
   `addDiagnostic` 的 6 个外层函数（`reduceUsage` / `reducePlan` / `reduceGoal` / `reduceDiagnostic` /
   `addLateEventDiagnostic` / `addOutOfOrderDiagnostic`）。
   **注意**：#205 记载「生产库无 unknown 行」⇒ 诊断行在生产 journal 里不出现，此项是理论性隐患而非线上问题。
3. **`messages` / `interactions` / `extensions` 同类**：`[...messages.slice(0,-1), x]` O(M)/事件、
   `settleSupersededRunningMessages` 的 `messages.some(...)` O(M)/新卡（profile 7.1%）。
   这些在「消息数很多」的会话里也会退化。
4. **live 单事件路径**（`reduceWorkbenchEvent`）的同类成本**不在本轮范围**：#205 未解问题 ① 把它
   归给 #204（每帧 `insertBySequence` 复制整条 timeline + 无索引时整条扫描）。本轮只动批量路径。
5. **是否继续做**：1–3 合起来是把「草稿所有权」扩到全部切片，属**一次成型的重构**（改归约器一大片
   函数签名与 5–6 个数组的写入方式），建议单开一条 issue 并先裁决范围，而不是在本轮继续加。

## 并行交集

- `src/domains/workbench/workbenchProjector.ts`（**本轮唯一的产品代码改动**，单一文件）。
- `src/renderers/solid-workbench/chat/__tests__/issue55.streamingContainers.solid.test.tsx`（#237，测试侧）。
- 未触碰：`src/sheets/agent-workbench/**`、`src/domains/events/**`、`src/__tests__/replay/**`、
  `vitest.config.ts`、`scripts/perf-bench/**`（投影域的 case 定义未改，新增探针均一次性且已删）。
