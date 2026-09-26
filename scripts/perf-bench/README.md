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

---

## memory 域（#376 / #375）

上面那一套量的是**耗时**；memory 域量的是**折完之后文档还留着多少**。判据全用比值，
因为绝对 MB 依赖 provider 形状（工具输出是否经 `tool_call_update` 流式回传决定量级，
Hermes 根本不回传——见开发记录 `.agents/records/375-376-memory-payload-amplification.md`）。

### 跑法

```bash
bun run perf-bench:memory              # 出表 + 按判据给退出码（0=全过，1=有未过项）
PERF_MEMORY_LEGACY=1 bun run perf-bench:memory   # 对照档：关掉 timeline 收窄，用同一把尺子量改动前
```

一条命令、无外部依赖、无浏览器、毫秒级（~270ms）。

### 读数与阈值

| 列 / 判据 | 口径 | 阈值 |
|---|---|---|
| `Σ逻辑载荷` | 语料里各拍**累计 content 字符数之和**（与开发记录 61.5 MB 同一口径） | — |
| `文档驻留(估)` | 从**文档**根出发遍历对象图、**每个唯一对象只记一次**的估算字节（`retainedHeap.ts`） | — |
| `驻留/Σ载荷` | `cold-load-residency`：整份 compact 读折完后的驻留比 | **≤ 1.2×** |
| 拍数敏感性 | **同一终值内容**下 5 拍 → 40 拍的**绝对**驻留增长 | **≤ 1.5×** |

两点别读错：

1. **这是估算，不是 V8 实测。** 字符串按 UTF-16 两字节 + 头，对象按头 + 每属性一个槽位。
   用途是**比值**与回归对照——同一把尺子前后比是可靠的，当绝对 MB 用则不可靠。
2. **拍数敏感性必须用绝对字节。** 累计式回传下 Σ载荷 本身随拍数增长（5 拍的 Σ 约为 40 拍的一半），
   用「驻留/Σ载荷」比值会把要量的效应约掉：本域早期版本正是这么写的，于是对照档也「PASS」——
   实测对照档 5 拍 5.6 MB → 40 拍 38.0 MB（**6.82×**，与开发记录实机测得的 6.3× 吻合），
   改后 1.9 MB → 2.3 MB（**1.20×**）。

实测对照（同一尺子）：

| 档 | 驻留/Σ载荷 | 拍数敏感性 |
|---|---|---|
| `PERF_MEMORY_LEGACY=1`（关 timeline 收窄） | 4.051× | 6.82× |
| 默认（#375-a/c/e 生效） | **0.432×** | **1.20×** |

### 语料

`fixtures/memoryCorpus.ts`：一个完整回合 `user_message_chunk` → 100 ×（`tool_call` +
20 × `tool_call_update`，content **逐拍累计**至 60 KB）→ `usage_update` → `done` = **2203 行**
（与开发记录 §复现方法同一配方）。走生产归一化器 `normalizeRawEvent`，且**不含 turn.unit 行**
（单元只由 kernel ingest 追加，而记录的注入走前端 append 轨）——正是「compact 读全量下发」的形状。

### 实机口径（绝对 MB 与进程峰值）

纯函数口径量不到进程峰值（renderer 的非 JS 堆、宿主序列化峰值都不在里面）。实机读数走两步：

**1) 进程树采样**（宿主 + WebView2 进程组，按 `ParentProcessId` 展开）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/perf-bench/proc-tree.ps1 -RootName pylon.exe -Seconds 60 -IntervalMs 500 -OutCsv mem.csv
```

末行给出 `steady` / `peak` / `peak/steady`（验收判据是**比值**：宿主与 renderer 组各 ≤ 2×）。

**2) 页面内读数**（V8 堆 / GC 后驻留）：devtools console 里

```js
// 冷挂载前后各取一次；GC 后再取驻留
const gc = async () => { await new Promise(r => setTimeout(r, 1500)); return performance.memory }
console.table({ before: (await gc()).usedJSHeapSize })
```

CDP 路径（更准，需要常驻连接）：

```bash
# 端口由 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 开；采样与取快照必须在同一条 CDP 连接内
# （分次 MCP 调用会报 "not sampled"——见开发记录）
node -e "const ws=require('ws');/* HeapProfiler.startSampling → 操作 → stopSampling/takeHeapSnapshot */"
```

### 隔离副本（否则与真机共用 profile，无法并行）

```bash
cd <副本>/ && WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223 --remote-allow-origins=*"   WEBVIEW2_USER_DATA_FOLDER="<副本>/webview" ./pylon.exe
# 核验：Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | % CommandLine 里能看到 --user-data-dir
```

注入合成回合走应用自己的写路径：`__TAURI_INTERNALS__.invoke('evt_append', { events, expectedRevision: null })`。
两个坑（照抄开发记录，别重新踩）：① 缺 user 起始帧时工具事件被终态栅栏判为 late-event 整批丢弃；
② 事件类型由 `rawPayload.update.sessionUpdate` 推导，不由入参 `eventType` 决定。
