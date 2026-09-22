# Dev Record — #233 性能基准改产品路径口径（废除 wasm↔TS 对照跑器）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/233（refactor；assignee AlchemistCxC）
- 分支：`Ru5t/Reflector`
- 提交范围：`2c1c2c3f`（L.md 开工声明）→ 本轮提交
- 日期：2026-09-22
- ADR：[`0019`](../decisions/0019-perf-benchmark-product-path-cost.md)（本轮的路线决策）
- 关联：ADR-0018 修订 1、#220（被本轮换个口径重新覆盖的测量装置）；新开 [#234](https://github.com/AlchemistCxC/Pylon-co-works/issues/234)（本轮测出的超线性）

## 目标与范围

用户原话：

> 1.调查下现有的存量性能benchmark 2.寻找可能的性能开销点并将它们整合进benchmark 3.废除旧有的wasm和ts对比的benchmark（可与借鉴其中存量的测试（借鉴已接线的，没接线的不用了） 4.别开子agent

**做**：查清存量基准的形状 → 废除 wasm↔TS 对照跑器 → 新建产品路径绝对成本基准，
把六条**已接线**热路径纳入（含此前 benchmark 面归零的 markdown/高亮/投影/events）。

**不做**：不改任何 `src/` 与 `src-tauri/` 代码；不动 parity 门禁；不把基准接进 CI；
不做 DOM/渲染层基准（那要真实 WebView2，属 `webview2-acceptance` 的实机验收面）；
不借 `baselines/**`（「没接线」的那一半）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/perf-bench.mts` | 入口：装载计算核、跑全套、打印表 + 分域小结 + 帧预算参考 + 脚注 + 排除清单 + 线性内存前后 | 新增 |
| `scripts/perf-bench/harness.ts` | PerfCase/PerfPair/PerfSuite 类型、计时跑器（预热 1 轮 + R 轮中位、首调用兼线性内存探针）、表格与小结格式化、单位成本门槛、帧预算参考 | 新增 |
| `scripts/perf-bench/index.ts` | 六域注册表 + `EXCLUDED_WASM_EXITS`（被排除的出口与理由） | 新增 |
| `scripts/perf-bench/suites/streamingSuite.ts` | 切分/揭示：复用 parity 套件 case 定义，`WIRED_PAIRS` 白名单挑已接线 pair；新增长围栏/列表毒化 case | 新增 |
| `scripts/perf-bench/suites/markdownParseSuite.ts` | markdown 解析：形状语料放大到 ~4k + 规模档 + 生产流式短尾 + 逐帧增长 | 新增 |
| `scripts/perf-bench/suites/markdownHighlightSuite.ts` | 高亮：语言语料 + 巨块档 + 语言资产注册隔离行 | 新增 |
| `scripts/perf-bench/suites/projectorSuite.ts` | 投影折叠：delta 流 / 混合流 / 乱序覆盖 | 新增 |
| `scripts/perf-bench/suites/eventsSuite.ts` | 单帧归一：delta 流 / 完整回合 / 真机捕获载荷 / 畸形 | 新增 |
| `scripts/perf-bench/fixtures/envelopes.ts` | projector 的 envelope 生成器（出处 `fa4aab5d^:scripts/compute-parity/fixtures/envelopes.ts`） | 新增（从 git 历史恢复） |
| `scripts/perf-bench/fixtures/eventWires.ts` | events 的 wire 构造（形状抄自 `src/__tests__/replay/harness.ts` 的 `raw*()`）+ 真机捕获 JSON | 新增 |
| `scripts/perf-bench/README.md` | 跑法、读表口径、六域接线点表、借用清单、形状陷阱 | 新增 |
| `scripts/compute-parity-bench.mts` | 双实现速度对照跑器 | **删除** |
| `scripts/compute-parity-memory.mts` | 双实现内存对照跑器 | **删除** |
| `scripts/compute-parity/harness.ts` | 删掉「性能跑器」「内存跑器」两节；parity 跑器一字未动；头注改写 | 修改 |
| `scripts/compute-parity/README.md` | 改标「parity 门禁脚手架」；性能/内存段改指向新基准；结构表与结尾节改写 | 修改 |
| `scripts/compute-parity/index.ts`、`scripts/compute-parity.test.mts` | 头注里指向旧跑器的那句改为指向新基准 | 修改 |
| `.agents/decisions/0019-perf-benchmark-product-path-cost.md` | 本轮路线决策 | 新增 |
| `docs/说明书/Pylon-模块维护地图.md` | 「前端计算核」行末的对照指针改为「等价性 → compute-parity；性能 → perf-bench」 | 修改 |
| `.agents/L.md` | 开工声明 | 修改（已单独提交 `2c1c2c3f`） |

## 方案要点

1. **一个 case = 一条已接线的生产路径 + 一份输入**（`PerfCase.run`），没有第二实现。
   于是「想量一个开销点」不再需要先造 TS 基线——投影与 events 这两面因此才量得了（它们的实现本来就在 TS 里）。
2. **入册判据是接线点，不是 wasm 出口身份**：每 pair 强制 `wiredAt` 的 `file:line`；
   没接线的 7 个出口进 `EXCLUDED_WASM_EXITS` 连理由一起**打印出来**——排除是结论，得能被人核。
3. **借存量资产按「已接线才借」**：切分/揭示**直接复用 parity 套件的 case 定义**（`pair.wasm` 就是生产出口，
   语料只有一份）；markdown 的「生产流式形状」构造与 projector 的 envelope 生成器从 git 历史恢复；
   `baselines/**` 一律不借。
4. **单位成本设工作量门槛（≥32）**：低于该量级时一次调用的固定开销（过界 + 编组，5–30µs）主导读数。
   这条是刻意的自我约束——旧跑器正是在 xs 档把这种噪声当比值印出来（见「调查结论」）。
5. **首调用兼线性内存探针**：线性高水位只涨不跌，「本 case 让核永久长高多少」只能由一次调用给出；
   放在预热之后量会读成 0。
6. **基准不进 CI**：它是测量工具不是判据；绝对耗时随机器与并发变，阈值化必然 flake。

## 调查结论（第 1 条：存量基准是什么形状）

| 路径 | 结论 |
| --- | --- |
| `scripts/compute-parity-bench.mts` | 双实现对照、输出 `wasm/ts` 比值 → **废除** |
| `scripts/compute-parity-memory.mts` | 同形状的内存对照 → **废除** |
| `scripts/compute-parity.test.mts` | parity 门禁（覆盖门 + 逐字节比对）→ **保留**（是门禁不是 benchmark） |

实测到的三处病灶：

1. **被测物错位**：`ts` 侧是 `baselines/` 的冻结/雕刻基线，头注自陈「不在任何生产路径，不 import 进 `src`」。
2. **小输入比值是噪声**：xs 档 corpus case 两侧都读作 `0.00ms`，比值落成 `corpus-5 = 13.83` /
   `corpus-15 = 8.11` / `corpus-19 = 5.50` 这类量化误差；同一批 case 在 1 轮与 3 轮之间方向会翻
   （该轮 `streaming-budget` 域汇总读到 0 快 / 8 慢，与记录 220 的 8 快 / 1 慢相反）。
3. **跑法依赖不成立**：注释与 README 写「**必须 vite-node**」，但 `vite-node` 不在 `package.json`
   依赖里（`node_modules/vite-node` 实测不存在）——照文档跑等于 `npx` 网络拉包；
   实测 `bun scripts/compute-parity-bench.mts` 直接跑通。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bun scripts/perf-bench.mts` 退出 0、六域表、每行有 ms中位/单位成本/核线性Δ | ✅ 退出 0，64 case，六域齐全 |
| 表里不出现没接线的 7 个 wasm 导出 | ✅ 路径列里没有 `splitStreamingMarkdown` / `splitStreamingMarkdownBlocks` / `findLastStableBlockBoundary` / `scopeForLanguage` / `parseMarkdownJson` / `highlightBlockJson` / `markdownEngineVersion`（`grep` 核过：出现的 `splitStreamingMarkdownBlockEnds` 是**已接线**的 ends 出口）；表尾印出七条的排除理由 |
| 无网络、未安装 vite-node 的树上可跑 | ✅ 两次全跑均无网络访问；`node_modules/vite-node` 不存在 |
| parity 门禁仍绿且断言计数不变 | ✅ **126 项：ok 125 / known-diff 1 / mismatch 0**（与记录 220 同数） |
| `tsc -b` 退出 0 | ✅ 退出 0 |
| `lint` 0 error | ✅ 0 error / 1 warning（`RightRailHost.tsx:39` 既存，非本轮） |
| `check:bundle`、`check:docs` 通过 | ✅ 均退出 0（bundle 全 PASS；docs 链接 4 项通过） |
| `PERF_SCALE` 三档可跑 | ✅ `xs` 25 case / 默认 `m` 64 case / `full` 73 case，均退出 0 |

## 本轮测出的开销点读数（默认 m 档，每 case 5 轮中位；本机 20 核 Windows，Node 26 / Bun 1.4）

| 域 | 代表 case | 中位 | 单位成本 |
| --- | --- | --- | --- |
| streaming-split | `splitStreamingMarkdownBlockEnds · blocks-m`（27k 字符） | 0.290ms | 0.011µs/字符 |
| streaming-split | `splitStreamingMarkdownBlockEnds · list-block-m`（8k，列表毒化） | 0.004ms | 0.6ns/字符 |
| streaming-split | `splitOpenCodeFenceTail · fence-body-m`（96k） | 0.380ms | 4.0ns/字符 |
| streaming-reveal | `StreamingRevealEngine(replay) · burst-drain`（40 拍） | 0.356ms | 8.90µs/拍（帧预算 0.05%） |
| streaming-reveal | `StreamingRevealEngine(replay) · smooth-m`（400 拍） | 2.43ms | 6.07µs/拍 |
| markdown-parse | `parseMarkdown · doc-m`（63.6k 字符） | 5.79ms | 0.091µs/字符 |
| markdown-parse | `parseMarkdown(unstable-tail) · tail-1280` | 0.018ms | 0.014µs/字符 |
| markdown-parse | `parseMarkdown(unstable-tail) · tail-80` | 0.004ms | 0.049µs/字符 |
| markdown-highlight | `highlightBlock · block-40k`（40k 字符） | 903ms | 22.57µs/字符 |
| markdown-highlight | `highlightBlock · block-4k`（4k 字符） | 99.6ms | 24.90µs/字符 |
| projector | `projectWorkbench(fold) · delta-m`（2,001 事件） | 11.2ms | 5.61µs/事件 |
| projector | `projectWorkbench(fold) · mixed-m`（2,251 事件） | 124ms | 55.06µs/事件 |
| events | `normalizeRawEvent · delta-run-m`（5,000 事件） | 3.94ms | 0.788µs/事件 |
| events | `normalizeRawEvent · captured-real`（450 事件） | 0.333ms | 0.740µs/事件 |

三条读出来的结论（都写进了表内脚注或 README）：

1. **同一形状（纯散文短尾）的单位成本随输入增大而降**：`tail-80` 0.049µs/字符 → `tail-320` 0.022
   → `tail-1280` 0.014。绝对耗时随字符数**次线性**增长（80 → 1280 字符是 16×，耗时 0.004 → 0.018ms 是 4.5×），
   即每帧固定开销（过界 + 编组）在小尾块上占大头。**跨形状不能这样读**：`doc-m` 是 0.091µs/字符，
   比 `tail-1280` 高一个量级——它每块都带标题/围栏/列表结构，与纯散文不是同一形状。
   ⇒「短尾便宜」要按「每次调用的固定开销」讲，不能按「每字符」讲。
2. **切分成本 ∝ 稳定块数，不 ∝ 字符数**：`blocks-m` 11ns/字符 vs `list-block-m` 0.6ns/字符，
   后者便宜正因为它几乎不产出稳定块。
3. **列表/引用会毒化其后的稳定块**（见「顺带发现」）——这条把第 2 条从「有趣」变成「有后果」。

## 顺带发现（新开 #234；旧跑器看不见的那一类）

建基准时按「混合形状」拼语料，发现拼出来的文档只有 4 个稳定块，遂隔离探针定位到：

**列表/引用块之后的块永不稳定。** 本机实测：

| 输入 | 稳定块数 |
| --- | --- |
| `段落A\n\n段落B\n\n段落C` | 2（A、B 稳定，C 是尾块） |
| `段落A\n\n- 项1\n\n段落B` | **1**（只有 A） |
| `段落A\n\n> 引用\n\n段落B` | **1**（只有 A） |
| `- 项1\n- 项2\n\n新段落开始\n\n` | **0** |

⇒ 生产里消息一旦含列表或引用，**其后全部内容**每拍都在不稳定尾块里被重新解析/重渲。
这是 #208 观察到的「同一批内容被反复解析约一个数量级」的机制之一，故 `streaming-split` 单列了
`list-block-*` 成本行（切分扫描本身很便宜，代价在下游）。

另外，`projector` 域把一条**已记录但未被量化**的残留变成了数字：`projectWorkbench` 在
`tool.*` / `diagnostic.*` 密集 journal 上**超线性**（delta-only 每事件成本恒定 5.8–7.2µs；
tool-only 18.73 → 1024.12µs/事件、24k 事件单次折叠 24.6 秒）。#205 的线性化结论是在
**delta 行源**上验的，而其设计前提「tool/activity/诊断是低频事件」在工具密集会话里不成立。
已开 **#234** 承接（含机制定位 `workbenchProjector.ts:466-467` 与 #205 未解问题 ③ 的关系），
**本轮不修**（涉及是否动 `workbenchProjector` 的裁决）。

这条同时是废除旧跑器的额外论据：`wasm/ts` 比值对超线性**结构性失明**——两侧同步变慢时比值恒定。

## 测试处置

- 新增测试：**无**。基准不是门禁，无契约可钉（本仓先例：`.agents/skills/code-stats` 的
  `code-stats.test.mts` 是「脚本自身被测」，而基准脚本没有可断言的输出契约；接进 CI 又会撞
  机器差异 flake）。
- 修改/删除既有行为测试：**无**。
- 删除的非测试文件：`scripts/compute-parity-bench.mts`、`scripts/compute-parity-memory.mts`
  （实测全仓引用仅 README 与跑器自身，已一并改）。

## 证据

- 提交：本轮提交（见 PR）。
- 门禁：
  - `npx vitest run scripts/compute-parity.test.mts` → 1 文件 / 2 用例通过；
    另用一次性脚本读 `summarizeParity` → **`parity 断言 126 项：ok 125 / known-diff 1 / mismatch 0`**
    （脚本已删，读数与记录 220 逐字一致）。
  - `./node_modules/.bin/tsc -b` → exit 0。
  - `npx eslint src/` → 0 error / 1 warning（`RightRailHost.tsx:39`，既存）。
  - `bun run check:docs` → exit 0（文档链接 4 项通过）。
  - `bun scripts/check-bundle-size.mjs` → 全部 PASS。
- 基准三档：`PERF_SCALE=xs` 25 case / 默认 `m` 64 case / `PERF_SCALE=full` 73 case，均 exit 0。
- 手工验证：表内数字为真机实跑；`projector` 超线性用一次性 scratch 探针做形状隔离
  （delta-only / diagnostic-only / tool-only 三组各四档），读数为上文「顺带发现」那张表；
  探针不入库（形状已在 #234 里写全）。

## 与 spec 的偏差

1. spec 写「域 = 5 个」，实际 6 个：增了 `events`（`normalizeRawEvent`）。
   理由：它是**每帧每事件**都过的路径、接线点明确（`canonicalNormalizer.ts:196`），
   且输入面能直接复用 `src/__tests__/replay/harness.ts` 的 wire 形状与两份真机捕获载荷——
   符合「已接线就借」。ADR-0019 的读数为证：0.74–1.50µs/事件。
2. spec 的「借 markdown 形状语料」原计划原样沿用 20–60 字符的 `MARKDOWN_SHAPE_CORPUS`；
   实现改为**放大到 ~4k 字符**。理由：原样那批量级读到的是一次调用的固定开销，
   单位成本会算出 `13.41µs/字符` 这类噪声——正是本 issue 要废除的形状，不能在新装置里重犯。
   逐条契约形状仍由 parity 门禁负责。
3. spec 未写、实际做了：`EXCLUDED_WASM_EXITS` 排除清单（连理由打印）——「没接线的不用了」
   这个结论需要可核，不能只体现在表里没有。
4. spec 的「未决问题 3」（graft 路径未单列）保留为未解，见下。

## 未解问题

1. **graft 命中路径没有单列 case**：`markdownRenderModel` 的增量 graft 有模块级基座
   （`graftBases`）与 LRU，多次采样读到的是热态，且没有只读 reset 出口（加 reset 属改产品代码，
   超出本 issue「零 src 改动」的边界）。当前由 `markdown-parse(growing-tail)` 量「整段重解析」
   那一半；graft 那一半要量得先裁决是否允许为基准加只读 reset 出口。
2. **DOM/渲染层开销点未覆盖**：高亮 DOM 生命周期（#221 的视口降级/帧预算调度）、行测量、
   滚动跟随、`content-visibility` 这些只在真实 WebView2 里量得到。落点是
   `.agents/skills/webview2-acceptance` 的实机验收，不是 node 基准。
3. **基准不接 CI，所以没有趋势**：绝对耗时随机器变，无历史承接点时只能给阈值 ⇒ 必 flake。
   要有趋势得先定 artifact 落点（存哪、与哪条基线比）。
4. **`projector` 超线性已开 #234 但未修**（需先裁决是否动 `workbenchProjector`）。
5. **`streaming-split` 的 `list-block-*` 成本行读起来「更快」**：单位成本低是因为它几乎不产出稳定块，
   不是更优。README 已写明「别把便宜当更优」，但这一列本身仍有被误读的空间。
6. **7 个未接线 wasm 导出是否退役**：三个旧切分出口、wasm 的 `scopeForLanguage`、两个 `*Json` 编组变体、
   `markdownEngineVersion`——它们在 `src/`（含测试）里都没有调用方，等于白付 wasm 体积与维护面。
   退役会**同时缩小 parity 覆盖门与计算核产物**（`pylon-compute` 现 120,581 B raw；
   `pylon-markdown` 2,873,113 B raw，其中 `*Json` 是整条 serde 编组路径）。
   本轮**只登记不处置**：体积收益没有实测，且退役属改计算核与 parity 契约面，得先裁决。
   注意 `splitStreamingMarkdown*` 与 `findLastStableBlockBoundary` 是 parity 门禁的对照物，
   退役要先解决「覆盖门拿什么当对照」。

## 并行交集

本轮碰过的共享文件（供其他贡献者避让）：

- `scripts/compute-parity/harness.ts`（仅删两节 + 头注；parity 跑器与类型未动）
- `scripts/compute-parity/README.md`、`scripts/compute-parity/index.ts`、`scripts/compute-parity.test.mts`（仅注释/文档）
- `docs/说明书/Pylon-模块维护地图.md`（仅「前端计算核」行末的对照指针）
- `.agents/L.md`（已单独提交 `2c1c2c3f`）
- `scripts/` 下的新增与删除（`perf-bench*`）
- 未触碰：`src/**`（零产品代码改动）、`src-tauri/**`、`scripts/compute-parity/{suites,baselines,fixtures,vitest.config.ts}`、`vitest.config.ts`、`package.json`。
