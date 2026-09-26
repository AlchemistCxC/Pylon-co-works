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
