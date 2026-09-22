# ADR-0019 性能基准改产品路径绝对成本口径

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0019-perf-benchmark-product-path-cost.md`

- **日期**：2026-09-22
- **状态**：已采用（用户当轮下达：「废除旧有的 wasm 和 ts 对比的 benchmark」「寻找可能的性能开销点并将它们整合进 benchmark」）
- **议题**：issue #233；推翻的是 ADR-0018 修订 1 与 #220 所依赖的**测量装置口径**（不是它们的选型结论）

## 背景与约束

ADR-0018 修订 1 的判决建立在 `scripts/compute-parity-bench.mts` / `-memory.mts` 的读数上
（「markdown 流式形 12–25×」「流式切分大输入 2–3×」「揭示预算 burst 档 0.6–0.9×」「投影 4.4–6.1× 内存」）。
这两个跑器是**双实现对照**：每个 case 跑 `pair.ts` 与 `pair.wasm` 两侧，输出 `wasm/ts` 比值。

三条约束把它的适用边界压得很窄：

1. **`ts` 侧不在生产路径。** `scripts/compute-parity/baselines/` 的冻结/雕刻基线，头注自陈
   「不在任何生产路径，不 import 进 `src`」。比值回答「两个实现谁快」，不回答「产品这条路径一次花多少」。
2. **比值对超线性不敏感。** 两侧同步变慢时比值保持恒定——实测 `projectWorkbench` 在 tool 密集
   journal 上每事件成本从 18.7µs 涨到 1024µs（#234），而任何 `wasm/ts` 比值都看不出这一路恶化。
3. **小输入上比值是纯噪声。** xs 档两侧都读作 `0.00ms`，实测比值出现 `13.83` / `8.11` 这类量化误差；
   同一批 case 在 1 轮与 3 轮之间方向会翻。

同时，ADR-0018 修订 1 之后 wasm 面收窄、markdown/projector/events 的对照套件删除，
**这四个真实开销点在 benchmark 面归零**：想量一个新开销点，得先给它配一份 TS 基线才算「合法 case」，
而投影与 events 的实现在 TS 里本来就没有第二份 ⇒ 结构上量不了。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| **保留对照跑器，只加产品路径 case** | 双实现是「合法 case」的前提，所以新开销点仍量不了；且噪声比值继续在表里。形状的病灶没动。 |
| **改成「比值 + 绝对耗时」双列** | 绝对耗时列会被读成「顺带」，比值仍是主列；且两侧都要跑，成本翻倍。多留一列不解决被测物错位。 |
| **给基准加硬阈值（超预算即红）** | 绝对耗时随机器与并发变（本机 20 核、CI 4 vCPU），共享 CI 上必然 flake。本仓已有 #175 一类并行抖动的前车之鉴。 |
| **把基准接进 CI 做趋势记录** | 需要承接趋势数据的落点（artifact 存储 + 基线对照），本轮不具备；无历史时 CI 只能给阈值，回到上一条。 |

## 决定

**性能基准 = 产品路径绝对成本。一个 case = 一条已接线的生产路径 + 一份输入，没有第二实现。**

1. **废除** `scripts/compute-parity-bench.mts` 与 `-memory.mts`，以及 `compute-parity/harness.ts`
   里的性能/内存跑器两节。`compute-parity.test.mts` 的 **parity 门禁**保留（判据是「等价」，
   它不是 benchmark；ADR-0018 修订 1 明确保留，markdown 快照锁同类）。
2. **新建** `scripts/perf-bench/`（入口 `bun scripts/perf-bench.mts`）。每行读数：
   `ms中位` / `ms最小` / `工作量` / `单位成本`（中位耗时 ÷ 工作量）/ `核线性Δ`。
3. **「已接线」是入册的唯一判据**，逐条给 `wiredAt` 的 `file:line` 证据。没接线的 wasm 出口
   （`splitStreamingMarkdown` / `splitStreamingMarkdownBlocks` / `findLastStableBlockBoundary` /
   `scopeForLanguage`）**显式列在排除清单里连理由一起打印**——排除是结论，得能被人核。
4. **存量资产按「已接线才借」收编**：切分/揭示的 case 定义与语料留在 `compute-parity/` 被两边共用；
   markdown/highlight 的语料与「生产流式形状」构造、projector 的 envelope 生成器从 git 历史恢复；
   `baselines/**` **一律不借**（那些正是「没接线」的那一半）。
5. **单位成本设工作量门槛**（< 32 不给）：低于该量级时「一次调用的固定开销」主导读数，
   算了也是噪声——这正是旧跑器印出噪声比值的那条路，显式收口而不是换个地方重犯。
6. **基准不进任何 CI 门禁**。它是测量工具，不是判据。
7. 跑法不依赖未声明的依赖：`bun` 直跑（旧注释的「必须 vite-node」是过期的——`vite-node`
   不在 `package.json` 里）。

## 后果

- **正面**：读数回答的是「产品这条路径一次花多少」，单位成本跨机器可比；新增开销点不必先造基线
  （投影/events 这类没有第二实现的面因此才量得了）；#234 那种超线性一眼可见（每事件成本随 N 涨）。
- **负面 / 代价**：失去「wasm 相对 TS 快多少」这一列。该问题在 ADR-0018 修订 1 已收敛为
  「同形状对照里真的赢」，且 `baselines/` 与 parity 门禁都还在 = 现成的恢复源；真要重测，
  写一个临时脚本即可，不必维护常驻跑器。
- **风险**：
  1. **绝对耗时随机器漂移** ⇒ 不以阈值判红，只作报告；跨机器比较看单位成本列。
  2. **基准与被测代码漂移**（生产出口改名/换接线点后 case 仍跑老路径）⇒ 每个 pair 强制 `wiredAt`，
     且排除清单同样登记；`src/` 里没有调用方的出口默认不进基准（白名单制，不是黑名单）。
  3. **可读性**：表变宽（多了工作量/单位成本/核线性Δ），且若干行会因为一次性资产注册而 Δ 偏大
     ⇒ README 与表头逐条说明口径，并把 ts 语法资产注册单列成 `engine-warmup` 行隔离。

## 证据

- 废除前的形状与噪声读数：`scripts/compute-parity/README.md`（本轮改写的前一版）、
  issue #233 正文与评论（`corpus-5 = 13.83` 等）。
- 新装置：`scripts/perf-bench.mts`、`scripts/perf-bench/harness.ts`（口径头注）、
  `scripts/perf-bench/index.ts`（`EXCLUDED_WASM_EXITS`）、`scripts/perf-bench/README.md`。
- 门禁未削弱：`npx vitest run scripts/compute-parity.test.mts` 绿，且 parity 断言计数
  **126 项：ok 125 / known-diff 1 / mismatch 0**（与 #220 记录的同一数字）。
- 超线性的可见性：#234 的读数表（tool-only 18.73 → 1024.12µs/事件）。
