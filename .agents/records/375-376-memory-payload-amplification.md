# Dev Record — #375 / #376 内存载荷放大调查（静态审核 + 实机验收）

> 入库保留。本轮**未改任何代码**——这是调查报告与优化设计，施工已拆成 #375（投影层载荷持有）与 #376（读路径载荷双份 / 冷装载）。
> 规格（不入库）：`.agents/spec/375-376-memory-payload-amplification.md`。

## 元信息

- issue：**#376**（bug：读路径载荷双份 + 冷装载全量下发）、**#375**（refactor：投影层载荷三重持有 + 工具拍不折叠）
- 分支：`kumo/prometheus`（与 `github/main` 同步，落后 0）
- 提交范围：仅 `.agents/records/` 与 `.agents/L.md`（无代码改动）
- 日期：2026-09-27
- 用户原话（对齐依据）：「本项目在常会话多工具调用会话情况内存峰值可达 2g，你需深度调查下本项目可能存在的各项内存占用问题，找到每一个可能的内存热点，并着力于设计优化大部分额外占用内存的代码写法和代码结构，尽量不派发子agent，任务范围：前端」；后续两轮扩容：「准许植入内存探针，准许发送真实 prompt」「准许你合成大会话重放来测试内存」

## 目标与范围

**目标**：定位「常会话多工具调用 → 峰值 2G」的成因，给出**可复现**的证据链与优化设计。

**做到**：① 前端全链路静态审核（IPC 帧 → canonical 行 → 投影文档 → DOM）；② 第一轮真机验收（真机实例、4 条真实 prompt + 6 个轻回合）；③ 第二轮隔离副本合成大会话重放（受控规模）。

**不做什么**：本轮不改任何代码；不碰真机数据（结论见「证据」的真机核验）；不重建构建产物（用的是发行包二进制，非本仓源码构建——本轮无前端改动，不涉及 skill 里的「必须重编译」前提）。

## 结论

**2 GB 在真机上复现，成因是「工具载荷在 journal→文档 这条链路上被放大」，且同时打穿前端与宿主两侧。**

合成 61.5 MB 工具载荷（2203 事件）冷挂载实测：

| 量 | 实测 | 相对 Σ载荷 |
| --- | --- | --- |
| 落盘（typed 62.4 + raw 62.5） | 130.6 MB | 2.1×（双份） |
| 单行经 IPC | 56.2 KB | 2.0×（逻辑 28 KB） |
| 前端 GC 后驻留 | 155.9 MB（净 +131.2 MB） | **2.13×** |
| 冷装载 V8 堆峰 | 485.0 MB | **7.9×** |
| renderer 进程组峰 | 1750.8 MB | **28×** |
| `pylon.exe` 峰 | 1438.6 MB | **23×** |
| **进程树总计峰** | **2638.3 MB** | 42.9× |
| 对照（同 2203 事件 / Σ载荷 1.02 MB） | 驻留仅 +4.2 MB | ≈1.9 KB/事件 |

四条乘数（按可修性排序）：

1. **读路径把载荷发两份**：`typed_payload` **不截断**（实测 400 KB 原样入库）、`raw_payload` 截 64 KiB，而**前端投影只读 `rawPayload`** ⇒ 未截断那份白传，同时抬高 IPC 体积、宿主序列化峰值（1438 MB）、前端解析 churn。
2. **冷装载一次性全量下发**：`loadAllPreferUnits` 单次 invoke 取回整库，装载期「行 + 信封 + 文档」三份并存 ⇒ 峰值是稳态的 3–4 倍。
3. **前端对同一载荷三重持有**：`timeline[].data` 一份 + `activities[]` 的 `structuredClone` 一份 + `fold.log` 信封 `raw` 一份 ⇒ 驻留 2.13×。
4. **工具事件不参与折叠**（`turn_rollup.rs` 只折 text/thinking delta）：累计式回传的 provider 每拍一份 ⇒ 随拍数线性、随终值二次（同一终值内容，5 拍 → 17.4 MB，40 拍 → 109.8 MB）。

## 静态审核发现（按证据强度分级）

### A 级：本轮**实机实测证实**

| 现象 | 证据 |
| --- | --- |
| 载荷双份落盘（typed 不截 / raw 截 64 KiB） | 合成行实测 `typed=100.1/200.1/300.1/400.1KB` vs `raw=64.0KB`；全库 `raw>64KiB` 行数 = **0**，最大 63.99 KB |
| 前端投影只读 `rawPayload` | `canonicalRowToWorkbench` → `normalizeCanonicalRowToEnvelopes(event, event.rawPayload, …)`（`agentWorkbenchProjection.ts:181`）；`typedPayload` 只被读小标量（`canonicalHookProjection.ts:53`、`canonicalTouchedFileProjection.ts:31`、`canonicalTurnDuration.ts:94`） |
| 文档驻留 = Σ各拍载荷 × 2.13 | GC 后 155.9 MB vs 净增 131.2 MB / 61.5 MB |
| 冷装载峰值 ≫ 稳态 | 485 MB 峰 / 156 MB 稳（3.1×）；进程级 1750.8 / 620.8（2.8×） |
| 每回合重复元数据快照 | journal 实测：`session.commands-updated` 单条 **16 132 B** × 1–2 次/回合（claude-code 会话里**连续 5 行内容完全相同**）；`session.config-updated` 13–14 KB × 1–2 次/回合 |
| 读侧折叠在承重 | 该会话 canonical **7418 个事件**，`evt_load_compact` 只下发 **81 行 / 971 KB**（`unit seq=7403 covers=2192..7402`）——所以「timeline 常驻每个事件」被 #81 L2 大幅削弱，**但工具事件不折叠**这条风险仍在 |
| 相邻工具调用被折叠成组徽标 | 注入 100 次调用 → DOM 只 +112 节点，页面只多一行 `Bash #7 (100 次…)`（`groupAdjacentToolActivities`）⇒ **载荷不上面，只进文档** |
| 前端**无**每回合泄漏 | 连续三个轻回合各 +0.2/0.2 MB、DOM +18 节点/回合；首回合 +2.4 MB 是一次性惰性装载（markdown 核 / Lezer / 字体 / 套件）；GC 地板稳定 |
| 峰值是瞬态 | V8 13.5 → 峰 125.7 → 稳 26.7 MB；进程树 619 → 峰 1116 → 稳 408 MB（第一轮） |
| 渲染进程的非 JS 堆占大头 | 页面渲染进程 WS 峰 309.8 MB vs 同刻 V8 堆峰 125.7 MB ⇒ ≈184 MB 是 Blink/合成/字形/图片/代码缓存；整组 811 MB 峰值里 JS 堆占比 <16% |

### B 级：**代码确证，但本机 provider 未触发**

- **工具载荷每拍 `structuredClone`**：`workbenchProjector.ts:1070-1082` 对 `input/locations/progress/capabilities/parts/rawOutput/rawInput` 逐字段**无条件** `jsonSnapshot`（= `structuredClone`，失败回退 `JSON.parse(JSON.stringify)`），不看值是否变过；`mergeToolActivity` 终态前每拍作废 ⇒ 纯 churn，终态后额外常驻一份。
- **`fold.log` 整会话保留每个信封（含 `raw` ≤64 KiB 副本）**：`agentWorkbenchSession.ts:156-160` + `normalizerSupport.ts:1091`（`makeEnvelope(..., raw: input)`）+ `workbenchEventSchema.ts:244`（64 KiB 上限）。Bun 探针：1440 个工具更新事件 → 信封 raw **44.82 MB**。
- **Hermes 不把工具输出经 `tool_call_update` 回传**：其工具行 raw 仅 290–892 B；一次「输出 200 万字符」的实验里，agent 自述把输出落到 `F:\Hermes\profiles\riccati\cache\terminal-output\…log`（52 807 字符，2 879 截断），journal 里该回合 `tool.call.completed` raw 仅 **406 B**，前端 DOM 无大文本节点、驻留只 +2 MB。⇒ **A 级第 1/2/4 条的风险量级取决于 provider 是否流式回传工具输出**（Claude Code 式 Bash 流会走到）。
- **每拍 O(M)/O(A×M) 重建**：`messageLookups.ts:11`（每拍 3 个 Set）、`chatRowPipeline.ts:69`（每拍 M 个 descriptor）、`solidWorkbenchProjectionSupport.ts:21-40`（`selectActivityTimelinePlacement` 是 O(活动×消息)）、`toolInvocationSnapshot`（`workbenchProjector.ts:682` 的 `find` + `Object.freeze({...})`）。真机诊断：`publishCost.maxMs 19.1`、`parseCost {parsed:1250, parseMs:253, maxParseMs:19.4}`——**当前在帧预算内，优先级可降**。
- **响应式访问器里重建重派生**：`BuiltinSolidContentSlot.solid.tsx:278`、`ToolInvocationCard.solid.tsx:193` 把 `diffSnapshotFromPart()` 放在 `<Show when>`/渲染体里。
- **多 agent 页签保活**：`SheetLayout.tsx:187` 的 `agent-sheet-keep-alive` 让每个打开的 agent 页签各持一套 runtime/文档/DOM，**无数量上限** ⇒ 上述全部按页签数成倍。属产品裁决，已列入 spec 未决问题。

### C 级：**已治理，勿重复劳动**

delta 折叠（#81 L1/L2）、投影器 Θ(N²)（#205/#234）、行虚拟化（#243）、高亮 DOM 生命周期（#221）、Lezer 取代 syntect（#240/#241）、markdown LRU 字符预算（#208/#150/#212）、`errorCenter` 上限 50、日志上限、插件 event bus 无缓冲、编辑器实例随卸载销毁、`URL.createObjectURL` 均已 revoke。

## 复现方法

```bash
# 1) 隔离副本（真机零改动）：复制实例 → 独立 WebView2 profile
#    必须设 WEBVIEW2_USER_DATA_FOLDER，否则副本与真机共用 %LOCALAPPDATA%\com.prism.desktop\EBWebView
#    核验：Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | % CommandLine | grep user-data-dir
cd <副本>/ && WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223 --remote-allow-origins=*" \
  WEBVIEW2_USER_DATA_FOLDER="<副本>/webview" ./pylon.exe
# 2) 页面内注入（应用自己的写路径），必须是**一个完整回合**
#    user_message_chunk → 100×(tool_call + 20×tool_call_update，content 逐拍累计至 60KB) → usage_update → done
#    await window.__TAURI_INTERNALS__.invoke('evt_append', {events, expectedRevision: null})
# 3) 采样：进程树 WorkingSet64（按 ParentProcessId 展开，按进程名分组）+ performance.memory + HeapProfiler.collectGarbage
```

**两个坑（写下来给后人）**：
1. **注入必须构成一个完整回合**。缺 `user_message_chunk` 起始帧时，工具事件被终态栅栏判为 late-event **整批丢弃**（`workbenchProjector.ts:841` + `TERMINAL_SESSION_STATUSES`），表现为「行注进去了、一张卡都不出」。
2. **事件类型由 `rawPayload.update.sessionUpdate` 推导**，不由入参 `eventType` 决定（`pylon-canonical-types/src/lib.rs:135`）。`done` → `turn.completed`；`tool_call_update` 按 `status` 细分为 updated/completed/failed。

## 证据

- **真机核验（未被我碰）**：真机 DB `102` 行、含合成行 `0`、`maxSeq=7418`（1.7 MB）；实验室库 `4846` 行 / 144.5 MB。副本与 profile 已删，端口 9222/9223 已释放，采样器已停。
- **第一轮（真机 9222，Hermes/Riccati）**：8 回合（4 条真实 prompt + 轻回合）；冷启 V8 13.5 MB / DOM 600 → 峰 **125.7 MB** / DOM 1037 → 稳 26.7 MB / DOM 1036；进程树 619 → 峰 **1116 MB** → 稳 408 MB；静置构成 renderer 338.6 MB WS（专用 395.1）、`pylon.exe` 53 MB WS（**专用 204.2**）、Hermes python 78.8 MB WS（专用 180.7）。
- **第二轮（隔离副本 9223，合成重放）**：大档 2203 事件 / Σ载荷 61.52 MB → 冷装载 V8 峰 **485.0 MB**、GC 后 **155.9 MB**；进程树 app 峰 **1438.6** / renderer 峰 **1750.8** / agent ≈197 / **总 2638.3 MB**（66 s 窗，0.5 s 采样）。对照档 2203 事件 / Σ载荷 1.02 MB → 驻留 +4.2 MB。
- **Bun 合成探针（投影层纯函数口径）**：文档驻留/Σ载荷 = 2.25–2.43×（与真机 2.13× 吻合）；随拍数 5/10/20/40 → 17.4/31.5/56.6/**109.8** MB（同一终值内容）；信封 raw 44.82 MB / 1440 事件；同一载荷在文档里的持有处数（按值计）3–5 处。
- **脚本**（仓外 `G:\TEMP\pylon-mem-probe\`，未入库）：`lab.ts`（实验客户端）、`inject.js`（合成回合生成器）、`mem-probe.ps1`（进程树采样，ASCII-only）、`mcp.ts`/`mcp-batch.ts`（MCP stdio 驱动）、`probe*.ts`（Bun 合成探针）、`journal-shape.py`（journal 形态只读分析）、`lab-mem.csv`、`mem-app.csv`。
- **无 commit 证据**：本轮无代码改动。

## 测试处置

无（未改代码，未改测试）。

## 与 spec 的偏差

- spec 计划的「HeapProfiler 支配树归因」**未做**：`startSampling` 经 MCP 调用后再 `stopSampling` 报 `was not sampled`（每次 `tools/call` 似新建 CDP 连接，profiler 状态不跨连接）。已写好常驻会话版本 `cdp-alloc.ts`，跑一次即可补。**因此「2.13× 里 timeline / activity / fold.log 各占多少」目前只有代码级判断 + Bun 分桶，无 V8 支配树证据。**
- spec 计划的「>64 KiB 变体整档对照」**改为边界单测**（3 卡 × 4 拍 × 400 KB）：足以证明 `raw` 精确截到 64.0 KB、`typed` 不截，整档对照被判定为低边际收益。
- 额外发现（spec 未预见）：**host 侧 `pylon.exe` 峰值 1438.6 MB**——同一根因（IPC 序列化双份载荷）打穿宿主，占 2 GB 的一半。已并入 #376。

## 未解问题

1. **页签保活要不要设上限**（属产品裁决）：非活动 agent 页签保留文档可避免重挂载卡顿（#234 实测冷挂载首行 15 ms / 结算 731 ms），但会把上述全部乘数按页签数放大。需要「保活 N 个」还是「非活动即卸 runtime、只留 UI 状态」的决定。
2. **`dataOf(eventId)` 按需回读**是否会破坏插件渲染契约（`timeline.data` 是 renderer/插件可见面）——#375 的收窄范围需逐事件类型定档。
3. Hermes 之外的实际 provider（Claude Code 流式 Bash）是否真的走累计式回传——本机两个 agent 都没有可用的工具载荷样本（真机 journal 里 claude-code 会话也无工具行）。**这是 #376 量级定档的关键未知**，建议在真实 Claude Code 会话上抓一次 journal（`select event_type, count(*), avg(length(raw_payload)) from canonical_events group by 1`）。

## 并行交集

本轮**只新增**以下文件，未触碰任何共享文件域（工作树里 #348/#349/#361-363/#371/#372 的在途改动均未被 stage/commit）：

- `.agents/records/375-376-memory-payload-amplification.md`（新增）
- `.agents/spec/375-376-memory-payload-amplification.md`（新增，`.agents/spec/` 已在 `.gitignore`）
- `.agents/L.md`（追加一条）

未来施工的交集（**开工时需重新声明**）：

- #376：`src-tauri/pylon-session/src/event_repo/{redaction,mod}.rs`、`src-tauri/src/session/mod.rs`（读出口）、`src/infrastructure/events/canonicalEventRepository.ts`。**避让** #348/#349（`pylon-acp/**`、`src/session/{create,fork}.rs`）与 #361-363（`src-tauri/src/logging/**`、`pylon-core/**`）。
- #375：`src/domains/workbench/workbenchProjector.ts`、`src/sheets/agent-workbench/agentWorkbenchSession.ts`、`src-tauri/pylon-session/src/turn_rollup.rs`、`src/renderers/solid-workbench/**`。**避让** #351（`src/` 根件下沉）、#358/#370（renderer 与样式）。

---

# 施工记录（同一 case 的落地：目标/范围/方案/验收结论）

> 上文是第一阶段的**调查报告**（未改代码）。本节承接施工：把四条乘数收敛到有界，
> 并把规格 `.agents/spec/375-376-memory-payload-amplification.md` 的目标/范围/方案/验收
> 结论并入本记录（spec 不入库、不保留）。

## 元信息

- issue：#376（读路径载荷双份 + 冷装载全量下发）、#375（投影层载荷三重持有 + 工具拍不折叠）
- 分支：`kumo/prometheus`（共享工作树）
- 提交：`97a09f38`（#376-a）→ `48dd08d2`（#376-b）→ `fc7473f2`（#375-a）→ `f0e9bc78`（#375-c/e）
  → `d3c7cef0`（memory 域）→ `91da068f`（rustfmt）→ `c1f8d475`·`6d7c1a6e`（记录与说明书）
  → `1b6478f2`（#375-d 元数据快照复用）→ `62568e39`（补落 #375-a 长字符串收窄规则与 #375-c 接线）
- 日期：2026-09-27

## 目标与范围

**做到**：读路径只发一份载荷、冷装载分页续折、投影层载荷单一持有、拍数敏感性去二次化，
并把这些判据做成**一条命令可复跑**的门禁件。

**不做**（与规格一致）：不改 canonical 事件契约与持久化格式、不动 `turn.unit` 的 wire 形状、
不动 `evt_export_raw` 语义、不改渲染视觉与交互（相邻工具卡折成组徽标是既有设计）、
不动高亮/markdown 缓存、不引入新事件类型（跨度语义沿用 ADR-0016）。

## 改动清单

| 文件 | 区段 | 性质 |
| --- | --- | --- |
| `pylon-session/src/event_repo/redaction.rs` | 新增 `retain_typed_payload` 与收口常量/标记 | 修改 |
| `pylon-session/src/event_repo/service.rs` | `list_events` / `load_events_compact*` 收口 + `cap_typed_payload_row` | 修改 |
| `pylon-session/src/event_repo/repo.rs` | 新增 `load_events_compact_page`、删 `MAX_COMPACT_SQL_RANGES` 与整读回退路径 | 修改 |
| `pylon-session/src/event_repo/fold.rs` | 折叠规则抽成 `DeltaRun` 累加器 + `continues_run` / `last_run_boundary_index` | 修改 |
| `pylon-session/src/event_repo/row.rs`·`mod.rs` | `CompactEventPage` | 修改 |
| `pylon-session/src/event_repo/tests.rs` | 收口 4 例 + 分页 3 例 | 修改 |
| `src-tauri/src/session/mod.rs` | `evt_list` / `evt_load_compact` 签名（各加读出口开关/游标参数） | 修改 |
| `src-tauri/src/session/prompt.rs`·`revive_tests.rs`·`src-tauri/src/test_harness.rs` | 宿主内部读传 `false`（保逐字节语义） | 修改 |
| `src/infrastructure/events/canonicalEventRepository.ts` | `listCompact` + `loadAllPreferUnits` 分页循环 + 收口开关入参 | 修改 |
| `src/infrastructure/events/readPathSwitches.ts` | 两处读路径杀停开关单点 | 新增 |
| `src/infrastructure/events/__tests__/canonicalEventRepository.test.ts` | 分页/开关用例 | 修改 |
| `src/domains/events/canonicalTurnDuration.ts` | `canonicalBoundaryProjection`（分页终态判据累积，只留标量） | 修改 |
| `src/domains/workbench/workbenchProjector.ts` | `timeline.data` 收窄 + 就地深冻结（删 `jsonSnapshot`） | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchProjection.ts` | `withoutEnvelopeRaw` | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | `listJournalPages` 分页冷装载 + `publishFoldedDocument` 抽出 + fold.log 剥 raw | 修改 |
| `recoveryRace.test.ts`·`canonicalEventDoubleWrite.test.ts` | 契约变更随之修正 | 修改 |
| `src/__tests__/replay/agentWorkbenchSession.pagedLoad.test.ts` | 分页 vs 一次性等价 | 新增 |
| `src/domains/workbench/__tests__/timelinePayloadNarrowing.test.ts` | 收窄/共享/剥 raw | 新增 |
| `scripts/perf-bench/{retainedHeap.ts,suites/memorySuite.ts,memory-probe.mts,proc-tree.ps1,fixtures/memoryCorpus.ts,README.md}` | memory 域 | 新增/修改 |
| `package.json` | `perf-bench` / `perf-bench:memory` | 修改 |
| `vitest.setup.ts` | 新测试文件登记进既定 B 类（feed 注册噪音） | 修改 |

## 方案要点

**#376-a 读出口收口（service 层）**：`retain_typed_payload` 与 `retain_raw_payload` 同模块同常量。
预算内**逐字节不变**；超预算按同一比例收缩字符串叶子（`keep_i = len_i × allowed / target`，
整数除法保证 `Σkeep ≤ allowed`，故必落回线内），键与非字符串标量逐字节不动，UTF-8 边界安全，
截断事实以 `_pylonTypedTruncated` 保留键可见（口径同 raw 的 `_pylonTruncated`）。
`turn.unit` **豁免**（单元行是整段正文的唯一副本，raw 只是占位对象）。收口只在 service 层：
repo 层与 `turn_rollup` 的 trim 重折校验必须保持全文，否则 #81 L3 的 sha256 会静默失配。

**#376-b 冷装载分页续折**：`load_events_compact_page(owner_key, after_sequence, limit)` 一次一页
（升序、**前向**游标）。过滤不再把覆盖跨度内联进 SQL（跨度过千会撞表达式深度/参数上限），
改为只读 `(sequence, event_type)` 两列的元数据扫描 + 跨度指针，被覆盖行**不解码成 `Value` 树**。
关键约束：**页边界必须落在 delta run 边界上**，否则读侧折叠的切点随页边界漂移、分页折与一次性折
不再等价——为此把折叠规则抽成 `DeltaRun` 累加器，折叠与分页守卫共用同一份判定；页尾 run 若仍在
继续，本页延长到它闭合（`accepts` 自带 48 KiB / 2000 chunk 预算 ⇒ run 有界 ⇒ 延长有界）。
前端 `agentWorkbenchSession` 新增可选装载缝 `listJournalPages`：逐页折进同一份文档，页内行与信封
折完即回收；终态判据跨页累积时只留标量（`canonicalBoundaryProjection`），发布仍只有一次
（`publishCanonicalRead` 的成功尾巴抽成 `publishFoldedDocument`，语义逐字不变）。
装载缝优先级：显式 `listJournalPages` >（注入了 `loadAll` 则退回一次性读 ⇒ 既有测试与嵌入式宿主
行为不变）> 默认分页读。

**#375-a `timeline.data` 收窄**：只收 tool / activity 两族（其他族逐字不变）。规则按**长度**而非
键名白名单——`rawOutput` 是对象但大字符串在 `rawOutput.text`，`input` 有时只有 `{command}` 有时是
整份文件正文，按长度判定对两种形状都成立：短标量（≤512）与一层内嵌对象的短标量留下，数组、第三层
复合值、超长字符串一律不进 `data`，被省略的键名以点分路径记进 `payloadKeys` 供插件迁移定位。
逃生口 `data-timeline-payload="full"`（`timeline.data` 是 renderer/插件可见面，见「遗留」）。

**#375-c/#375-e 载荷单一持有**：`freezeDeepValue` 原实现是 `map`+`Object.fromEntries` **重建整棵树**
（= 深克隆 + 冻结，与被它取代的 `structuredClone` 同一笔分配账）——改为**沿原引用递归冻结**，
于是活动节点与信封语义事件共享同一批对象，同一份载荷在文档里只剩一份；`jsonSnapshot` 就此删除。
`fold.log`（reject 回滚整页重折用）是信封 `raw` 的唯一持有者而无人读它，入日志前用
`withoutEnvelopeRaw` 剥掉（信封本身的 normalize 契约不变）。

## 验收标准与结果

**比值判据（同一合成语料 2203 行 / Σ逻辑载荷 60.1 MB，`bun run perf-bench:memory`）**：

| 验收项 | 阈值 | 改前（同尺对照） | 改后 | 判 |
| --- | --- | --- | --- | --- |
| **文档**驻留 / Σ逻辑载荷 | ≤ 1.2× | 2.046× | **0.235×** | PASS |
| 拍数敏感性（同终值内容，绝对驻留）5→40 拍 | ≤ 1.5× | 6.81× | **1.34×** | PASS |
| 同内容元数据快照（500 行独立对象） | ≤ 2× | 500.15×（注释掉 intern） | **1.15×** | PASS |

三点必须连着读（评审后校准与纠正）：

1. **只量「文档」，不含 `fold.log`。** 会话级稳态驻留 = 文档 + fold.log（reject 回滚用的整会话
   信封日志）。本批只把 `raw` 从日志剥掉，信封的 `event` 仍带完整载荷 ⇒ **日志读取后的会话级
   驻留与拍数敏感性并未被本批解决**（评审 M2 用同一估值器量得 fold.log 的 `event` 驻留 ≈ Σ载荷，
   会话总量≈1.4× 且拍数敏感性≈6.8× 仍在）。这一项归 #380「fold.log 只留 eventId + 回滚按需重读」。
   此前文里「拍数敏感性已解决」的措辞据此收窄为**文档口径**。
2. **分子分母同一把尺子。** 语料 Σ载荷是字符数（ASCII ⇒ 1 字符 1 字节），故估值器对字符串按 V8
   实际表示计（Latin1 1 字节/单位、非 Latin1 2 字节/单位）。早期版本一律按 UTF-16 两字节算分子，
   把比值抬高约 2×（0.432× 实为 ~0.22 份载荷、1.2× 阈值实为 ~2.4 份）——评审 M3 指出后已校准，
   表中是校准后读数；`PERF_MEMORY_LEGACY=1` 只关 #375-a 的 timeline 收窄，是**部分反事实**
   （批次前还会额外克隆活动载荷），不是完整的批次前文档。
3. 对照档的 6.81× 与调查报告的实机 6.3× 同量级（差 8%），这把尺子对得上当时的读数。

| 验收项 | 结果 |
| --- | --- |
| 读出口 typed 载荷 ≤ 64 KiB 且标量逐字节不变 / 多字节安全 / `turn.unit` 豁免 | Rust 4 例绿（`redaction`/`service` 路径） |
| 分页装载终态文档与一次性装载逐字段等价 | Rust 3 例（逐页 vs 一次性逐位等价，limit 1/2/3/4/7）+ 前端 4 例（文档逐字段等价） |
| 页边界不切碎 delta run | Rust 1 例绿（span 与一次性读相同） |
| 既有行为测试 | `bun run test` 654 files / 5030 passed（仅余 2 条既有红灯，见「测试处置」） |
| `cargo test -p pylon-session --lib` | **167 passed** |
| `check:solid` / `check:ipc` | 通过（IPC 后端 228 命令 ↔ 前端 159 invoke 双向一致） |
| 未新增白名单豁免 | `check:solid` 报告「33 条遗留白名单仅报告；无新增越界」；`vitest.setup.ts` 新增一条**测试文件**登记（既定 B 类 feed 注册噪音，与 9 个同族文件一致） |

## 测试处置

**修改的既有用例（逐个点名 + 理由）**：

| 用例 | 改动 | 理由 |
| --- | --- | --- |
| `canonicalEventRepository.test.ts`（`evt_list` 参数断言 ×3） | 加 `capTypedPayload: true` | #376-a 给读出口加了收口开关参数 |
| 同上（`loadAllPreferUnits` 相关） | 改为逐页形态断言 | #376-b 把 `evt_load_compact` 改成「一页」返回 |
| `canonicalEventDoubleWrite.test.ts`（`evt_list` 参数断言） | 加 `capTypedPayload: true` | 同上 |
| `agentWorkbenchLifecycle.recoveryRace.test.ts`（`evt_load_compact` mock） | 返回 `{ events, nextAfterSequence }` | 同上（旧 mock 返回裸数组，会静默走成空页） |

| `src/__tests__/replay/canonicalEventSink.batch.test.ts`·`src/infrastructure/events/__tests__/canonicalEventSink.test.ts` | 替身补 `listCompact` 成员 | #376-b 给 repository 接口加了成员，缺它 TS2741 整块不满足（`62568e39`） |
| `src-tauri/src/session/revive_tests.rs` | `list_events` 增 `false` 实参 | #376-a 的签名变更（`97a09f38`） |

**未修改**：`agentWorkbenchSession.batch.test.ts` 等 30 余处注入 `loadAll` 的行为测试**逐字未动**
（装载缝优先级保证它们仍走一次性读）。

**既有红灯（与本批无关，供核）**：编写本记录时为 `scripts/sheetRegistry.compat.test.mts` /
`scripts/sheetState.compat.test.mts`（断言 sheet 注册表 10 类、实际 11 类，第 11 类是 `f959b48c`
#371 Docs Sheet 的 `docs`）；其后 #371 的审查修复（`088a5096`）已把它们修绿，随后又出现
`sheetRegistrySidebarMode` 一条（同一注册表形状的 `sidebarMode` 完整性），归属相同。

## 证据

```
$ cargo test -p pylon-session --lib
test result: ok. 167 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

$ bun run perf-bench:memory
| cold-load-residency | 60.1 MB | 25.9 MB | 0.432× | 1.2× | PASS |
拍数敏感性（同一终值内容，绝对驻留）：5 拍 1.9 MB → 40 拍 2.3 MB，增长 1.20×（阈值 ≤ 1.5×）→ PASS
memory 域判据全过（268ms）

$ PERF_MEMORY_LEGACY=1 bun run perf-bench:memory      # 同一把尺子量改动前
| cold-load-residency | 60.1 MB | 243.4 MB | 4.051× | 1.2× | FAIL |
拍数敏感性：5 拍 5.6 MB → 40 拍 38.0 MB，增长 6.82×（阈值 ≤ 1.5×）→ FAIL

$ bun run check:solid   → 全绿（含「无新增 invoke/store/CustomEvent 越界」）
$ bun run check:ipc     → check:ipc ok — 后端注册 228 个命令，前端 invoke 159 个，双向一致（豁免 52）
$ bun run test          → 654 files / 5030 tests passed（2 条既有红灯见上）
```

**载荷分桶证据（收窄前的纯函数估算）**：同一语料折完后 `timeline` 123.0 MB / `activities` 23.1 MB /
其余切片 <0.01 MB——「timeline 持有整份事件」是主凶，且收窄后 timeline 降到接近零。

**补落与自检**：`62568e39` 补齐了两处**没有真正落地**的改动——#375-a 的收窄规则先前只提交了
「深度 ≤2 保留标量」那版（对 `tool.rawOutput.text` 这种「对象里塞大字符串」的形状无效，memory 域
实测 2.431× 不过阈值），真正生效的「超长字符串不进 `timeline.data`」那版留在工作树里没提交；
#375-c 的 `withoutEnvelopeRaw` 只落了 import、没落调用点（一次失败的脚本编辑造成的半落状态，
类型检查不报——有 import 使用点即可）。两处都补上，并加了一条**源码断言**用例（`fold.log.push(`
有且仅有一处且必须包着 `withoutEnvelopeRaw(`）让同类静默失效无法通过测试——`fold.log` 是运行时
内部状态、没有观测面，这是当时唯一可用的守卫形态。

**共享工作树注意**：本批在 `kumo/prometheus` 共享树上施工，与他人在途域（#348/#349、#361-363、
#356、#371/#372）交错。所有提交经**私有 index**（`GIT_INDEX_FILE`）落到历史，不触碰共享
`.git/index`；`session/mod.rs` 与 #361-363 改同一文件，提交时按 hunk 分账（只取含 `#376` 标记的
hunk）。中途观测到共享 index 被外部操作置为陈旧（一度把我的文件显示成 staged 删除），已按路径
修复为与 HEAD 一致，未触碰他人 staged 内容。

## 遗留（未做 / 需裁决）

1. **#375-b 工具拍折叠（未做）**：要动 `turn.unit` 的 segment 形状或新增一种 batch 行展开路径，
   落进「不动 `turn.unit` wire 形状」与「不新增事件类型」的禁区夹缝里；而它要治的**驻留**问题
   已由本批的 #375-a/c/d/e 在**文档口径**上解决（拍数敏感性 6.81× → 1.34×）。但**会话口径
   （文档 + fold.log）没有解决**：fold.log 仍持有每个拍次的信封 `event`（含完整载荷），
   日志读取后的会话级驻留与拍数敏感性因此仍在（评审 M2 的定量）。这一项与下面的遗留 5 是同
   一件事，同归 #380。已按 AGENTS §2.5 在 PR 描述里登记为后续 issue，不关闭 #375。
2. ~~#375-d 同内容元数据快照去重（未做）~~ → **已做**（`1b6478f2`）：落在
   `createWorkbenchEnvelope`（live 与 journal 两条路的唯一信封出口），对
   `session.commands-updated` / `session.config-updated` 按内容复用同一事件对象，缓存有界（8 份）。
   判据进 memory 域：500 行**独立对象**的同内容快照折完后 **1.15×**（阈值 ≤2×；把
   `internMetadataSnapshotEvent` 那行注释掉重跑立刻变 **500.15×** FAIL）。注意早期语料把同一个
   对象引用传了 500 次，天然去重成一个，判据无论 intern 在不在都 PASS——评审 M1 指出后已改成
   每行一个独立对象，这条门禁现在**会失败**。
3. **`timeline.data` 收窄的白名单范围需仓库主裁决**（spec 未决问题 2）：本批先按「长度 ≤512 的
   标量 + 一层内嵌对象的短标量」定档，并给出 `data-timeline-payload="full"` 逃生口。渲染引擎那条
   唯一入口台账（`CONTEXT.md` 指向仓外 `Docs/Archive/渲染引擎施工/00-唯一入口台账.md`）里
   `timeline.data` 只被登记为**剥敏面**，没有字段白名单，故本批按「保留标量身份面」保守处理。
4. **页签保活（未做——与既有契约冲突，需仓库主裁决）**：任务书 §1 把「非活动 agent 页签卸
   runtime 与 DOM、只留 sheet 记录与 UI 状态」列为已定决策，但**代码里这条行为是被测试钉住的**：

   - `src/workspace-sheets/__tests__/agentSuiteKeepAlive.integration.test.tsx:19` 的用例名就是
     「切离 Agent Sheet 只 pause，切回 resume，**renderer 不重建**」，并断言
     `expect(destroy).not.toHaveBeenCalled()`、`expect(mount).toHaveBeenCalledOnce()`；
   - 规格自己把它列进「不做什么」（"不做页签保活策略变更（产品裁决，见「未决问题」）"），
     并在未决问题 3 里作为待裁决项。

   即：这不是「顺手改一行」，而是**推翻一条被钉住的 UX 契约**——代价是每次切页签都要付一次
   冷挂载（`#234` 实测首行 15 ms / 结算 731 ms），并把那条集成测试的语义反转。按 AGENTS §4
   「不猜」与任务书「已定决策除非与代码事实冲突」的口径，本批**不动它**，在此登记冲突证据
   供仓库主裁决。要改的落点：`src/workspace-sheets/SheetLayout.tsx:184-192`（现为
   `display: none` + 常驻 `SheetHost`）→ 只渲染活动页签、非活动页渲染轻量占位；并反转
   `agentSuiteKeepAlive.integration.test.tsx` 的两条断言（记录在案）。
5. **`fold.log` 只留 eventId + 回滚按需重读（未做）**：本批只剥掉了 `raw`，`event` 仍留着
   （回滚重折是同步路径）。要走到底需把 reject 回滚改成异步按需重读并复核乐观行剔除的时序
   （spec 未决问题 4）。
6. **绝对 MB 级验收未做**：本批仍是比值口径（记录 §7 的如实标注不变——2 GB 峰值只在
   「工具输出经 `tool_call_update` 流式回传」的 provider 上出现，本机 provider 不在其中）。
   实机复跑用 `scripts/perf-bench/proc-tree.ps1` + README 的隔离副本/注入配方。
7. **V8 支配树归因未补**：本批给出的是纯函数分桶（见「证据」），仍不是 V8 支配树证据。

---

## 评审轮（三个独立子 agent，对抗式）与修复

派了三个互不知情的子 agent，各自带「证伪」任务：① Rust 读路径（#376-a/b）；② 前端投影层载荷
所有权（#375）；③ 证据可信度（读数含义、等价性是否真被测、记录与代码是否一致）。它们的结论
与处置如下——**发现的缺陷都已修**，并逐条补了会失败的回归测试。

### 阻塞级（已修，附「测试会失败」验证）

| 发现 | 后果 | 处置 |
| --- | --- | --- |
| `load_events_compact_page` 的扫描预算**被被覆盖行吃光** ⇒ 空页 + `next_after_sequence=None` | 前端与 repo 的循环都判定「到底」而停住：游标落在一段比预算更长的覆盖区之前时，**整段历史静默丢失**。评审实测 3900 行覆盖区 + `limit=64` ⇒ 0/3901 行交付；标志性会话（单元覆盖 5211 行）同样触发 | `next_after_sequence` 不再由 `rows.last()` 决定：未扫到 journal 末尾就**必须**返回 `Some`，空页退回「最后一个被扫描过的 sequence」；并把「收 run 用」的预算与「限扫描量」的预算分开（见下条）。回归测试 `compact_page_walk_survives_scan_budget_exhausted_by_covered_rows`——**把退回分支去掉即 FAIL**（已实测） |
| 同一根因第二面：预算用尽也会**切断 delta run** | 同一语料分页折出两条 batch 行、一次性折出一条（跨度不同 ⇒ 「页边界落在 run 边界」不成立） | run 收口用独立预算 `extend_budget`，不受覆盖区多寡影响；回归测试 `compact_page_keeps_run_whole_when_budget_exhausts_before_it`（同样实测会 FAIL） |
| `retain_typed_payload` 的 ≤64 KiB 保证在「把所有字符串清空也减不够」时漏 | 超预算的部分在**键名与结构本身**：实测 `{"<80KB 的键>":"x"}` 收完 80 116 B、3 万小对象 + 5 KB 字符串收完 349 032 B | 新增分支：`all_strings < excess` 时整体退回 `retain_raw_payload`。回归测试 `typed_payload_cap_holds_when_structure_alone_exceeds_budget`（修前实测 78 310 B→修后过线） |
| `retain_raw_payload` 的预览**按字符切、按字节限**（既有缺陷，被新的退回支路放大） | 非 ASCII 载荷下「保留值 ≤ 64 KiB」失效：70 000 个汉字实测 196 379 B | 预览改按**字节**切并**迭代收敛**（预览要作为 JSON 字符串再转义一次，`"`/`\` 各涨一倍，故单次按字节切仍可能越线）。回归测试 `payload_retention_holds_for_multibyte_payloads` |
| `proc-tree.ps1` 用 `$pid`（PowerShell **只读**自动变量） | 赋值抛非终止错误 ⇒ 采样器量的是 PowerShell 自己，输出静默错误的数据（评审实测：`-RootName explorer.exe` 只报一行 `other`） | 改名 `$currentId`；并在实测里确认现在量到真实进程树 |
| 同文件非 ASCII 注释在 Windows PowerShell（无 BOM + CP936）下**吞掉换行**，把 `$tailCount` 注释掉 | 稳态/峰值计算级联崩溃（评审用 `ReadAllLines(936)` 复现） | 全文件改为**纯 ASCII**（注释改英文并写明为什么必须保持 ASCII）；`Parser::ParseFile` 通过；实跑 `-RootName powershell.exe` 得到正确的 steady/peak/比值 |

### 重要级（已修）

| 发现 | 处置 |
| --- | --- |
| 元数据快照判据是**同义反复**：语料把同一个事件对象引用传了 500 次，`envelopes.map(e => e.event)` 天然去重成一个，**删掉 intern 也 PASS** | 语料改为每行一个独立对象（内容相同、引用不同），并把「注释掉 intern 立刻 FAIL 500.15×」写进 README 作为它会失败的证据（已实测） |
| 读数**分子分母单位不一致**（分子 UTF-16 两字节/字符，分母是字符数）⇒ 比值虚高约 2×（0.432× 实为 ~0.22 份载荷，1.2× 阈值实为 ~2.4 份） | 估值器按 V8 实际表示计（Latin1 1 字节/单位、非 Latin1 2 字节/单位）；表中数字改为校准后读数（0.235× / 1.34× / 1.15×），并把这条写进 README「别读错」 |
| 判据**只量文档、不含 fold.log**，而记录用它的数据声称「驻留问题已解决」 | 记录与 README 都把措辞收窄到**文档口径**，并写明会话口径（文档 + fold.log）**未解决**、归 #380；这是本批最需要防误读的一处 |
| `data-timeline-payload="full"` 逃生口只在 `bind` 求值一次 ⇒ 对会话中途挂上的属性不可达（与提交信息里「现场抢救」的说法不符） | 改为**每次折页**求值（一次 `querySelector` 相对整页投影可忽略）；`data-typed-payload-cap` 本来就是每次 invoke 求值 |

### 轻微级（已修 / 已在代码里写明）

- `narrowTimelineData` 对显式 `null` 的嵌套值改走「省略」分支（`Object.entries(null)` 会抛）。
- 分页装载与一次性装载的已知差异（`binding.buffered` 走第二次 foldPage、按到达序）写进代码注释。
- `withoutEnvelopeRaw` 的**恒等不变量**写进文档注释：reject 用 `item !== rejected.envelope` 剔除，
  依赖它原样返回同一对象（若乐观信封将来带 `raw`，那边会静默漏删）。
- `listJournalPages` 的契约（按序 await、**恰好最后一页**传 `lastPage: true`、空 journal 也要传）
  写进接口注释——自定义实现漏掉它等于静默丢草稿并把半份文档发布成 ready。
- `proc-tree.ps1`：根进程中途退出不再丢弃整轮（记缺口样本继续）；多实例匹配时打印
  pids 警告并提示用 `-RootPid` 隔离。
- 记录的「测试处置」表补齐三处签名/替身适配（两个 sink 测试 + `revive_tests.rs`）；
  「既有红灯」条目更新（#371 的审查修复已把当时那两条修绿，另有一条同源的 `sidebarMode`）。

### 评审确认无法证伪的（对抗后仍成立）

- 「就地冻结安全」：评审在整个 `src/` 里搜遍载荷字段的写入点（`push/splice/sort/reverse/Object.assign/索引写`）、
  时间轴/活动全部消费者、运行时冻结与快照路径、echo/乐观路径、`upsertActivity`/`mergeToolActivity`/
  `refreshOrphans`/`withOptionValue`，未找到写入点；别名检查也确认规范化器一律重建容器，没有把
  规范行/wire 对象别名进冻结载荷。
- 「`timeline.data` 收窄不丢被读的字段」：穷举 `entry.data` 的生产读者只有三种 session 族读法
  （`workbenchProjector` 终态判定、`WorkbenchDocumentSurface.solid.tsx` 协商守卫、会话宿主
  replay 守卫），tool/activity 族无读者；`payloadKeys` 无消费者。
- 「收口只在 service 层 ⇒ L3 trim 的 sha256 重折不受影响」：`rollup_trim → trim_one_unit →
  query_event_rows → fold_turn_rows` 全程走 repo 层全文；`latest_event_of_type`、`export_raw_event`、
  ingest 各路径均不经过收口出口。
- 「`fold::DeltaRun` 重构行为等价」：评审逐行比对旧实现（identity 与 run 首行比较的传递性、
  预算记账、`flush_delta_run` 实参、单行 run、`.batch` 不二次折叠）均一致。
- 「intern 正确性」：无 `WeakMap`/引用相等的快速路径会因共享事件对象而分叉；事件不含 owner/sequence
  信息；缓存 `clear()` 驱逐只降低去重率、不影响正确性。
- 「reject 重建仍正确」：`fold.log` 只有一个推入点且包着 `withoutEnvelopeRaw`，重置点四处齐备，
  echo.reject 只读 event/identity/sequence/coverage/provenance。

### 评审未能独立复现的（如实登记）

`cargo test -p pylon-session --lib` 的 167 passed、`bun run test` 的 654 文件 / 5030 passed、
`check:ipc` 的 228↔159：评审为避免往共享树写构建产物而未重跑；本记录里的这些数字来自本机实跑。
本轮的修复改动之后本机重跑：`cargo test -p pylon-session --lib` **171 passed**（新增 6 条：
分页两条 + 收口两条 + 既有的分页/收口各若干），`bun run test` **656 文件 / 5041 passed 全绿**
（评审时那两条 #371 注册表红灯已由 `088a5096` 修绿），`bun run perf-bench:memory` 四条判据全过
（0.235× / 1.34× / 1.15×）。

---

## 裁决轮（2026-09-27 仓库主裁定）

四项待裁决事项的裁定与处置——**裁定权归仓库主**，以下只登记裁定内容与本批的落法：

| 事项 | 裁定 | 本批处置 |
| --- | --- | --- |
| 页签保活 | **保持现状**：不推翻被集成测试钉住的 keep-alive 契约 | 代码与测试均不动；冲突证据保留在「遗留 4」备查 |
| `timeline.data` 收窄口径 | **按「标量身份面」定档**：长度规则成立，插件/renderer 不依赖 `timeline.data` 载载荷 | 渲染引擎唯一入口台账那条从「C12 剥敏面」升格为**有字段面的契约**——新增约束 **K20** + 2026-09-27 登记条目（仓外 `Docs/Archive/渲染引擎施工/00-唯一入口台账.md`）；仓内 `docs/说明书/Pylon-模块维护地图.md` 的领域行同步指向 K20 |
| 会话口径两处禁区（`#380`） | **两项都放行**：①允许折叠方案版本化（`TURN_UNIT_FOLD_SCHEME`）以扩展工具拍折叠；②允许 `fold.log` 只留 `eventId`、reject 回滚改按需从 journal 重读 | `#380` 由「登记待裁」转为可施工，按刀序继续 |
| 绝对 MB 阈值 | **不靠猜**：用项目自带 MCP 对实机做合成注入取数 | 见下节「实机验收（裁决 #4）」 |

口径澄清一条（防后人误引）：`#380` 正文早期引用的 `4.051× → 0.432×` 是**校准前**的旧尺数字
（当时分子一律按 UTF-16 两字节记账，把比值抬高约 2×）。以记录/README/`bun run perf-bench:memory`
现读为准：`2.046× → 0.235×`、`6.81× → 1.34×`、`500.15× → 1.15×`。该 issue 正文已就地更正。

## 实机验收（裁决 #4：真实进程 + 合成注入）

**配方**：本仓源码构建的 debug 二进制 → 隔离副本（portable `data/` + 独立 `WEBVIEW2_USER_DATA_FOLDER`
+ 内置调试端口 9222）→ 页面内用应用自己的写路径注入合成语料 → 采样器量进程树。注入语料与记录
上一轮**逐字同形**：`100` 张卡 × `20` 拍 × 终值 `60 KB`（cumulative）⇒ **2203 事件 / Σ载荷 61.52 MB**
（注入回执实测 `events:2203, payloadMB:61.52, ms:14854`）。采样用本仓交付物
`scripts/perf-bench/proc-tree.ps1`（500 ms 粒度），驱动脚本沿用上一轮仓外 `G:\TEMP\pylon-mem-probe\`
（新增 `measure.js` / `pagedLoad.ts` / `gc.ts`）。

**两条走法的对照**（同一进程、同一语料；「一次性」是把 `limit` 拉满的**反事实**——批次前的读口语义；
「分页」是前端 `listJournalPages` 的实际走法，256 行/页）：

| 读数 | 一次性全量（反事实） | 分页续读（本批实际走法） | 判据 |
| --- | --- | --- | --- |
| 取回事件数 / 页数 | 2000 / 1 次 invoke（游标未到末尾） | **2203 / 9 页** | 分页覆盖全量 |
| 单次 IPC 载荷 | 113.77 MB | 每页 ≤ **14.81 MB** | — |
| 页面 JS 堆瞬态 | **464 MB**（7.5×Σ） | 每页 GC 后**恒为 7.6 MB**（基线 7.5） | 冷装载峰 ≤3×Σ |
| `pylon.exe` 峰 / 稳 | **1124.3 / ~104 MB（10.8×）** | **168.3 / 112.3 MB（1.50×）** | 宿主峰 ≤2×稳 |
| renderer 组峰 / 稳 | **1361.4 / 424 MB（3.2×）** | **590.7 / 477.5 MB（1.24×）** | renderer 峰 ≤2×稳 |
| 进程树峰 / 稳 | **1820.7 / 528 MB（3.4×）** | **775.1 / 713.6 MB（1.09×）** | — |

⇒ **本批的读口改动正是峰值来源的那一刀**：单次取回整页会同时抬高宿主序列化、IPC 与渲染解析
（峰 1820.7 MB，量级与上一轮 2638.3 MB 的结论一致）；换成 256 行/页续折后，宿主与 renderer 的
峰/稳比值分别落到 **1.50× / 1.24×**，两条 ≤2× 判据在真机上通过。页面侧每页 GC 后驻留恒为 7.6 MB
（0.124×Σ），即分页路径在渲染进程里不累积。

**如实标注（这几条别误读）**：

1. 本轮**没有**绑上会话页（见下方遗留：sheet 绑定在本 rig 里没能驱动起来），所以量的是
   *读口 + IPC + 解析* 这条链，**不含**渲染器把文档折出来那一份驻留——那份由纯函数 memory 域
   覆盖（文档口径 0.235×）。因此上表**不能**当作「整会话驻留」的读数。
2. **单行 IPC 字节 ≤ 逻辑载荷 ×1.2 这条未达成**，且这是设计使然：一行同时带 `typed_payload` 与
   `raw_payload` 两份表示，本语料实测 **1.85×**（一次性）/ **2.04×**（分页）。#376-a 收的是
   「超 64 KiB 的那条尾巴」，不是去掉第二份（裁决已确认完全不下发 typed 不可行）。
3. 本语料单拍最大 61 KB < 64 KiB ⇒ **收口阈值本身没被这次注入触发**（触发它的是记录里 400 KB 的
   边界单测）。
4. 「一次性」列标为反事实：读口对超大 `limit` 内部会**截到约 2000 行并给游标**（不是真的一次全量）。

**过程中发现的阻塞（与本批无关，已登记 issue）**：HEAD 的 `init_tracing()` 在**日志根可写**时
必然 panic —— `lib.rs:679` 把带 `.with_filter(...)` 的层挂到 `fmt::Subscriber` 基底上，而
`tracing-subscriber` 对 `fmt::Subscriber` 的 `register_filter` 是默认实现（`registry/mod.rs:149`
直接 panic），**与 profile 无关**。后果：任何人从当前分支构建 release 都会**启动即崩**；本轮
debug 二进制是靠「让日志根不可写」（portable 目录里把 `data/logs` 占成文件 + `APPDATA` 指向不可写
路径）才跑起来的。发行包二进制（Sep 26 15:01）早于该提交，所以线上还没暴露。
