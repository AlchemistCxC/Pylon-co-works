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
  → `d3c7cef0`（memory 域）→ `91da068f`（rustfmt）
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
| 冷装载文档驻留 / Σ逻辑载荷 | ≤ 1.2× | 4.051× | **0.432×** | PASS |
| 拍数敏感性（同终值内容，绝对驻留）5→40 拍 | ≤ 1.5× | 6.82× | **1.20×** | PASS |

对照档的 6.82× 与调查报告的实机 6.3× 吻合，说明这把尺子对得上当时的读数。

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

**未修改**：`agentWorkbenchSession.batch.test.ts` 等 30 余处注入 `loadAll` 的行为测试**逐字未动**
（装载缝优先级保证它们仍走一次性读）。

**两条既有红灯（与本批无关，供核）**：`scripts/sheetRegistry.compat.test.mts` 与
`scripts/sheetState.compat.test.mts` 断言 sheet 注册表为 10 类，实际 11 类——第 11 类是
`f959b48c`（#371 Docs Sheet）新增的 `docs`，两处断言未随迁。

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

**共享工作树注意**：本批在 `kumo/prometheus` 共享树上施工，与他人在途域（#348/#349、#361-363、
#356、#371/#372）交错。所有提交经**私有 index**（`GIT_INDEX_FILE`）落到历史，不触碰共享
`.git/index`；`session/mod.rs` 与 #361-363 改同一文件，提交时按 hunk 分账（只取含 `#376` 标记的
hunk）。中途观测到共享 index 被外部操作置为陈旧（一度把我的文件显示成 staged 删除），已按路径
修复为与 HEAD 一致，未触碰他人 staged 内容。

## 遗留（未做 / 需裁决）

1. **#375-b 工具拍折叠（未做）**：要动 `turn.unit` 的 segment 形状或新增一种 batch 行展开路径，
   落进「不动 `turn.unit` wire 形状」与「不新增事件类型」的禁区夹缝里；而它要治的**驻留**问题
   已由本批的 #375-a/c/e 解决（拍数敏感性 6.82× → 1.20×），剩下的收益是 IPC 行数与折叠耗时。
   已按 AGENTS §2.5 在 PR 描述里登记为后续 issue，不关闭 #375。
2. **#375-d 同内容元数据快照去重（未做）**：`session.commands-updated`（实测单条 16 KB、
   每回合 1–2 次、claude-code 会话里有连续 5 行完全相同）与 `session.config-updated` 仍是每回合
   各存一份。按 500 回合估 ≈16 MB，量级远小于本批已治的项；要做需要事件对象级的内容哈希 intern，
   属独立改动。
3. **`timeline.data` 收窄的白名单范围需仓库主裁决**（spec 未决问题 2）：本批先按「长度 ≤512 的
   标量 + 一层内嵌对象的短标量」定档，并给出 `data-timeline-payload="full"` 逃生口。渲染引擎那条
   唯一入口台账（`CONTEXT.md` 指向仓外 `Docs/Archive/渲染引擎施工/00-唯一入口台账.md`）里
   `timeline.data` 只被登记为**剥敏面**，没有字段白名单，故本批按「保留标量身份面」保守处理。
4. **页签保活上限（未做，spec 未决问题 3，§8 的产品裁决项）**：未改 `SheetLayout` 的 keep-alive。
   非活动页签仍各持一套 runtime/文档/DOM，「按页签数成倍放大」的性质**未变**，只是每个页签的
   基线降下来了。`#234` 实测冷挂载首行 15 ms / 结算 731 ms 是「卸得起」的依据。
5. **`fold.log` 只留 eventId + 回滚按需重读（未做）**：本批只剥掉了 `raw`，`event` 仍留着
   （回滚重折是同步路径）。要走到底需把 reject 回滚改成异步按需重读并复核乐观行剔除的时序
   （spec 未决问题 4）。
6. **绝对 MB 级验收未做**：本批仍是比值口径（记录 §7 的如实标注不变——2 GB 峰值只在
   「工具输出经 `tool_call_update` 流式回传」的 provider 上出现，本机 provider 不在其中）。
   实机复跑用 `scripts/perf-bench/proc-tree.ps1` + README 的隔离副本/注入配方。
7. **V8 支配树归因未补**：本批给出的是纯函数分桶（见「证据」），仍不是 V8 支配树证据。
