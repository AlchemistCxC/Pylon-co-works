# Dev Record — #234 / #236 实机验收 + 整应用内存探针

> 入库保留。用户当轮指令：构建最新版本替换 `F:\A-I\Platform\Pylon` 的实例，用 MCP 服务器实机验收，
> 并撰写内存探针研究整应用内存在「切换会话 / 投影 / 流式输出」下的变动；准许发送真实 prompt。

## 元信息

- 日期：2026-09-22
- 构建来源：`github/main` @ `94d88ede`（PR #235 合并点）——与本机工作树 `Ru5t/Reflector` @ `617405f3`
  内容一致（`git diff --stat github/main HEAD` 为空），故在工作树上构建等同构建已合入的 main
- 构建命令：`bun run release:portable`（= build + build:plugin-sdk + `tauri build --no-bundle` +
  `cargo build --release --bin pylon-detect` + webview2-mcp + `pack_release.py`）
  → `release/pylon-0.2.6-Abc-win64.zip`（42,123,129 B；manifest 242 项；verify OK）
- 实例：`F:\A-I\Platform\Pylon`（portable；`portable.flag`）
- 宿主：WebView2 / `Edg/153.0.4234.48`，协议 1.3，V8 15.3.12.7
- 调试端口：`tauri.conf.json` 的 `additionalBrowserArgs` 已内置 `--remote-debugging-port=9222
  --remote-allow-origins=*`（启动时同时设了同名环境变量，两条路径都指向 9222）
- 真实 Agent：Hermes（`riccati` profile），模型 `deepseek/deepseek-v4.1-flash`

## 一、实例替换（可核对的守恒量）

只替换二进制与资源，**实况数据与真实配置一律不动**。替换前后 md5 比对：

| 项 | 替换前 md5 | 替换后 md5 | 结论 |
| --- | --- | --- | --- |
| `data/pylon-data-v1.sqlite3`（实况库） | `73e898ef45…` | `73e898ef45…` | ✅ 未变 |
| `agents.yaml`（真实配置） | `13a033de17…` | `13a033de17…` | ✅ 未变（包内只有 `agents.example.yaml`，同名文件不在包内） |
| `pylon.exe` | 52,996,096 B / 09-22 01:04 | **35,897,856 B / 09-22 12:52** | ✅ 已换新 |

替换方式：解 ZIP 到暂存目录后用 `os.walk` 复制 242 个文件（顶层 `data/` 与 `agents.yaml` 显式跳过）。
**踩到的坑**：Git Bash 会把 robocopy 的 `/E` 改写成路径 `E:/`（报「无效参数 #3」）→ 改用 Python 复制。

启动后后端日志自证 portable 模式与数据面：
```
portable data dir active: F:\A-I\Platform\Pylon\data            (prism_desktop_lib::paths)
Kernel persistence services ready: …\data\pylon-data-v1.sqlite3  (prism_desktop_lib)
```

## 二、MCP 链路七步自检（全部通过）

| 步骤 | 结果 |
| --- | --- |
| 1 `webview_targets` | `reachable: true`，1 个 page 目标（`Pylon` / `http://tauri.localhost/`） |
| 2 `1 + 1` | `2` |
| 3 `typeof window.__TAURI_INTERNALS__.invoke` | `"function"`（CDP 通道通 + Tauri 接口语义未坏） |
| 4 `tauri_window_state` | `tauriHostAvailable: true`，`hostErrorCount: 0`，`hostErrors: {}` |
| 5 `tauri_invoke list_runtime_logs` | `ok: true`，返回日志数组 |
| 6 `webview_screenshot` | 可读（设置页 / 工作台 / 会话列表均正常渲染） |
| 7 `webview_snapshot` + 点 `ref` | 快照返回角色+名字+ref；点击返回 `hitIsSelfOrDescendant: true` |

另：`__PYLON_KERNEL_DEV__` 存在（`typeof === 'object'`），诊断桥可用。

## 三、#236 验收：删掉 wasm `scopeForLanguage` 后高亮仍工作

**判据**：真实渲染里代码块必须出 `pl-*` span（生产高亮走 TS 语言门 + wasm `highlightBlock`，
与被删的 `scopeForLanguage` 出口无关）。

| 观察 | 数值 |
| --- | --- |
| 载入大会话后，旧内容的代码块 span 数 | **1,444**（3 个 `.term-code-block`） |
| 流式新回答的代码块（视口外） | `spans: 0` —— **这是 #221 的设计**：视口外块降级为纯文本，span 树不常驻 |
| 把该块滚进视口后再测 | **`spans: 375`**（同一块，进视口即触发高亮） |
| `[data-highlight-lifecycle="off"]` 杀停开关 | 0 个（机制在正常工作，不是被关掉） |

⇒ 高亮对新旧内容都工作；视口外为 0 是 #221 的**预期行为**而非 #236 回归。
（旁证：全页 span 数会随滚动在 375 ↔ 1444 之间变化，正是「降级/恢复跟随视口」的形态。）

**未能做的核对（如实标注）**：想在二进制层直接证「新 exe 里没有 `scopeForLanguage`」，
但前端资源在 exe 内是**压缩**的（`grep -a` 连 `highlightBlock` 都搜不到），所以只能靠
源码级核对（`src/wasm/pylon-markdown/pylon_markdown.d.ts` 已无该导出）+ 上面的运行时行为。

## 四、#234 验收：大会话切回的冷重放（投影路径）

**判据**：① 渲染正确（内容保真、无卡死骨架、无行碎裂）；② 成本可接受。

目标会话 `local:smu9d42je`（后端 trace：`canonical_revision 37592`）。

后端 `session/load replay trace`（id 31）：
```
owner ["riccati","hermes","local:smu9d42je"]  observed_count 18  retained_count 18  dropped_count 0
authority local-journal  commit_outcome local-journal-wins  journal_status local-authoritative
projection_commit deferred-to-frontend-coordinator
```
⇒ 18 行进、18 行留、0 丢；**#205/#226 读侧折叠把 37,592 的 sequence 空间压成 18 行下发**。

前端（探针锚在 `pointerdown`，故不含我的工具往返延迟）：

| 切换目标 | 首行出现 | 结算（300ms 无变更） | 结果 |
| --- | --- | --- | --- |
| `session-mu9d42je`（首次，大会话） | **15.3ms** | **731ms** | rows 3→13、chars 754→**34,099**、span 1444、**skeleton 0** |
| `session-mu9d42je`（第 3 次，复跑） | **20.0ms** | **717.6ms** | rows→18、chars→46,521（含我新增的两轮）、skeleton 0 |
| `session-mu99oxqw`（小会话） | 33.4ms | 359.8ms | rows→3、chars→754、heap 16.4→14.2（**旧会话的堆被释放**） |
| `session-mub4qux1` | 50.3ms | 414.5ms | rows→5、chars→1,009 |

**行碎裂判据**（issue #55 的健康值）：诊断 `rowSet` = `{ rows: 43, textParagraphs: 43,
rowsPerTextLength: 1, maxRowsPerTextLength: 1 }` ⇒ **每段文本恰好 1 行**（#55 症状当时是 117 块对 55 段）。
各长行 `tinyRows` 为 0（两条长行各 1）。

⇒ 投影路径**正确且亚秒级**（首次冷重放 731ms 结算，首行 15ms），无卡死骨架、无碎裂、无重复行。

## 五、流式回合诊断读数（真实 prompt，两轮）

| 读数 | 回合 #1（30 步推导 + 两个实现，回答 12,128 字） | 回合 #2（一句话） |
| --- | --- | --- |
| `parseCost.parsed` / `parseMs` | 1162 / 234ms（均值 0.20ms，`maxParseMs` 8） | — |
| `parseCost.cacheHits` / `grafted` / `skipped` | 4740 / **224** / 0 | — |
| `parseCost.maxTextLength` | 16,599 | — |
| `publishCost` | `maxMs 5.5`、`p95Ms 5`、`lastMs 4`（samples 64） | — |
| `snapshot.publishes` / `budgeted` / `whole` / `terminal` | **2369 / 2352 / 17 / 1** | — |
| `snapshot.catchUpWindows` / `growingRows` / `history` | 4 / 2 / 3 | — |
| `recentPublicationIntervalsMs` | ~17.3–18.3ms ⇒ **约 55–58 次发布/秒**（对齐 60fps） | — |

解读：D1/D2 的「按预算逐拍揭示」在生产里确实在跑（2352 次 budgeted），推平滑（发布间隔贴合帧）；
graft 命中 224 次（#150 的纯文本拼接路径在真机上**有**命中）；`publishCost` 峰值 5.5ms 远在
16.67ms 帧预算内。Agent 侧：`API call #1 … latency=83.7s out=10907 cache=65536/65803 (100%)`，
`Turn ended: reason=text_response(finish_reason=stop)`；期间有 1 次 `APITimeoutError` 自动重试成功（端点抖动，非本仓问题）。

## 六、内存研究（探针 + 阶段表）

探针：`G:\TEMP\mem-probe.ps1`（500ms 一轮，按 `ParentProcessId` 展开 `pylon.exe` 整棵进程树，
按进程名分三组记 `WorkingSet64` 与 `PrivateMemorySize64`）。**脚本不入库**（一次性探针，同记录 208 的处置）；
形状如下，可直接复用：

```powershell
# 关键三步：① 取根 ② 用 CIM 按 ParentProcessId 展开后代 ③ Get-Process 累加工作集
$roots = @(Get-Process -Name 'pylon' -EA SilentlyContinue | % Id)
$all   = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
# 分组：pylon.exe → app；msedgewebview2.exe → renderer；其余子进程 → agent
powershell -NoProfile -ExecutionPolicy Bypass -File G:\TEMP\mem-probe.ps1 -IntervalMs 500 -Out G:\TEMP\mem-app.csv
```
> **踩到的坑**：Git Bash 会吃掉 `-File G:\TEMP\…` 的反斜杠（变 `G:TEMP…`）；且 Windows PowerShell 5.1
> 按 ANSI 读 `.ps1`，**UTF-8 无 BOM 的中文注释会解析失败**（报「缺少右 }」）⇒ 脚本需存成 **UTF-8 with BOM**。
> 另：PowerShell 在 `return` 时会把 `HashSet` 摊平，取回后要 `@()` 包住再喂 `Get-Process -Id`。

工作集（ws）峰值，1,651 轮采样：

| 阶段 | app | agent | renderer（6 进程族） |
| --- | --- | --- | --- |
| 启动基线（空会话） | 49.8 | 94.8 | 461.3 |
| 打开工作台（新建空会话） | 52.5 | 189.7 | 483.0 |
| **载入大会话后静置** | 66.5 | 180.5 | **647.1** |
| **流式回合 #1（12k 字）** | **92.3** | 196.7 | **816.4** |
| 回合后静置 | 73.6 | 196.8 | 751.7 |
| 流式回合 #2（短） | 68.9 | 196.8 | **673.8** |
| 切会话循环 + 回落 | 75.4 | 197.1 | 704.2 |

全程峰值：app **92.3**（13:01:34）、agent 197.2、renderer **816.4**（13:01:31）——都落在流式回合内。

**判定：瞬时 churn，不是泄漏。** 三条独立证据：

1. **回合 #2 几乎不再抬峰**：renderer 峰值 675.9（回合 #1 是 816.4）、app 69.3（vs 92.3）；
   JS 堆只 +0.3MB（21.6→21.9），DOM 只 +17 节点。若是泄漏，第二轮应再抬一个量级。
2. **强制 GC 后的保留地板是稳定的**：CDP `HeapProfiler.collectGarbage` 前后
   JS 堆 **28.2 → 20.2MB**；再走一轮「切走→切回→GC」后地板 **20.5MB**（DOM 完全相同：4439 节点/18 行/46,521 字符）。
   ⇒ 切会话**没有逐步留存**，之前的「缓慢上爬」是尚未回收的垃圾。
3. **回合后自行回落**：renderer 816.4 → 751.7 → 673.8（无操作下的自然回落），
   app 92.3 → 68.9。与记录 208「回合结束后进程族自回落」同形。

**如实标注限制**：`performance.memory` 与进程工作集都受 GC 时机影响，我没有做「多轮对照 +
固定 GC 点」的严格采样；三条证据里第 2 条（GC 地板）最硬，第 1/3 条是形态证据。
另：切会话循环里 renderer 在 668–704MB 间波动（约 36MB 带宽）属 WebView2 内部缓存与 GC 时机，
不构成「每次切换留存」——GC 地板未随切换上移已经否掉了后者。

## 七、复现命令

```bash
# 1) 构建并替换实例（保留 data/ 与 agents.yaml）
bun run release:portable
python -c "import zipfile;zipfile.ZipFile(r'release/pylon-0.2.6-Abc-win64.zip').extractall(r'G:/TEMP/pylon-new')"
# 用 os.walk 复制 G:/TEMP/pylon-new/pylon-0.2.6-Abc-win64 → F:/A-I/Platform/Pylon，跳过顶层 data/ 与 agents.yaml
# 2) 带调试端口启动（本仓 tauri.conf 已内置 9222）
cd F:/A-I/Platform/Pylon && WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*" ./pylon.exe
# 3) 内存采样（UTF-8 with BOM 存盘）
powershell -NoProfile -ExecutionPolicy Bypass -File G:/TEMP/mem-probe.ps1 -IntervalMs 500 -Out G:/TEMP/mem-app.csv
# 4) 切换/流式：MCP 侧用 webview_snapshot 取 ref → webview_click；composer 用 webview_type（ref e1）
#    切换耗时用「pointerdown 锚点 + MutationObserver」页面探针量（见正文口径）
# 5) 泄漏判据：webview_raw_cdp HeapProfiler.collectGarbage → 再读 performance.memory
```

## 八、未解问题

1. **二进制级核对不了**：前端资源在 exe 内压缩，无法用字符串搜证「新构建确实含/不含某符号」。
   若以后需要「构建物证」，可在 `pack_release.py` 的 manifest 里写入 git sha 与 wasm 产物哈希。
2. **无 A/B 对照**：实例里没有旧版本二进制（`backup-round3` 只有 data），所以 #234 的
   「投影提速」在本轮只有 bench 读数（`scripts/perf-bench.mts` 的 `projector` 域）+ 生产路径的
   绝对耗时（731ms/会话），没有真机前后对比。要做 A/B 需另建一份旧二进制实例（换端口并行）。
3. **视口外高亮为 0 是设计**（#221），但「长回答里代码块在视口外时读起来是纯文本」这个观感
   值得产品侧知悉——本轮只登记，不判优劣。
4. **端点抖动**：本轮出现 1 次 `APITimeoutError` 后自动重试成功（`api.commandcode.ai`），
   与仓库代码无关，仅记录以免后人误判。
