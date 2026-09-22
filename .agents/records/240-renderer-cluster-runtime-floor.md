# Dev Record — #240 续：渲染器簇的内存构成与 WebView2 运行时地板

> #240 定位的是**进程内**的一笔账（语法资产编译峰值，已随 #241 退役）。本条是同一主诉的续查：
> 用户报「渲染器簇的内存开销很高」，要求连**固定必要开销**（WebView 运行时）一起警惕。
> 属**只读探查**：除清掉一次纯缓存目录外，未改产品代码。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/240（已关闭，本条为其续查）
- 实例：`F:\A-I\Platform\Pylon`（便携版，`pylon.exe` 2026-09-22 15:13 构建，版本 `0.2.6-Abc`）
  —— 该构建含 #241 刀1/刀2（Lezer 已切流）；刀3~刀6 只减 wasm 产物体积与高亮 CPU，不改渲染器内存形状
- 运行时：WebView2 `Edg/153.0.4234.48`（`msedge.dll` 磁盘 **332.1 MB**，运行时目录 586 MB）
- 窗口：1216×809，DPI 96，视口 1200×800，DPR 1
- 日期：2026-09-22
- 方法：`tools/webview2-mcp/`（CDP）+ 自制 per-PID 簇探针（PowerShell，读 `WorkingSet64`/`PrivateMemorySize64`，按 `--type=` 归类角色）

## 结论摘要

| 状态 | 簇 WS 合计 | renderer | browser | gpu | utility×2 | crashpad | app(pylon.exe) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **冷启动、无会话** | **515.6** | 153.2 | 130.3 | 113.4 | 54.8 | 9.1 | 54.8（priv 167.2） |
| **页面导航到 `about:blank`** | **517.2** | 130.1 | 135.8 | 120.4 | 57.2 | 11.5 | 62（priv —） |
| 打开会话（内容态） | 557–597 | 168–196 | 135–138 | 120–133 | 57–59 | 11.5 | 62–73（priv 246–267） |
| 最小化窗口 6s 后 | 554.1 | 167.8 | 135.6 | 119.9 | 57.2 | 11.5 | 62 |

**核心结论：这 ~0.5 GB 基本是 WebView2 运行时自身的地板，不是我们的代码。**

三条独立证据：

1. **把页面换成 `about:blank`（我们的 JS/DOM/CSS 全部消失），簇仍有 517 MB**——renderer 168.2 → 130.1 MB，
   即**我们的文档只占 ~38 MB**；空白页强制 GC 后 V8 堆只剩 **0.86 MB**（此前读到的 19.3 MB 是未回收的旧文档垃圾）。
2. **冷启动、未打开任何会话 = 515.6 MB**，与空白页地板（517 MB）在噪声内相等 ⇒ 我们的外壳+空态没有额外开销。
3. **清掉 252 MB profile 缓存后重启：browser 135.4 → 130.3 MB（只差 5 MB）** ⇒ profile 膨胀是磁盘问题，不是 RAM 问题。

**打开会话后我们这一侧的量级**：renderer +15~45 MB（视会话内容），host 进程 commit +80~100 MB（用起来后平台化）。

## 实验与读数

### ① 最小化窗口：几乎不释放（556.9 → 554.1 MB）

Chromium 通常在窗口隐藏时丢弃大部分光栅缓存/合成表面。这里 GPU 只掉 2.8 MB、renderer 掉 0.3 MB。
⇒ 排除「合成器表面/瓦片」作为主因，同时说明**这个运行时不会把已占内存还给系统**（长期驻留 ~0.5 GB 是稳态，不是峰值）。

### ② 空白页隔离：517 MB（决定性）

`Page.navigate` → `about:blank`，等旧文档回收后：renderer 130.1 MB / private 71.2 MB，DOM 3 个元素，JS 堆 0.86 MB。
（注：渲染器**进程被复用**（PID 未变），旧文档的内存要**数秒**才回收——导航后 7s 读到 168.8 MB，之后才落到 130.1 MB。不核这一步会得出错误结论。）

### ③ 强制 GC / purge：无变化

`HeapProfiler.collectGarbage` 后 renderer 168.2 → 170.5 MB（GPU 反而 +13 MB，是活合成器）。
⇒ 既不是 churn，也不是 JS 堆问题（JS 堆仅 17–26 MB，DOM 4229 节点 / 5635 布局对象 / 255 监听器 / 11 个 ArrayBuffer）。

### ④ 切会话 ×10：宿主 commit 阶梯上升后平台化（非泄漏）

| 时刻 | app priv | renderer WS |
| --- | --- | --- |
| 起点 | 257.9 | 200.5 |
| 峰值 | 267.1 | 233.5 |
| 10 次切换后 | 263.8 | 190.3 |

renderer 在 165–196 MB 间随会话内容起伏，**无单调上涨**；宿主 commit 抬 ~6–9 MB 后**平台化**。
⇒ 未观察到无界泄漏；但宿主 commit（167–267 MB）**只涨不落**这一性质值得单独盯（见未解）。

### ⑤ 运行时本体

- `msedge.dll` 磁盘 **332.1 MB**，WebView2 运行时目录 **586 MB**；**7 个进程都映射它**
  （browser 进程报告 image 334 MB，其 WS 130 MB 里相当一部分是这份代码的常驻页）。
- 同机另两个 WebView2 应用（`VocoType`、`io.suyou.suyou`）**无法用作基线**：它们的窗口是
  **16×16 托盘窗口**（视口面积差 3800 倍），WS 已被系统裁剪（browser 42–56 MB、renderer 12–83 MB）。
  一开始我按角色对比得出了「Pylon 每个角色都高 2.4–5 倍」的结论——**那是错的**，已作废。
- 三家的 profile 组件目录完全一致（`component_crx_cache` 22M / `Subresource Filter` 13M / `Speech Recognition` 2.6M）
  ⇒ Edge 组件不是差异来源。

## 发现的两个异常

### A. 发行包内置 CDP 调试端口（需裁决）

`src-tauri/tauri.conf.json:21` 的 `additionalBrowserArgs` 里带
`--remote-debugging-port=9222 --remote-allow-origins=*`，而**本仓只有这一个 tauri 配置**（无 dev/prod 之分），
`pack_release.py` 也不剥离它（它反过来**依赖**这个端口与 `webview2-mcp` 松耦合）。
实测打包版浏览器的完整命令行确认该参数在**发行构建**里生效。

后果：**同机任何进程**都能连 `127.0.0.1:9222` 在窗口里执行任意 JS，而窗口里的 JS 可以调 Tauri IPC
（即读写文件、驱动 agent）= 越过本机权限边界。skill 里那句「只在调试期运行，用完关掉」约束的是**本地构建**，
管不到用户手上的发行包。

### B. profile 缓存膨胀（已清，252 MB 磁盘）

`EBWebView/Default/Cache` 128 MB（959 文件）+ `Default/Code Cache` **124 MB / 5180 文件**。
成因推断：每次换构建，前端 chunk 的哈希文件名都变 ⇒ 新的 HTTP cache 与 code cache 条目累积；
开发期反复替换实例会持续放大。同目录另有 `data/backup-before-purge-20260916` **123 MB**（一次性备份残留）。
处置：已删除两个纯缓存目录（属性是「可自建」，无 Service Worker、无 IndexedDB 依赖），
profile 由 314 MB 降到 62 MB；**对 RAM 无影响**（见实验③的 A/B）。

## 未解与限制

1. **空 renderer 的 130 MB 是否「正常」我没有可信基线**——本机两个 WebView2 应用都是隐藏窗口，WS 被裁剪到不可比。
   要判定需要一台可控的同尺寸空白 WebView2 宿主（另建一个最小 Tauri/WebView2 样例，或把 `about:blank` 装在同样窗口尺寸的独立进程中）。
2. **宿主进程 commit 167–267 MB（WS 仅 55–73 MB，比值 ~3.5×）未拆解**。已排除：无 hermes/node/sqlite 运行时 DLL（46 个模块）、
   活动数据库仅 512 KB、空闲时不再增长。候选：分配器 arena、WebView2 宿主侧共享缓冲、`resources/fonts`（**40 MB**，若启动即全部载入）。
   拆解需要 VMMap 一类工具（本机无）。
3. **crashpad 9.1–11.5 MB**，另两个应用只有 2.3–2.9 MB，其 DB 目录**为空**（无积压 dump）。差异未查明，量级小。
4. **`"transparent": true`（无边框透明窗口）对 GPU 进程的影响未测**：透明窗口可能禁用某些合成快路径。
   验证需要改配置重建做 A/B，本轮未做。
5. 本轮只测了**静态内容与切会话**；未测流式生成期（需真实 prompt）。#234 那轮的记录显示流式期峰值 816 MB（CDP 强制 GC 后地板 20 MB），
   与本轮「运行时地板主导」的结论方向一致。

## 复现命令

```powershell
# 簇探针（按 --type= 归类角色；只读）
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\pylon-cluster.ps1
# 最小化 A/B（含 ShowWindow 6/9）
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\minimize-test.ps1
```

CDP 侧：`Page.navigate` → `about:blank`（隔离我们的文档）→ `HeapProfiler.collectGarbage` → `Runtime.getHeapUsage`
（`backingStorageSize` 是 ArrayBuffer/wasm 内存那一档，正是 #240 当时看不见的那笔）；`Memory.getDOMCounters`、`Performance.getMetrics`。

## 地板构成（区域级拆解）

前面证明「地板是运行时」，但没回答「地板里到底是什么」。本节用 `VirtualQueryEx` 逐区域分类（`MEM_IMAGE`/`MEM_MAPPED`/`MEM_PRIVATE` × 可执行与否）+ `QueryWorkingSet` 把**常驻页**归到类别与模块，
再用 `Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate` 做独立交叉验证。窗口 1216×809、冷启动无会话（工作集合计 514.6 MB / 7 进程）。

### 一、求和口径会骗人：约六成共享页被重复计入

| 口径 | 值 |
| --- | --- |
| WS 合计（7 进程相加） | **514.6 MB** |
| 其中**私有页**（`WorkingSetPrivate` 实测，天然唯一） | **198.5 MB** |
| 其中**共享页**（差值，**被各进程各记一次**） | **316.1 MB（61%）** |

> **修订（同一轮的第二次测量）**：本节初版用「同名模块取各进程最大值」做去重，得出唯一物理 ≈346–356 MB。
> 那个口径**低估**了——它隐含假设「最大集包含其余进程的全部常驻页」。逐页偏移实测（下节）显示 `msedge.dll`
> 不满足该假设（最大集 54.9 MB，五进程并集 **93.2 MB**）。**修正后的唯一物理 ≈ 400 MB**。

### 二、逐页精确去重（同文件同偏移 = 同一物理页）

同一文件的镜像在各进程里基底地址相同（实测 `msedge.dll` 五个进程同为 `0x7FFC...`），故「页偏移」可直接跨进程取并集。
全量 173 个模块、7 进程：

| 模块 | 各进程相加 | **唯一物理（页并集）** | 重复计数 | 进程数 |
| --- | --- | --- | --- | --- |
| **`msedge.dll`** | 148.9 MB | **93.2 MB** | **55.7 MB（37%）** | 5 |
| `ntdll.dll` | 11.0 | 1.6 | 9.5（86%） | 7 |
| `msedgewebview2.exe` | 9.6 | 1.6 | 7.9（83%） | 6 |
| `combase.dll` | 7.6 | 1.8 | 5.8（77%） | 7 |
| `KERNELBASE.dll` | 6.2 | 1.1 | 5.1（82%） | 7 |
| `msedge_elf.dll` | 4.6 | 1.1 | 3.5 | 6 |
| `RPCRT4` / `ucrtbase` / `KERNEL32` | 7.5 | 1.4 | 6.1 | 各 7 |
| **镜像小计（173 模块）** | **289.4 MB** | **177.7 MB** | **111.6 MB（39%）** | — |

**`msedge.dll` 是重复计数的最大单项**：求和 148.9 MB 里有 **55.7 MB 是同一个物理页**（37%）。
但它同时也是**唯一物理里最大的镜像**（93.2 MB）——运行时本体被触达的代码面就这么多（镜像 333 MB）。

各进程只触达 `msedge.dll` 的不同子集：browser 54.9、renderer 48.5、utility 18.7、gpu 17.1、utility 9.6 MB；
**它们之间不嵌套**，所以「取最大」会低估 38 MB。

**测量坑（一并记下）**：`QueryWorkingSet` 不返回条目数，若缓冲区未清零、按「读到 0 为止」读，会**重复读到上一次查询的残留页地址**，
使「某模块驻留字节」虚高（本次首跑就中了：`ntdll.dll` 七个进程页集完全相同却报出 1.6/3.2/4.7 MB 三种值）。
按页集去重（`SortedSet`）不受影响，故上表用页并集口径。

### 三、唯一物理内存的归属（≈400 MB）

| 类别 | MB | 说明 |
| --- | --- | --- |
| **私有堆（独占）** | **198.5** | renderer 70.3 + gpu 58.4 + browser 33.9 + **app(pylon.exe) 24.7** + utility 9.5 + crashpad 1.7 |
| **镜像（页并集）** | **177.7** | 见上表 |
| 文件映射 | 16.1 求和（唯一略低） | 系统字体（`msyh.ttc` 0.85 / `seguiemj` 0.84 / `cambria` 0.61）、`icudtl.dat` 1.4、`Ruleset Data` 2.2 |
| 共享匿名（mojo/GPU 缓冲） | 22.4 求和 / 10.1 单进程峰值 | pagefile 支撑的共享内存 |

镜像里按归属分：`msedge.dll` **93.2**（运行时本体）、显卡驱动 **21.0**（NVIDIA `nvwgf2umx`+`nvgpucomp64`+`D3DCompiler_47` 13.4 + Intel `igc64`+`igd10um64xe` 7.6，**混合显卡机器两套 UMD 并存**）、
**`pylon.exe` 10.7（我们）**、`EmbeddedBrowserWebView.dll` 3.4（我们）、其余为 Windows/运行时 DLL。

### 四、结论：这一层里我们的代码 ≈ 55 MB（约 14%）

- **我们**：宿主私有堆 24.7 + `pylon.exe` 镜像常驻 10.7 + `EmbeddedBrowserWebView.dll` 3.4 + renderer 里属外壳的那部分（空白页对照：renderer 私有 88.5 → 71.2 MB）≈ **55 MB**。
- **其余 ≈ 345 MB**：WebView2 运行时（`msedge.dll` 唯一 93.2 MB + 各进程运行时基线）、Windows 系统 DLL、**两套显卡驱动 UMD 并存 21 MB**、ICU/字体、Chromium 每进程的固有 arena。
- **顺带否掉一个旧假设**：`resources/fonts`（磁盘 40 MB）**没有**被映射进任何进程——宿主的文件映射驻留只有 0.33 MB，且 top 列表里没有任何字体文件。宿主 commit 偏高的成因不在它这里。

### 五、这份拆解能改什么、不能改什么

- **改不了**：`msedge.dll` 93 MB、Windows DLL、ICU/字体、GPU 驱动栈、Chromium 各进程基线 —— 这些是「用 WebView2」的入场费。
  想动只能换运行时分发方式或换渲染宿主（不是本仓能决定的事）。
- **能改的**：我们自己的 ~55 MB（宿主私有堆 24.7 MB 最大一笔，未拆解到具体子系统）；以及 §未解 里的项。
- **测量建议**：报簇内存时**不要用各进程相加**——共享页会被各进程各记一次（本次口径下共享部分 1.6×，`msedge.dll` 1.60×、`ntdll` 6.9×）。
  至少同时给 `WorkingSetPrivate` 求和，并意识到**「同名取最大」只是个下界**：同一 DLL 的常驻页在不同角色间并不嵌套，要精确须按页偏移取并集。



## 并行交集

只读探查，未改产品代码；删除了实例的 `EBWebView/Default/{Cache,Code Cache}`（可自建）并关闭了该实例。

逐页去重的探针：`page-union.ps1`（对每个进程把模块常驻页按**页偏移**编码成区间，跨进程取并集）。
注意 `QueryWorkingSet` 不返回条目数，缓冲区必须清零——否则会读到上次查询的残留页地址，把「某模块驻留」算高。

## 附：为什么运行时这么大（`msedge.dll` 332 MB 与常驻 88–93 MB）

### 一、文件体量：它不是「WebView2 特供」，就是 Edge 本体

**证据**：WebView2 运行时目录的 `msedge.dll` 与 Edge 浏览器目录的 `msedge.dll` **md5 完全相同**
（`a03bfa55dc6c36775a99695365cbdefc`，同为 153.0.4234.48，均 332.1 MB）。微软把同一个二进制既给浏览器也给 WebView2。

PE 段表（自己解的头，非推断）：

| 段 | 大小 | 占比 | 说明 |
| --- | --- | --- | --- |
| **`.text`** | **269.5 MB** | **80.8%** | 机器码——整个浏览器引擎 |
| `.rdata` | 45.4 MB | 13.6% | 只读数据（vtable、字符串、常量表） |
| `.pdata` | 11.4 MB | 3.4% | x64 异常展开表（RUNTIME_FUNCTION） |
| `.data` / `.reloc` / `.rsrc` | 7.3 MB | 2.2% | — |

⇒ **体量几乎全是代码**，不是资源或调试信息撑起来的。同目录还有：`resources.pak` 33.1 MB、
`dxcompiler.dll` 19.5 MB（**WebGPU 着色器编译器**）、`mspdf.dll` 18.0 MB（**PDF 阅读器**）、
`icudtl.dat` 11.8 MB、`onnxruntime.dll` 10.2 MB（**机器学习推理**）、`oneauth.dll` 6.2 MB。
整目录 586 MB —— 这是「用 WebView2 = 在机器上装一份完整 Edge 引擎（含 PDF/WebGPU/ONNX/身份服务）」的代价。
（这些子系统只在被用到时才触达内存；它们占的是磁盘，不是我们的常驻。）

### 二、常驻 88–93 MB 的构成：触达了整只引擎约 24% 的代码面

把五进程的 `msedge.dll` 常驻页并集按 PE 段归位（两次测量 87.8 / 93.2 MB，随活的进程波动）：

| 段 | 镜像 | 触达（并集） | 触达率 |
| --- | --- | --- | --- |
| `.text` | 269.5 MB | **64.1 MB** | **23.8%** |
| `.rdata` | 45.4 MB | 18.7 MB | 41.2% |
| `.pdata` | 11.4 MB | 3.2 MB | 27.8% |
| `.data` | 4.0 MB | 1.8 MB | 45.4% |

按角色（本次）：browser 51.1 MB、renderer 47.6 MB、utility 16.1 / 9.4 MB、gpu 16.8 MB。

**为什么触达这么宽**：我们这个应用把引擎的主要子系统都叫醒了——DOM/CSS/布局/绘制、**V8 + WebAssembly**
（我们跑两个 wasm 核）、网络栈（本机 IPC + HTTP）、合成器、字体与文本整形、JSON/序列化、无障碍树等。
`.rdata` 触达率（41%）高于 `.text`，说明字符串表/vtable/常量表被大面积引用，与「多子系统并行活跃」一致。

**结论**：这 88–93 MB（唯一物理）与 332 MB（镜像）都不是我们的代码，也不是 WebView2 特有的膨胀——
是「现代浏览器引擎的可达代码面」这一事实本身。我们能做到的只是**不去额外触达**（例如不加载 PDF/WebGPU/ONNX 相关路径），
这部分在本轮观测里确实没有被触达（对应模块不在常驻列表里）。

## 附二：任务管理器的计数口径，与「代码层面能不能压低」

用户问「任务管理器里的内存计数，能不能在代码层面避免重复」。先把口径对齐——**这是两件不同的事**：

### 一、任务管理器已经在去重了

任务管理器 Processes 页的 `Memory` 列读的是**私有工作集**（private working set）：只算各进程**独占**的常驻页。
共享页（那份被 5–7 个进程映射的 `msedge.dll`）**不计入**任何单个进程的这一列。

实测同一时刻（重会话、未裁剪）：

| 口径 | 值 | 出现在哪里 |
| --- | --- | --- |
| **私有工作集之和** | **258.5 MB** | 任务管理器 `Memory` 列的和（Pylon 整组） |
| 工作集之和（含共享重复） | **592.4 MB** | 资源监视器 / 自己把 Details 的 `Working set` 列相加 |

⇒ 那 ~590 MB 的重复计数是**求和方式**造成的，不是 Windows 或运行时造成的。
「在代码层面避免重复」对任务管理器的默认列而言**无需做**——Windows 已经去过了。
（说明：任务管理器是受保护进程，`PrintWindow` 抓不到画面，故本条核的是**数值口径**——用它的同源计数器
`Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate`，不是核它的渲染。）

### 二、能「从代码层面」压低的两个杠杆（都已实测/评估）

**杠杆 A：裁工作集（`EmptyWorkingSet` / `SetProcessWorkingSetSizeEx`）**——纯代码层，不需要重建。

实测对 Pylon 簇 7 个进程各裁一次（`ok=7 fail=0`）：

| 时刻 | 工作集之和 | 私有工作集之和（= TM 口径） | commit |
| --- | --- | --- | --- |
| 裁之前 | 592.4 MB | **258.5 MB** | 557.6 MB |
| 裁后 +2s | 49.3 MB | **30.4 MB** | 不变 |
| 裁后 +22s（空置） | 125.8 MB | **83.6 MB** | 不变 |

**能立刻把 TM 显示的数从 258 打到 30**，但代价与边界要说清：
- **commit 一点没降**（页面被移到待机列表，不是释放）。物理内存只是变成「可回收」，不是「不再占用」。
- **会自己长回来**：空置 22 秒就回到 83.6 MB（renderer 65.8 / gpu 34.1），因为这个界面是活的（动画、定时器、合成）。
- 因此**不建议周期性裁**（等于烧 CPU 换数字）。若要实现，只在**窗口最小化/失焦**时裁一次——那时页面确实用不着。

**杠杆 B：减少进程数**——`additionalBrowserArgs` 里加 `--in-process-gpu`（GPU 合进 browser 进程）、
或把 network service 合进 browser。少一个进程就少一份「运行时基线 + 该进程私有堆」。
代价是隔离性与健壮性下降（GPU 进程崩溃会带走整个浏览器进程）。**属构建期内置参数，要重建才能实测**，本轮未测。

**不属于杠杆的**：`msedge.dll` 的共享常驻页（93 MB 唯一物理）——它在 TM 里本来就不重复计，
且物理上只有一份；要动它只能换渲染宿主。

### 三、真正属于我们的可减部分

TM 口径 258.5 MB 里，我们自己的代码约 55 MB：宿主进程私有 **32 MB**（最大一笔）、
`pylon.exe` 镜像常驻 ~11 MB、宿主加载器 3.4 MB、renderer 里属外壳部分。其余是 Chromium 各进程基线 + 运行时。
要降这个数，方向是宿主进程那 32 MB（未拆解到子系统）与 renderer 的非 JS 部分（JS 堆 GC 后只有 13 MB）。

### 四、工具

去重核算写成了 `tools/mem-accounting/mem-accounting.ps1`（+ README）：
同一份数据同时给「TM 口径（私有工作集之和）」「工作集之和」「去重物理估计」，并列出重复最多的文件映射。
实现要点与两个坑（`QueryWorkingSet` 不返回条目数须清零缓冲；PowerShell 泛型字典必须 `GetEnumerator()`）见该 README。

## 附三：**「实际占了多少物理内存」的直接测量**，以及对本记录前文一处修正

用户问「这 500MB 就是实际占有的物理空间对吗」。前文给的是**去重估计**，且明确标了是**空闲态**（私有 198.5 MB）。
带内容时私有会长到 258 MB，所以那 346–356 MB 是**下界**，不是稳态。这次改用**直接实验**：

对冷启动实例（未开会话）执行「关闭 → 看系统放回多少」，读 WMI 的 `PerfOS_Memory` + `OperatingSystem`：

| 时刻 | Available | Standby Cache(Normal) | Committed |
| --- | --- | --- | --- |
| 关闭前（稳态） | 1913 MB | 1552 MB | 28505 MB |
| 关闭 +10s | **2520 MB（+607 MB）** | 1591 MB | 27457 MB（**−1048 MB**） |
| 关闭 +30s | 2467 MB（+554 MB） | 1595 MB | 27592 MB（−913 MB） |

### 修正后的口径

| 口径 | 冷启动 | 重会话 | 说明 |
| --- | --- | --- | --- |
| 工作集求和 | 519 MB | 592 MB | **不是物理占用**：共享页被各进程各算一次 |
| 去重唯一物理（估） | ~390–410 MB | **~460–490 MB** | 私有 258 + 文件映射页并集 ~190–210 + 匿名 ~10–22 |
| 私有工作集（独占） | 199–215 MB | 258 MB | 关闭后一定能放回的部分 |
| commit（虚拟提交） | ~500–560 MB | 557 MB | 不是物理；关闭时释放 ~0.9–1.0 GB 的是这个 |
| **直接实验：关闭后 Available 增量** | **+607 MB** | 未测 | 最贴近「实际占有」的读数 |

**结论：是的，它确实真的占着几百 MB 物理内存**——「去重」只把 592 MB 修正到 ~470–490 MB（约 20%），
不会把它变成 350 MB。原因是这 592 MB 里**大头是私有内存（258 MB）**，而私有页按定义本来就只算一次；
被重复计数的共享文件页（~110 MB）虽然数额可观，但它们是 **clean、文件支撑**的，系统在内存压力下可以**零成本**丢弃。

**为什么我之前说"高估三到六成"**：那是把「共享页占求和的比例（61%）」当成了「求和高估的比例」。
正确的说法是：**共享页占求和约六成，去重后求和仍高估约 20%**。此处更正。

### 两个必须一起说的边界

1. **裁剪会把数"变好看"但不减少物理**：`EmptyWorkingSet` 后工作集求和从 592 → 49 MB，但 commit 一字不变
   （附二实测），页面进了 standby 列表——**standby 里的页仍是物理内存**，只是不出现在任何工作集里。
   所以「工作集」既不是去重的、也不是完整的。
2. **A/B 有噪声**：单次关闭实验受同机其它进程活动影响；本轮同机 Available 只有 ~1.9 GB（机器本身吃紧），
   故 Pylon 这 500 MB 是可用内存的显著比例——这大概是用户关切的实际来源。

### 可复现

关闭前后的系统读数用 WMI（PDH 计数器名在中文系统上是本地化的，按英文路径取不到）：

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory
Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory |
  Select-Object AvailableMBytes, StandbyCacheNormalPriorityBytes, CacheBytes, CommittedBytes, CommitLimit
```
