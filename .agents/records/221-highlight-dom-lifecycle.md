# Dev Record — 221 高亮 DOM 生命周期治根（惰性降级回收、闭合尖峰分帧与 CSS 布局圈闭）

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/221（refactor；assignee `AlchemistCxC`）
- 分支：`Ru5t/Reflector`
- 日期：2026-09-22
- spec：`.agents/spec/issue-221-highlight-dom-lifecycle.md`（一次性，不入库）

## 目标与范围

**做**：WP1（`.term-code-block` 布局圈闭）、WP2（视口外高亮 DOM 降级 + 行 HTML 缓存 +
观察器滞后带）、WP3（帧预算高亮调度，宿主侧）。三者集中在**新叶子模块
`chat/codeBlockDomLifecycle.ts`** 与两条代码块路径的接入点。

**不做（均按 issue 原文或调查后裁定）**：

- WP4（巨块展开切 CodeMirror）：issue 条款「仅在 WP2 落地后仍有实测压力时推进」——
  实测 WP2/WP3 落地后洪泛全程 0 条 long task（见下表），未触发。
- 计算核零改动：#220 裁决「整块进、行数组出、逐行过界禁止」+ 本 issue 约束
  「全部在 builtin 渲染层与 CSS 层实施」。wasm `highlightBlock` 保持整块同步出口，
  分帧发生在「何时发起、哪块先发」的宿主调度层。
- 行级（`.term-row`/`.term-assistant`）containment **否决**：`.copy-btn` absolute
  `right:-40px` 溢出行外，layout 圈闭改其锚定（零视觉变化红线）、paint 圈闭直接剪裁。
- `content-visibility: auto` **否决**：与 WP2 观察器双重机械；cv:auto 只跳布局/绘制，
  span DOM 照旧常驻（不解决内存主诉）；intrinsic-size 估计值引入滚动条跳动风险。
- 插件 provider 契约（`highlightCode`，HTML 串进出）与四样 Suite 契约零接触。

## 事实基线（实现前核查）

issue 正文写于 #220 WP4 切流之前：高亮引擎**已在 Rust 计算核**
（`src-tauri/pylon-markdown`，syntect regex-fancy + vendored tmLanguage），
`starryCore.ts` 是刻意保留的 parity 门禁基线，运行时不走 starry-night。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/chat/codeBlockDomLifecycle.ts` | 单例 IntersectionObserver（rootMargin 上下各一屏 + 每块 500ms 降级滞后带）、可注入时钟/让出的帧预算调度器工厂（8ms 预算、串行结算、urgent 插队）、`data-highlight-lifecycle="off"` 杀停开关 | 新增 |
| `src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx` | 仅内嵌 `CodeBlock`：行 HTML 缓存（sanitize 口径与旧路径逐字节一致）+ 观察器接入 + 调度器发起 | 修改 |
| `src/renderers/solid-workbench/chat/CodeBlock.solid.tsx` | 同机制；缓存键对齐 `visibleCode()`（#208 步进展开失配重取、过期在途结果丢弃）；无 IO 宿主保留 `createResource` 现状时序 | 修改 |
| `builtin.pylon-renderers/styles/components/chat/ChatView.css` | `.term-code-block` 既有规则体加 `contain: layout`（含否决理由注释） | 修改 |
| `chat/__tests__/issue221.codeBlockLifecycle.solid.test.tsx` | 8 用例（见下） | 新增 |
| `docs/说明书/Pylon-项目架构参考.md`、`Pylon-模块维护地图.md` | 生命周期与 JS 编排表述 | 修改 |

## 测试（新增 8 用例，jsdom + 伪造 IO + fake timers + 确定性假高亮）

降级/恢复几何一致（行数、类骨架、行文本恒定；空行 `'\u00a0'` 撑行高为既有约定）；
圈外挂载不发起高亮/进圈恰一次（缓存未命中路径）；恢复走缓存零重高亮（命中路径）；
分帧产物与直连 `highlightCode` 逐行逐字节一致；调度器预算切帧（注入时钟 6ms/作业、
10ms 预算 → 3 帧）；urgent 插队次序；杀停开关判定。

**既有行为测试零修改**：无 IntersectionObserver 宿主（jsdom）整套机制旁路，
两条组件路径与引入前逐字节同时序——chat 渲染域 62 文件 690 用例全绿（改前改后各跑一遍）。

## 实机验收（webview2-mcp，前后对比；61 块 / 2100 行 / 300 行巨块的洪泛会话）

方法：干净 worktree@HEAD 建 BEFORE 二进制，同一 worktree 应用本 issue 补丁建 AFTER
二进制（`CARGO_TARGET_DIR=D:`，共享依赖缓存）；自制仓外最小 ACP 假代理
（`../Docs/tmp-issue221/code-flood-agent.mjs`，按块节奏流式吐围栏代码块）以 GUI profile
接入；PerformanceObserver('longtask') 计长任务（去重），CDP 读 DOM/堆。

| 场景 | BEFORE（HEAD） | AFTER（本 issue） |
| --- | --- | --- |
| ① 稳态 DOM 节点数 | 23,719（恒定） | 7,165～9,325（随视口） |
| ① 高亮 span 存量 | 16,800（滚到顶也恒定） | **240**（顶部）～2,400（底部） |
| ① JS 堆（performance.memory） | ~35 MB | 16.7～24.8 MB |
| ② 洪泛期（61 块闭合）long task | 108～169 条，最长 **1,165～2,317 ms** | **0 条** |
| ③ 会话切回重放（同 journal） | 1 条 **1,017 ms** 整段级联 | **0 条** |

复现：假代理脚本与观察器注入代码见仓外 `../Docs/tmp-issue221/`；
BEFORE 滚到顶部 span 数不变坐实「永久常驻」主诉；AFTER 降级/恢复跟随视口
（240 ↔ 2,400），滚动期无可见抖动（500ms 滞后带 + 一屏 rootMargin）。

## 门禁

| 门禁 | 结果 |
| --- | --- |
| 定向 vitest（新增 8 + chat 渲染域） | ✅ 8/8；62 文件 690 用例；复树后再跑 44 文件 451 用例 |
| `check:frontend`（lint/tsc/build/全测/bundle/docs） | ✅ |
| `check:solid` | ✅ |
| `check:rust` | 本地红：**并行 #228 会话在途 WIP 所致**（`plugin_cmds` 重构中间态 39 错，与 `_pragma` 域无关；本 issue 零 Rust 改动），以 CI 为准 |
| 浏览器预览/真实渲染 | ✅ 实机 modern-gui 下代码块高亮、折叠、复制正常；provider 路径契约测试原样全绿 |

## 遗留与后续

- WP4（巨块 CodeMirror 6）：未触发（②已 0 long task）；如未来出现万行级块再议。
- `term-ansi`（ANSI 工具输出）span 树未纳入本机制，是下一个同构候选。
- 本机制与未来行级转录虚拟化的衔接点：虚拟化挂载边界可直接复用行缓存恢复路径。
- 实机验收副作用已全量恢复：测试会话删除、peri/hermes 重新导入、peri 恢复当前/默认、
  codeflood agent 删除（外部 agents.yaml 同步清理）、测试二进制与 worktree 移除。
