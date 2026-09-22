# Dev Record — #240 渲染器内存开销分布调查（语法资产 ~30%、不可归还）

> 入库保留。用户当轮指令：用 MCP + 探针细致探查渲染器内存开销分布，从而定位并修复。
> 本轮交付**定位**（含可复现装置与两条独立证据链）；修复选项已列进 #240，待裁决。

## 元信息

- 日期：2026-09-22
- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/240（bug；assignee AlchemistCxC）
- 实例：`F:\A-I\Platform\Pylon`（`github/main@94d88ede` 构建，即 PR #235 合并点）
- 宿主：WebView2 `Edg/153.0.4234.48`；调试端口 9222
- 方法：MCP（`webview_raw_cdp` / `webview_evaluate` / `webview_scroll` / `webview_type`）+ per-PID PowerShell 探针

## 一、研究方法（四层，缺一层就会得出错误结论）

| 步 | 探针 | 回答的问题 |
| --- | --- | --- |
| 1 | `Get-CimInstance Win32_Process` 读 `--type=` + per-PID 采样 | **哪个进程**、什么角色（renderer / gpu-process / browser / utility / crashpad） |
| 2 | CDP `Runtime.getHeapUsage`、`Memory.getDOMCounters`、`Performance.getMetrics` | JS 堆、DOM 节点/监听器、布局对象、ArrayBuffer |
| 3 | CDP `HeapProfiler.startSampling` / `stopSampling` | **谁在分配**（采样，不是快照——快照几百 MB 过不了 MCP） |
| 4 | 视口触发差分（滚入视口 → 读进程 private 台阶） | **WASM 线性内存**（JS 侧计数器对它失明，只能差分） |

**关键教训（第 4 步为什么必须存在）**：CDP 的 JS 计数器对 wasm 线性内存**完全失明**——
空会话与高亮过 4 个语言之后，`Runtime.getHeapUsage.backingStorageSize` **逐字节相同**（2,748,985）、
`Performance.getMetrics.ArrayBufferContents` 恒为 0、`usedSize` 只有 16.7MB。
只看 JS 堆会得出「内存一切正常」的假象。

## 二、进程角色归属（pylon 的整棵进程树）

用 `--type=` 把 6 个 `msedgewebview2` 分开（os 侧命令行，`SystemInfo.getProcessInfo` 在页面 target 上不可用）：

| 角色 | PID | ws | private |
| --- | --- | --- | --- |
| **renderer（我们的页面）** | 7120 | **251.0** | **193.4** |
| gpu-process | 26720 | 120.3 | 172.3 |
| browser | 31740 | 130.3 | 45.7 |
| utility（network） | 19064 | 35.3 | 12.8 |
| utility（storage） | 22644 | 19.3 | 8.4 |
| crashpad-handler | 29896 | 14.1 | 3.2 |
| **合计（renderer 族）** | | **570.3** | **435.8** |

⇒ 内存主战场是**一个** 251MB 的 renderer 进程；GPU/browser 那些不是我们的 JS/DOM。
这一步排除了「把 GPU 进程算进渲染器开销」的常见误判。

## 三、分布（主渲染器 GC 后 private ≈ 248MB）

| 部分 | 量 | 占比 | 可归我们处置 |
| --- | --- | --- | --- |
| WebView2 / Chromium 载体（V8 isolate、Blink、代码段、缓存） | ~153MB | 62% | 否 |
| **wasm 语法资产**（ts + python + css + go） | **~78MB** | **31%** | **是** |
| JS 堆（`usedSize` 16.7MB）+ DOM（7,409 节点 / 2 文档 / 255 监听器） | ~17MB | 7% | 是，但已小 |

DOM 侧**已经不是问题**：#221 之后 span 树随视口降级/恢复（实测全页 span 在 48 ↔ 1444 之间变化），
34k–49k 字符的会话只有 7.4k DOM 节点。

## 四、语法资产的逐语言代价（两条独立证据链）

**链 A：真机差分**（滚入视口触发该语言首次编译，看 private 台阶）

| 触发 | 前 | 后 | 台阶 |
| --- | --- | --- | --- |
| ` ```css ` 块入视口（94 span 落地） | 206.7MB | **251.4 → 稳定 248.5** | **+42.0MB** |
| ` ```go ` 块入视口（48 span 落地） | 262.2MB | 266.6 → 稳定 263.7 | **+1.4MB** |

参考基准：主渲染器 private 在**不动的状态下** 20 轮波动仅 1.4MB（192.5–193.9），
所以几十 MB 的台阶不是噪声。

**链 B：`scripts/perf-bench.mts` 的逐语言「核线性Δ」**（独立进程、独立装置）：
css **+35.5**、ts **+31.5**、js +5.06、python +3.19、go **+1.94**、bash +1.5、rust +1.06、json +0.45（MB）。

两条链的量级与相对次序一致 ⇒ **css 最贵、go 最便宜**这个排序是可信的。

## 五、机制（读代码定位）

`src-tauri/pylon-markdown/src/highlight.rs:168`：
```rust
/// 每个语法一个槽位：首次用到该语言时才把 tmLanguage 转成 SyntaxSet
static ENGINE_SLOTS: LazyLock<Vec<OnceLock<SyntaxSet>>> =
    LazyLock::new(|| GRAMMAR_ASSETS.iter().map(|_| OnceLock::new()).collect());
```
14 个 vendored 语法各占一个 `'static` `OnceLock<SyntaxSet>`；`build_engine()` 把 tmLanguage JSON
编译成 `SyntaxSet`（正则程序），**没有任何释放/驱逐路径**；叠加 wasm 线性内存只涨不跌
⇒ 用过的语言永久占用，切会话/关会话都不减。

**永久性证明**：CDP `HeapProfiler.collectGarbage` 后 private 从 263.7 只降到 **~248.4**
（回收的只是流式 churn），语法那部分**纹丝不动**。

## 六、异常点（最值得先查）

| 语言 | JSON | 编译后 | 每 KB |
| --- | --- | --- | --- |
| go | 12KB | 1.4–1.9MB | ~0.15MB/KB |
| python | 76KB | 3.2MB | ~0.04MB/KB |
| ts | 212KB | 31.5MB | ~0.15MB/KB |
| **css** | **56KB** | **35–42MB** | **~0.7MB/KB** |

css 的每 KB 代价是 python 的 ~17×——不像「语法大所以贵」，更像**编译病理放大**。
另：`source.ts.json`(212KB) 与 `source.tsx.json`(208KB) 近乎重复，两者都用到是两份独立
`SyntaxSet`（≈60MB）。vendored 集共 **14 个文件 / 728KB**。

## 七、分配采样（第 3 步的结果，说明 churn 长什么样）

滚动触发降级/恢复期间的分配热点（`HeapProfiler.startSampling` → 滚动 → `stopSampling`）：

| 分配点 | selfSize | 归属 |
| --- | --- | --- |
| `codeHighlight-*.js` 的 `join` | **99,452** | 高亮结果拼成整块 HTML 串（`highlightCodeUncached`） |
| `AnsiBlock.solid-*.js` 的 `onExit` / `children` / `get when` / `get fallback` | 32,788 / 65,604 / 32,788 / 32,784 | ANSI 工具输出的降级/恢复路径 |
| `htmlSanitizer-*.js` 的 `O` → `join` | 32,832 | sanitize 的 HTML 拼接 |

⇒ 这些都是**瞬态 churn**（GC 地板稳定），不构成足迹；但说明「每次视口切换」有一次
~100KB（高亮 HTML）+ 若干 32–65KB（ANSI）的分配。若将来要压 GC 压力，这是入口。
（另注：`AnsiBlock` 出现在降级/恢复路径上，而 #221 的记录说 `term-ansi` **未纳入**该机制——值得单独核，本轮只登记。）

## 八、复现命令

```bash
# 0) 实例已在 F:\A-I\Platform\Pylon；带调试端口启动（tauri.conf 已内置 9222）
cd F:/A-I/Platform/Pylon && WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*" ./pylon.exe
# 1) per-PID 探针（脚本须 UTF-8 with BOM；Git Bash 会吃反斜杠，路径用正斜杠）
powershell -NoProfile -ExecutionPolicy Bypass -File "G:/TEMP/mem-pid.ps1" -IntervalMs 1000 -Out "G:/TEMP/mem-pid.csv"
# 2) 角色归属：读 --type=
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | %{ if (\$_.CommandLine -match '--type=([a-zA-Z\-]+)') { \$Matches[1] } }"
# 3) JS 侧计数器（对 wasm 失明，仅作对照）
#    webview_raw_cdp: Runtime.getHeapUsage / Memory.getDOMCounters / Performance.getMetrics
# 4) 语言台阶差分：发一条要 ```<lang> 代码块的 prompt（webview_type 提交）→
#    用 webview_scroll 把该块滚进视口（y = scrollTop + rect.top - 200）→ 读探针里主 renderer 的 private 台阶
# 5) 永久性：webview_raw_cdp HeapProfiler.collectGarbage → 再看 private 是否回落
```

## 九、未解问题

1. **css/ts 的编译放大未定位到具体 pattern**：需要原生侧（非 wasm）profile `build_engine`，
   看是哪个 pattern 让 regex 程序爆炸。这是修复选项里性价比最高的一条，但属**施工**，需先裁决。
2. **`engine_for_scope` 返回 `&'static SyntaxSet`**：改「可驱逐」要改返回形状（句柄/Arc），
   涉及 `highlight.rs` 与 `tm_language.rs` 的借用面——预估是本 issue 里最大的一刀。
3. **`term-ansi` 是否纳入 #221 机制**：#221 记录称未纳入，但分配采样显示 `AnsiBlock` 有
   `onExit`/降级路径。需要单独核一次（可能是 #221 之后新增的），本轮只登记。
4. **建议加只读 `linearMemoryBytes()` 诊断出口**：把这块从「靠进程差分间接推」变成直接读数，
   否则每次回归都要重启实例做差分。属产品代码改动，需开 issue。

## 十、追加：异常点定位（原生侧探针）

用户当轮指令「先查异常点」。原生侧用**计数全局分配器 + bisect**（临时 lib 测试，探针已删，`git status` 干净）。

**口径修正（重要）**：编译出的 `SyntaxSet` **几乎不驻留**（css 编译完只多 0.03MB）。真正的机制是
**编译期峰值 live**——wasm 的 dlmalloc 不归还页、线性内存不能缩，于是峰值被永久留成高水位。

| | css | ts |
| --- | --- | --- |
| 编译期总分配（churn） | 543.60MB | 1796.55MB |
| **编译期峰值 live** | **18.06MB** | **12.67MB** |
| 编译后驻留 | 0.03MB | — |
| 编译时间（release native） | 433ms | 654ms |

真机台阶（css +42MB / ts +31.5MB）对原生峰值是**统一的 ~2.3× 系数**（wasm 碎片 + 高亮本身 + span HTML）。

**css 的罪魁 = 10 条关键字列表**（bisect，release）：

| 变体 | 峰值 | churn | 时间 |
| --- | --- | --- | --- |
| full | 18.06MB | 543.60MB | 433ms |
| 去最长 1 条 | 11.13MB | 337.23MB | 263ms |
| 去最长 3 条 | 4.66MB | 180.41MB | 137ms |
| 去全部 ≥500 字符的 match（10 条） | **2.16MB** | 113.55MB | **81ms** |
| 去全部 ≥200 字符的 match（20 条） | 1.65MB | 71.33MB | 47ms |

那 10 条是 `support.type.property-name.css`（9,919 字符 / 701 分支）、
`support.constant.property-value.css`（4,414 / 448）、`entity.name.tag.css`（2,115 / 268）等关键字表。
**裁掉 → 峰值 −88%、编译时间 −81%。**

**ts 没有单点**：去掉全部 13 条 ≥500 字符的 pattern，峰值只降 12.67 → 12.39MB（−2%）。
ts 的代价摊在整个语法（527 pattern / 9,716 组 / 35,245 字符类字符），要降只能换更轻的 TS 语法。

**被实测否掉的假设**（省后人弯路）：单条巨交替本身不贵（合成 700 分支交替峰值 ≈0、churn 19MB）；
拆开无改善（21 vs 19MB）；`(?i)` 不是乘数；与 JSON 大小不成比例（python 76KB→3.5MB vs css 56KB→18.06MB）；
repository 的 include 不重复编译（1 处 0.42MB vs 10 处 0.45MB）。

**附带发现（时间同源）**：首次用到某语言时编译是**同步**发生在 `highlightCode` 内（wasm 主线程），
release native css 433ms / ts 654ms，wasm 再乘 ~1.5× ⇒ **首次高亮新语言有 ~0.5–1s 主线程阻塞**；
#221 的帧预算调度只能串行化作业之间，单作业内部无法分帧。

**探针形状（可复现）**：临时 lib 测试（能访问私有 `build_engine`）里放计数全局分配器 +
`neuter_longest(json, n, min_len)` 两遍遍历替换最长 match；`measure` 读「峰值 / 分配总量 / 时间」。
`#[global_allocator]` 只认同一个测试二进制 ⇒ 探针必须放 lib 测试模块，集成测试量不到私有函数。
跑法 `cargo test -p pylon-markdown --lib <name> -- --nocapture`（真实时间加 `--release`）。

修复判据与预期收益见 #240 的对应评论；**注意其中「裁剪 css 关键字表」有行为代价，需仓库主裁决。**
