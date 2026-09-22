# perf-bench · 产品路径性能基准

issue #233。**一个 case = 一条已接线的生产路径 + 一份输入**，读数就是这条路径的绝对成本——
没有第二实现，所以没有「比值」。

## 跑法

```bash
bun scripts/perf-bench.mts                    # 默认 m 档、每 case 5 轮取中位
PERF_SCALE=full bun scripts/perf-bench.mts    # 加 l 档极量级
PERF_ROUNDS=9 bun scripts/perf-bench.mts      # 更多采样轮
PERF_SCALE=xs bun scripts/perf-bench.mts      # 只跑最小档（快，但绝对 ms 只作参考）
PERF_SCALE=s bun scripts/perf-bench.mts
```

`bun` 直接跑，**不需要 vite-node**。（被废除的旧对照跑器注释里写「必须 vite-node」，
但那个包不在 `package.json` 依赖里，照它跑等于 `npx` 网络拉包——实测 `bun` 可直接跑通；
见 issue #233。）

## 怎么读这张表

| 列 | 口径 |
|---|---|
| `ms中位` | 每 case 预热 1 轮（JIT / wasm 装载 / 引擎首载不进样本）后，`PERF_ROUNDS` 轮取中位 |
| `ms最小` | 无干扰地板。与中位拉得开说明本轮采样被外部负载污染，这一行不可信 |
| `工作量` | 这次 run 处理的量纲总量（字符 / 拍 / 事件 / 块） |
| `单位成本` | `中位耗时 / 工作量`。**跨机器、跨输入规模只有这一列可比**。工作量低于门槛时报 `—`：低于门槛时「一次调用的固定开销」会主导读数，算出来的是噪声。门槛**按 pair 声明**（缺省 32）——wasm 出口的固定开销是「过界 + 一次编组」（5–30µs），而前端 Lezer 高亮实测 ~1.6ms/次（量级差 50 倍），故后者在 `markdownHighlightSuite.ts` 里自报 16000 字符 |
| `核线性Δ` | 本次 run 的**单次**调用把计算核 `WebAssembly.Memory` 高水位抬高多少字节。确定性、与 GC 无关。**只涨不跌** ⇒ 为 0 表示该 case 没有抬到新高水位，不是「不占内存」 |

两点**别读错**：

1. **这一列是计算核那一段，不是产品路径的全部。** 每个 pair 的 `wiredAt` 指向接线点，
   pair/case 的 `note`（表下方「脚注」）说明哪一截不在读数里——例如高亮不含
   `codeHighlight.ts` 的结果缓存与 #221 的视口降级/帧预算调度，markdown 解析不含
   `markdownRenderModel` 的 LRU 与 graft。
2. **#241 起高亮已不在 wasm**（迁到前端 Lezer），因此 `markdown-highlight` 全列的 `核线性Δ`
   **恒为 0**——这是设计结果，不是漏测。同理它也不再有「语法资产按语言懒注册」那种一次性大 Δ：
   那条曾把 `pylon-markdown` 的 tmLanguage（每语言数 MB–数十 MB）记在每种语言的首行上，
   随语法机器一并退役。现在 `engine-warmup` 那一行量的是 Lezer 引擎的**懒装载**（JS 侧堆内存，
   计算核看不见，所以 Δ 同样是 0）。

## 域与接线点

| 域 | 生产出口 | 接线点 |
|---|---|---|
| `streaming-split` | `splitStreamingMarkdownBlockEnds` / `splitOpenCodeFenceTail` | `src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx:85` / `:193` |
| `streaming-reveal` | `StreamingRevealEngine` | `src/renderers/solid-workbench/streamingDisplayScheduler.ts:4` |
| `markdown-parse` | `parseMarkdown` | `src/renderers/solid-workbench/chat/markdownRenderModel.ts:7,494` |
| `markdown-highlight` | `highlightBlockWithLezer`（Lezer，纯 JS；**不经 wasm**） | `src/components/chat/codeHighlight.ts:76` |
| `projector` | `projectWorkbench` | `src/domains/workbench/workbenchProjector.ts:444` |
| `events` | `normalizeRawEvent` | `src/domains/events/canonicalNormalizer.ts:196` |

**没接线的 not in the table.** 两个计算核的**当前**真实导出共 **9 个**（`pylon-compute` 6 + `pylon-markdown` 3，`initSync` 除外）：**接线 4 个**（正是上表里 4 个 wasm 路径），**未接线 5 个** —— 三个被 #220 ends 出口取代的旧切分出口、`parseMarkdownJson` 编组变体、`markdownEngineVersion` 诊断出口。

（另有两个出口已**离开导出面**，故不在此列：`scopeForLanguage` 按 #236 删除——生产走 `codeHighlight.ts` 的同名 TS 同步语言门，且实测逐次调用比 TS 表慢约 **18×**；`highlightBlock` / `highlightBlockJson` 按 #241 删除——高亮整体迁出 wasm 到前端 Lezer。**「不在导出面上」与「在但没接线」是两件事。**）

它们不进基准，但**连理由一起打印在表尾**（`index.ts` 的 `EXCLUDED_WASM_EXITS`）：**排除本身是结论，得能被人核。**
别只按 parity 脚手架的 `REQUIRED_EXPORTS` 数——那只是 `pylon-compute` 的一半，且不含 `pylon-markdown`。

## 结构

| 路径 | 职责 |
|---|---|
| `../perf-bench.mts` | 入口：装载计算核、跑全套、打印表 + 分域小结 + 帧预算参考 + 脚注 + 排除清单 |
| `harness.ts` | PerfCase/PerfPair/PerfSuite 类型、计时跑器、表格与小结格式化、单位成本门槛 |
| `index.ts` | 域注册表 + **排除清单**（每个被排除的出口与理由） |
| `suites/streamingSuite.ts` | 切分/揭示：**直接复用 parity 套件的 case 定义**（`pair.wasm` 就是生产出口），按白名单挑已接线的 pair |
| `suites/markdownParseSuite.ts` | markdown 解析：形状语料放大到 ~4k 字符 + 规模档 + 生产流式短尾 + 逐帧增长 |
| `suites/markdownHighlightSuite.ts` | 高亮：语言语料 + 巨块档。**#241 起量的是 Lezer（`highlightBlockWithLezer`），不走计算核** |
| `suites/projectorSuite.ts` | 投影折叠：delta 流 / 混合流 / 乱序覆盖 |
| `suites/eventsSuite.ts` | 单帧归一：delta 流 / 完整回合 / 真机捕获载荷 / 畸形 |
| `fixtures/envelopes.ts` | projector 的 envelope 生成器（出处 `fa4aab5d^:scripts/compute-parity/fixtures/envelopes.ts`） |
| `fixtures/eventWires.ts` | events 的原始 wire 构造（形状抄自 `src/__tests__/replay/harness.ts`）+ 真机捕获载荷 |

## 借了哪些存量资产（「已接线才借」）

| 借用物 | 出处 |
|---|---|
| 切分/揭示的 case 定义与语料 | `scripts/compute-parity/{suites,fixtures}/`（仍在树上，parity 门禁也用） |
| markdown / highlight 语料 | `scripts/compute-parity/fixtures/corpora.ts`（highlight 语料现喂给 Lezer） |
| markdown 的「生产流式形状」case 构造（`tailOf` / `growingFrames`） | `66671b92^:scripts/compute-parity/suites/markdownParseSuite.ts` |
| projector 的 envelope 生成器 | `fa4aab5d^:scripts/compute-parity/fixtures/envelopes.ts` |
| events 的 wire 形状 | `src/__tests__/replay/harness.ts` 的 `raw*()` + 真机捕获 JSON |

**不借**：`scripts/compute-parity/baselines/**`——冻结/雕刻的 TS 基线，全部不在生产路径。
它们是 parity 门禁的对照物与回退点，但拿它们当 benchmark 的另一侧正是 #233 要废除的形状。

## 已知的形状陷阱（都会被基准照实暴露）

- **列表/引用毒化稳定块**：文档里一旦出现列表或引用块，**其后所有内容都不再产生稳定块**，
  整段落进不稳定尾块。实测 `段落A\n\n- 项1\n\n段落B` 的稳定块数是 **1**（只有 A），
  `- 项1\n- 项2\n\n新段落开始\n\n` 是 **0**。⇒ 生产里消息含列表/引用时，其后全部内容每拍
  都在尾块里被重新解析。`streaming-split` 的 `list-block-*` 行是这个形状的成本读数
  （切分扫描本身很便宜，代价在下游的整段重解析）。
- **切分成本 ∝ 稳定块数，不 ∝ 字符数**：`list-block-m` 与 `blocks-m` 的每字符成本相差一个
  数量级，前者便宜正因为它几乎不产出稳定块。读表时别把「便宜」当「更优」。
