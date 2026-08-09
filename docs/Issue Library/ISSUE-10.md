# ISSUE-10：Browser sidebar 折叠文字泄漏

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-10`
- 原问题编号：`#3`
- 状态：已交付（方案已写入）
- 依赖：ISSUE-09
- 简介：折叠 Browser sidebar 时隐藏残留 unavailable 文本并加 CSS 边界。
- 来源：`docs/release-issues.md`

## 并行执行元数据

```yaml
formal_id: ISSUE-10
status: 已交付（方案已写入）
lane: frontend-layout
priority: P2
stage: consumer
size: S
dependencies: ["09-A"]
blocks: []
likely_modify: ["src/sheets/browser/"]
do_not_modify: ["不处理 Browser 新窗口"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

## 原始问题记录

原问题编号：#3
严重度：P2
状态：已交付（方案已写入）

问题现象：
宫木云汇报：
“Browser Sheet 左栏折叠后，左栏内容错误地渲染了出来。”

触发条件：
1. 打开 Browser Sheet。
2. 点击 Browser Sheet 内部左栏折叠按钮。
3. 观察折叠后的 48px 左栏。
4. `unavailable` 等内容仍被渲染并从窄栏中溢出或露出。

问题根因：
Browser Sheet 的折叠渲染只条件隐藏了工具名称，却无条件渲染每个工具项的 `browser-tool-unavailable` 文本；同时 `.browser-sidebar` 没有 `overflow: hidden`。折叠宽度变为 48px 后，`unavailable` 仍存在于 flex item 中并可越过侧栏边界绘制，造成“左栏内容错误渲染出来”。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src/sheets/browser/BrowserSheetView.tsx:145-160`
  - 工具 label 使用 `!sidebarCollapsed && <span>{item.label}</span>`。
  - `!item.available && <span className="browser-tool-unavailable">unavailable</span>` 不受折叠状态控制。
- `G:/Project/prism-desktop/src/sheets/browser/BrowserSheet.css:12-23`
  - `.browser-sidebar` 定宽但未设置 `overflow:hidden`。
- `G:/Project/prism-desktop/src/sheets/browser/BrowserSheet.css:52-54`
  - collapsed 只改变对齐与 padding，没有隐藏 `.browser-tool-unavailable`。
- `G:/Project/prism-desktop/src/sheets/browser/BrowserSheet.css:82-86`
  - 仅在窗口宽度小于 720px 时用 `.browser-tool-item span { display:none; }`，手动折叠状态没有等价规则。

解决方案：

方案 A（推荐，收敛折叠内容可见性）：
- 改动位置：`BrowserSheetView.tsx` 的 TOOL_ITEMS 渲染；`BrowserSheet.css` 的 sidebar/collapsed 规则。
- 具体改法：
  1. `browser-tool-unavailable` 与工具名称采用相同折叠条件：`!sidebarCollapsed && !item.available && ...`。
  2. `.browser-sidebar` 增加 `overflow: hidden`，作为布局边界兜底。
  3. 增加显式 CSS：`.browser-sidebar-collapsed .browser-tool-unavailable { display:none; }`，避免未来 JSX 调整重新泄出。
  4. collapsed 模式只保留图标，状态信息通过现有 `title` / `aria-label` 提供，不在 48px 栏内展示文字。
- 影响面：只修复折叠态视觉；展开态仍显示 `unavailable`，按钮 disabled 行为不变。
- 验证方式：
  1. 展开态显示图标、名称和 unavailable。
  2. 折叠态 DOM 视觉只显示图标，无任何文字越界。
  3. 720px 上下两种 viewport 均一致。
  4. 浏览器 bounds 随 sidebar resize 正确更新。
  5. 增加 DOM/CSS contract 测试，断言 collapsed 时 unavailable 不可见。
- 风险与取舍：JSX 条件和 CSS 双保险略有重复，但可防止原生 child WebView 邻接区域被 React 内容溢出覆盖，推荐保留。

---

### 源码复核后的实施细化

1. JSX 将 `browser-tool-unavailable` 与 label 一起受 `!sidebarCollapsed` 控制；collapsed 只保留 icon，并保留 `title/aria-label`。
2. CSS 增加 `.browser-sidebar { overflow:hidden; }` 和 collapsed 下 `.browser-tool-unavailable { display:none; }`；同时覆盖 720px media query，避免响应式与手动状态规则冲突。
3. 若 #4 后续把 Browser sidebar 迁移为 workspace slot，保留该组件级 overflow 作为内部边界，不依赖外层布局兜底。
4. 组件测试检查展开/折叠 DOM 可见性和按钮 disabled 语义；真实 Browser bounds 作为集成回归。

可行性：高，改动局部且不触及 WebView 协议。

---


## 逐项验收清单

### 6.11 问题 #3：Browser sidebar 折叠文字泄漏

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| JSX 可见性 | collapsed 时不渲染 label/unavailable，展开时正常渲染 | `BrowserSheetView.tsx` component tests | [ ] |
| CSS 边界 | `.browser-sidebar` 有 overflow 防护；手动折叠与 720px media query 一致 | `BrowserSheet.css` contract/style tests | [ ] |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 手动折叠 | 48px/统一宽度栏内只显示图标，不出现 `unavailable` 或工具名称越界 | `http://localhost:5173/` → Browser Sheet → 左栏折叠按钮 | [ ] |
| 响应式 | 浏览器宽度在 720px 上下切换时，无文字短暂闪现或溢出 | `http://localhost:5173/` → Browser Sheet；DevTools 调整 viewport | [ ] |
| 可访问性 | 折叠后按钮仍有正确 title/aria-label，disabled 工具不会误触发 | 同上 | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| WebView 邻接区域 | 折叠后 React 侧栏内容不覆盖 child WebView，点击坐标正确 | 真实应用 → Browser Sheet | [ ] |
| 多次切换 | 展开/折叠、窗口 resize、切出再切回后均无泄漏 | 真实应用 → Browser Sheet | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-10`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| collapsed 时 unavailable 文字仍渲染 | 属实 | `src/sheets/browser/BrowserSheetView.tsx:157` 只隐藏 label，未隐藏 unavailable | JSX 与 CSS 双重约束；collapsed 只保留 icon/title/aria-label。 |
| 需要改 Browser 新窗口协议 | 不属实 | 本问题只涉及 sidebar DOM/CSS | 新窗口行为独立归 ISSUE-11，避免 scope 膨胀。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- ✅ 现象属实：`BrowserSheetView.tsx:157` 在折叠时仍渲染 `browser-tool-unavailable` 文本；方案可局部修正，不应扩大为 WebView 协议改造。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I10-A-FE-01` | FE | A | I09-A-FE-02 | 修复 Browser collapsed unavailable 文本泄漏；折叠仅保留 icon/title/aria-label，unavailable 文本不出现在布局流中。 | L1 |
| `I10-B-FX-01` | FX | B | I10-A-FE-01 | Browser sidebar 折叠/展开过渡；动效不改变 disabled 语义和 WebView bounds，支持 reduced-motion。 | L2 |
| `I10-A-TEST-01` | TEST | S | I10-A-FE-01 | Browser 折叠 DOM 与真实 bounds 回归；网页验证 DOM，真实应用验证 child WebView bounds。 | L3 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |



### D-08：公共 sidebar 折叠宽度统一为 42px

- 公共 workspace sidebar、Browser/File 局部 sidebar 的 collapsed token 统一为 `42px`。
- token 由 theme/layout contract 提供；组件不得继续各自硬编码折叠宽度。
- expanded width 仍由现有 `sidebarWidth`/局部 contract 管理；本决策只冻结 collapsed width。
- Browser child WebView bounds、titlebar 按钮区域和视觉内容必须使用同一 token；resize 验收以实际 bounds 为准。
