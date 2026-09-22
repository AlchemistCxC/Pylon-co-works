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

### 一、求和口径会骗人：六成是同一物理页被重复计入

| 口径 | 值 |
| --- | --- |
| WS 合计（7 进程相加） | **514.6 MB** |
| 其中**私有页**（`WorkingSetPrivate` 实测） | **198.5 MB** |
| 其中**共享页**（差值） | **316.1 MB（61%）** |

`msedge.dll` 一个文件就说明问题：它单独看是 **55.0 MB** 常驻，却**出现在 5 个进程里**（browser 51.5 / renderer 48.4 / gpu 16.9 / utility 16.1 / utility 9.4）。
按名字去重（同名只计各进程最大值）后：镜像+映射 **162.9 MB**、私有 **183.1 MB**、共享匿名峰值 **10.1 MB**
⇒ **唯一物理估计 ≈ 346–356 MB**（两法互证，与计数器口径的 ~371 MB 同量级）。
**读任务管理器时要注意：把簇里各进程相加会高估约 30–60%。**

### 二、唯一物理内存的归属（≈350 MB）

| 类别 | MB | 说明 |
| --- | --- | --- |
| **私有堆（独占）** | **198.5** | renderer 70.3 + gpu 58.4 + browser 33.9 + **app(pylon.exe) 24.7** + utility 9.5 + crashpad 1.7 |
| **镜像去重后** | **162.9** | 见下表 |
| 文件映射 | 16.1 | 系统字体（msyh.ttc 0.85 / seguiemj 0.84 / cambria 0.61）、`icudtl.dat` 1.4、`Ruleset Data` 2.2 |
| 共享匿名（mojo/GPU 缓冲） | 22.4 求和 / 10.1 单进程峰值 | pagefile 支撑的共享内存 |

镜像（去重后）最大的几笔：

| 模块 | 常驻 | 出现在几个进程 | 归属 |
| --- | --- | --- | --- |
| `msedge.dll` | **55.0 MB** | 5 | WebView2 运行时本体（磁盘 332 MB） |
| `pylon.exe` | 10.7 MB | 1 | **我们**（镜像 34.3 MB） |
| `nvwgf2umx.dll` + `nvgpucomp64.dll` + `D3DCompiler_47.dll` | 13.4 MB | 1（gpu） | NVIDIA 驱动 |
| `igc64.dll` + `igd10um64xe.DLL` | 7.6 MB | 1（gpu） | Intel 驱动 |
| `EmbeddedBrowserWebView.dll` | 3.4 MB | 1 | **我们**（WebView2 宿主加载器） |
| `ntdll` / `combase` / `KERNELBASE` | 7.5 MB | 各 7 | Windows |
| `icudtl.dat` / `msedgewebview2.exe` / `msedge_elf.dll` | 4.5 MB | 各 6 | 运行时 |

### 三、结论：这一层里我们的代码 ≈ 55 MB

- **我们**：宿主私有堆 24.7 + `pylon.exe` 镜像常驻 10.7 + `EmbeddedBrowserWebView.dll` 3.4 + renderer 里属外壳的那部分（空白页对照：renderer 私有 88.5 → 71.2 MB）≈ **55 MB（约 15%）**。
- **其余 ≈ 295 MB**：WebView2 运行时（`msedge.dll` 常驻 55 MB + 各进程运行时基线）、Windows 系统 DLL（`ntdll`/`combase`/`KERNELBASE` × 7 进程）、**两套显卡驱动 UMD 并存 21 MB**（混合显卡机器上 NVIDIA 与 Intel 的驱动都被加载）、ICU/字体、以及 Chromium 每进程的固有 arena。
- **顺带否掉一个旧假设**：`resources/fonts`（磁盘 40 MB）**没有**被映射进任何进程——宿主的文件映射驻留只有 0.33 MB，且 top 列表里没有任何字体文件。宿主 commit 偏高的成因不在它这里。

### 四、这份拆解能改什么、不能改什么

- **改不了**：`msedge.dll` 55 MB、Windows DLL、ICU/字体、GPU 驱动栈、Chromium 各进程基线 —— 这些是「用 WebView2」的入场费。
  想动只能换运行时分发方式或换渲染宿主（不是本仓能决定的事）。
- **能改的**：我们自己的 ~55 MB（宿主私有堆 24.7 MB 最大一笔，未拆解到具体子系统）；以及 §未解 里的项。
- **测量建议**：以后报簇内存时**不要用各进程相加**，至少同时给 `WorkingSetPrivate` 求和；否则会系统性高估三到六成。



## 并行交集

只读探查，未改产品代码；删除了实例的 `EBWebView/Default/{Cache,Code Cache}`（可自建）并关闭了该实例。
