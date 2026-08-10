# ISSUE-09：Workspace sidebar contract 与折叠状态

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-09`
- 原问题编号：`#4`
- 状态：已交付（方案已写入）
- 依赖：ISSUE-01
- 简介：统一 Sheet sidebar capability、折叠状态、宽度 token 与响应式 context。
- 来源：`docs/release-issues.md`

## 已拍板决策（2026-08-09）

### D-08：公共 sidebar 折叠宽度统一为 42px

- 公共 workspace sidebar、Browser/File 局部 sidebar 的 collapsed token 统一为 `42px`。
- token 由 theme/layout contract 提供；组件不得继续各自硬编码折叠宽度。
- expanded width 仍由现有 `sidebarWidth`/局部 contract 管理；本决策只冻结 collapsed width。
- Browser child WebView bounds、titlebar 按钮区域和视觉内容必须使用同一 token；resize 验收以实际 bounds 为准。


### D-01：所有 Sheet 拥有左侧拓展区，但内部 UI 不统一

- Workspace 统一左栏外层宽度、背景图、背景色、颜色 token、边界与折叠状态。
- 每个 Sheet 自己定义左栏内部 UI、分区、导航、滚动和业务交互。
- 不强制使用统一菜单组件或统一信息层级。
- 所有 Sheet 共享同一个左栏折叠状态，不允许 Browser/File 等维护第二套外层折叠布尔值。

实施方案成熟度：**已有布局边界，具体每种 Sheet 的左栏内容尚未定义。**

### D-02：左栏属于 Primary Workspace 内部固定区域

- 左栏折叠后，内容、边界、背景图和交互在视觉上完全消失。
- 左栏布局区域仍保留，并使用主区背景融入 Primary Workspace。
- Main Content 的位置与宽度不变，不向左移动，也不因左栏折叠而拉伸。
- titlebar 左侧展开按钮属于独立控制区，不等同于 Sheet 左栏。

实施方案成熟度：**已有正式布局语义；需重构当前普通 flex 子项模型并验证 Browser WebView bounds。**

### D-03：右栏属于外层 docked panel

- 右栏展开时参与外层布局并压缩整个 Primary Workspace。
- 右栏折叠时退出布局，Primary Workspace 填充释放的右侧空间。
- 右栏折叠状态全局共享，切换 Sheet 后保持；各 Sheet 只提供不同内容，不维护自己的折叠状态。

实施方案成熟度：**现有 `SheetRightSlot` 已部分符合，仍需统一壳与回归。**

### D-04：现有 titlebar 折叠按钮交互保留

- 当前折叠按钮方向和交互概念正确，不作为视觉重设计目标。
- 后续修复重点是左栏布局契约、状态来源和各 Sheet 接线，不擅自改变按钮设计。

实施方案成熟度：**明确不改项。**

### D-05：首期只建立统一左栏布局壳，允许 Sheet 左栏内容为空

- 本轮 ISSUE-09 的交付目标是统一所有 Sheet 的左栏布局契约、视觉 token、折叠状态和 titlebar 对齐。
- 尚无成熟业务内容的 Sheet 可以提供空左栏壳，不要求本轮补齐导航、过滤、状态或快捷操作。
- 空左栏仍必须遵守统一的展开宽度、背景、边界、折叠和持久化契约，不能由 Sheet 自建另一套外层布局。
- 空壳不代表对应业务左栏已经完成；后续增加内容时应作为独立产品任务，不得在本 Issue 验收中宣称功能完备。

实施方案成熟度：**已有明确范围收口；各 Sheet 何时补充业务左栏不属于本轮。**

### D-06：左栏折叠后视觉上彻底消失

- 折叠后左栏不显示任何内容、背景图、背景色、边框、阴影或独立占位标记。
- 左栏仍保留 Primary Workspace 的布局区域，以保证主区位置和宽度不变；该区域必须视觉上与主区背景融为一体，用户不能感知为一个空左栏。
- 左栏区域不得接收鼠标、键盘或滚轮交互；展开按钮只属于 titlebar 独立控制区。
- 主区不因左栏折叠向左移动，也不因释放视觉内容而拉伸。

实施方案成熟度：**产品语义已明确；具体 CSS/布局实现和 Browser WebView bounds 验证由施工任务负责。**

## 并行执行元数据

```yaml
formal_id: ISSUE-09
status: 已交付（方案已写入）
lane: frontend-layout
priority: P1
stage: contract
size: L
dependencies: []
blocks: ["10-A"]
likely_modify: ["src/workspace-sheets/", "src/App.tsx", "src/App.css", "src/domains/theme/"]
do_not_modify: ["不统一各 Sheet 左栏内部业务 UI"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

## 原始问题记录

原问题编号：#4
严重度：P1
状态：已交付（方案已写入）

问题现象：
宫木云汇报：
“部分页面左栏无法折叠；在这些页面，titlebar 的折叠按键有时候位置不正确，位于左栏收起后的位置，点击后回到正确位置，再次点击又回到错误位置。我的看法：为所有 Sheet 增添左栏折叠功能。”

触发条件：
1. 在 Agent Sheet 点击 titlebar 左栏按钮，切换全局 `sidebarCollapsed`。
2. 切换到 Browser、Prism、Runtime、Overview、Search、History、Gateway 等没有 registry sidebar 的 Sheet。
3. titlebar 仍按全局状态在 250px 与 42px 网格列之间切换，但主内容区没有对应 registry 左栏。
4. Browser / File 又拥有各自内部 sidebar 状态，出现按钮位置与实际左栏状态不一致。

问题根因：
全局 titlebar 折叠按钮控制的是 `workspaceStore.sidebarCollapsed` 和 titlebar 第一列宽度，但 `SheetSidebarSlot` 只有 `agent` Sheet 注册了 sidebar；其他 Sheet 要么没有左栏，要么像 Browser/File 一样在 Sheet 内部维护第二套本地 `sidebarCollapsed`。因此“titlebar 左栏宽度”“registry 左栏是否存在”“Sheet 内部左栏状态”是三套不一致的真值：切换 Sheet 或点击按钮时，titlebar 会在 250px/42px 间移动，而实际页面侧栏可能不存在、保持展开或由另一按钮控制，形成位置来回跳和部分页面无法折叠。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src/App.tsx:60-63,248-257`
  - titlebar 订阅全局 `workspaceStore.sidebarCollapsed`，按钮只切换该全局布尔值。
- `G:/Project/prism-desktop/src/domains/theme/themeCssSnapshot.ts:19-32`
  - `--titlebar-sidebar-width` 全局固定按 `sidebarCollapsed ? 42 : sidebarWidth` 计算，不判断 active Sheet 是否拥有左栏。
- `G:/Project/prism-desktop/src/workspace-sheets/SheetSidebarSlot.tsx:12-17`
  - entry 没有 `sidebar` 时直接返回 null；没有统一 placeholder/collapsible contract。
- `G:/Project/prism-desktop/src/workspace-sheets/sheetRegistry.tsx:47-65`
  - 只有 `agent` 注册 `sidebar: Sidebar`；其余 Sheet 均无 registry sidebar。
- `G:/Project/prism-desktop/src/sheets/browser/BrowserSheetView.tsx:35-39,145-161`
  - Browser 自己维护本地 `sidebarCollapsed` 和独立折叠按钮，完全不消费 `ctx.sidebarCollapsed`。
- `G:/Project/prism-desktop/src/sheets/file/FileSheetView.tsx:36,70-79`
  - File 同时维护本地 collapsed，并用 `ctx.sidebarCollapsed` 作为 hidden，存在“局部折叠”和“全局隐藏”两层状态。
- `G:/Project/prism-desktop/src/workspace-sheets/WorkspaceTitlebar.tsx:52-68`
  - titlebar 始终渲染左栏按钮，不知道 active Sheet 是否支持/拥有 sidebar。

解决方案：

方案 A（推荐，所有 Sheet 使用统一左栏能力契约和唯一折叠状态）：
- 改动位置：
  - `src/workspace-sheets/sheetTypes.ts` 的 `SheetRenderEntry`
  - `src/workspace-sheets/sheetRegistry.tsx`
  - `src/workspace-sheets/SheetSidebarSlot.tsx`
  - `src/workspace-sheets/SheetLayout.tsx`
  - `src/workspace-sheets/WorkspaceTitlebar.tsx`
  - `src/App.tsx`
  - `src/domains/theme/themeCssSnapshot.ts`
  - Browser/File 的内部 sidebar 组件
- 具体改法：
  1. 给 `SheetRenderEntry` 增加明确的左栏契约，例如：
     ```ts
     sidebar?: ComponentType<{ ctx: SheetContext }>
     sidebarMode: 'workspace' | 'sheet' | 'none'
     ```
     或更直接统一为所有 Sheet 都声明 `sidebar`。
  2. 推荐将 Browser、File 的左栏从主 render 内移到 registry `sidebar` slot；Agent 保持现状。Prism、Runtime、Overview、Search、History、Gateway 增加与页面功能匹配的轻量 sidebar；如果首期没有内容，也必须有统一宽度的空 sidebar shell，而不是让 titlebar 伪装存在侧栏。
  3. 删除 Browser/File 的本地 `useState(sidebarCollapsed)`，所有 Sheet 统一读取 `workspaceStore.sidebarCollapsed`；需要“仅图标栏”时统一定义 collapsed width，不能一个是 0、一个 42、一个 48。
  4. `WorkspaceTitlebar` 接收 active Sheet 的 sidebar capability；有 sidebar 才启用按钮，无 sidebar 时要么禁用并把第一列宽度设为 42px 控制区，要么所有 Sheet 都提供 sidebar。根据宫木云意见，推荐所有 Sheet 都提供 sidebar。
  5. `--titlebar-sidebar-width` 和实际 `SheetSidebarSlot` 宽度使用同一 selector，例如统一 `--workspace-sidebar-current-width`，展开=`sidebarWidth`，折叠=`42px` 或 `48px`。推荐选一个值全局统一；当前 titlebar 是 42px、Browser/File 是 48px，必须拍板并消除差异。【需拍板：折叠宽度 42px 或 48px】
  6. `SheetContext.sidebarCollapsed` 不再由 `getState()` 非响应式快照构造；`SheetLayout` 应订阅该值并注入 ctx，保证 active Sheet render 与 titlebar 同步更新。
- 影响面：统一所有 Sheet 的布局结构和折叠体验；不改变各 Sheet 主业务，但会改变 Browser/File 左栏的组件归属及折叠宽度。为无现成左栏的页面添加左栏内容属于产品 UI 扩展，需要按各页面定义内容。
- 验证方式：
  1. 遍历 9 种 `SheetKind`，每种展开/折叠两次，titlebar 按钮 x 坐标与左栏边界始终一致。
  2. 切 Sheet 前后全局 collapsed 状态保持一致，无局部状态复活。
  3. Browser child WebView bounds 在折叠后重新同步。
  4. File activity bar 和内容面板不再存在局部/global 双重状态。
  5. 重启后持久化的 `sidebarCollapsed` 在所有 Sheet 一致恢复。
  6. 增加 registry 完整性测试：所有 Sheet 必须声明 sidebar mode，禁止隐式缺失。
- 风险与取舍：改动范围较大，但能消除三套状态长期漂移；符合“为所有 Sheet 增添左栏折叠功能”的产品方向。各 Sheet 左栏具体内容需要设计，如果本轮只修 Bug，可先做方案 B。

方案 B（最小修复，不新增所有页面左栏内容）：
- 改动位置：`App.tsx`、`WorkspaceTitlebar.tsx`、`themeCssSnapshot.ts`、`sheetRegistry.tsx`、Browser/File。
- 具体改法：
  1. 根据 active Sheet 判断是否有 sidebar capability。
  2. 无 sidebar 的 Sheet 禁用 titlebar 折叠按钮，并把 titlebar 第一列固定为 42px 控制区，避免错误占用 250px。
  3. Browser/File 明确注册 `hasInternalSidebar`，titlebar 按钮通过统一 callback 控制内部 sidebar，禁止再有独立按钮和本地布尔值。
  4. 统一 collapsed width。
- 影响面：只修复按钮位置和状态错位，不为 Prism/Runtime 等新增实际左栏内容。
- 验证方式：同方案 A 的位置和切换测试；无 sidebar 页面按钮 disabled，位置不跳。
- 风险与取舍：改动较小，但不满足“所有 Sheet 都有可折叠左栏”的最终产品方向。

重构方案：
将左栏从“Agent registry slot + Browser/File 内嵌组件 + titlebar 全局宽度”重构为唯一 `WorkspaceSidebar` 布局域：

```text
WorkspaceTitlebar sidebar cell
        ↕ 同一宽度 token / 同一 collapsed state
WorkspaceSidebar slot
        ↳ active Sheet 提供 sidebar content
SheetHost main content
```

每个 Sheet 只提供 sidebar 内容，不拥有 sidebar 宽度与折叠状态。布局层统一负责：宽度、动画、overflow、持久化、按钮、响应式和 Browser bounds 通知。

---

### 源码复核后的实施细化

1. `SheetRenderEntry.sidebar` 当前是可选字段，且 `SheetSidebarSlot` 缺失时直接 return null；先增加 `sidebarMode: 'workspace'|'sheet'|'none'` 或等价 capability，建立完整性测试。
2. `SheetLayout.buildSheetContext()` 当前从 `useWorkspaceStore.getState()` 读取 `sidebarCollapsed`，不是响应式订阅；必须在组件内订阅后作为参数传入 ctx。
3. 统一 Browser/File/Workspace 的 collapsed width token；当前 titlebar 42px、Browser/File 48px，先拍板一个值再改 CSS/child WebView bounds。
4. 首期建议先做方案 B：无 sidebar Sheet 不显示可操作折叠按钮；方案 A 中把 Browser/File 内栏迁移到 registry 是后续布局重构，不应和 #3 一起无测试大搬迁。
5. 验收用每个 `SHEET_KINDS` 展开/折叠、切 Sheet、窗口 resize、Browser bounds 四维组合，而不是只截一张图。

可行性：方案 B 高、方案 A 中高。当前 registry 已有扩展点，但无 sidebar 的 Sheet 数量多，统一空壳会带来产品 UI 决策。

---

## 逐项验收清单

### 6.10 问题 #4：Workspace sidebar 统一能力与折叠状态

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| registry 完整性 | 9 种 SheetKind 均显式声明 sidebar mode/capability | `src/workspace-sheets/sheetRegistry.tsx` registry tests | [x] ✅ `sheetRegistrySidebarMode.test.tsx`（I09-A-FE-01，v1.0.6） |
| 响应式 SheetContext | `sidebarCollapsed` 变化后 active Sheet 立即收到新 ctx，不依赖 `getState()` 旧快照 | `SheetLayout.tsx` component tests | [x] ✅ `sheetLayoutSidebarCollapsedReactive.test.tsx`（I09-A-FE-01，v1.0.6） |
| 统一宽度 token | titlebar cell、workspace sidebar、Browser/File 内栏使用同一 collapsed width | theme/layout contract tests | [x] ✅ `themeCssSnapshot.test.ts`（I09-A-FE-01，v1.0.6） |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 所有 Sheet 切换 | 逐一打开 Agent/Prism/Runtime/File/Overview/Search/History/Browser/Gateway，按钮位置不跳 | `http://localhost:5173/` → titlebar “+” 打开各 Sheet | [ ] |
| 展开/折叠一致 | 每个 Sheet 连续折叠/展开两次，titlebar 边界与实际侧栏一致；无 sidebar 时按钮按设计禁用/隐藏 | `http://localhost:5173/` → 各 Sheet titlebar | [ ] |
| File/Browser 单一状态 | 不再出现全局 hidden 与局部 collapsed 互相打架 | `http://localhost:5173/` → File Sheet / Browser Sheet | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 原生窗口 resize | 折叠、展开、切 Sheet、调整窗口后布局无跳位 | 真实应用 → 所有 Sheet | [ ] |
| Browser bounds | sidebar 改变后 child WebView bounds 同步，无覆盖、黑边或点击错位 | 真实应用 → Browser Sheet | [ ] |
| 持久化恢复 | 重启后 collapsed 状态在所有 Sheet 一致恢复 | Release `pylon.exe` → 重启验收 | [ ] |

## 施工日志

| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-09`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
| 2026-08-09 | 产品拍板 | ISSUE-09 首期只建立统一左栏布局壳；无成熟业务内容的 Sheet 允许空左栏。 | 对应未决策项：左栏首期内容标准 |
| 2026-08-09 | 产品拍板 | 左栏折叠后视觉上彻底消失；布局区域保留但无任何可见背景、边框或占位痕迹，主区位置和宽度不变。 | 对应未决策项：左栏折叠后的视觉填充方式 |
|  |  |  |  |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| 公共 sidebar slot 已存在 | 属实 | `src/workspace-sheets/SheetSidebarSlot.tsx:6-12`；`SheetLayout.tsx:112` | 不重建框架，只修 capability/context 与 consumer。 |
| 折叠状态完全响应式 | 不属实 | `src/workspace-sheets/SheetLayout.tsx:40` 使用 `useWorkspaceStore.getState()` | 在组件内订阅后传入 context。 |
| collapsed width 未拍板 | 已解决 | `src/domains/theme/themeCssSnapshot.ts:30` 已有 42px；本轮拍板统一 42px | 抽成单一 token，Browser bounds 与 CSS 共用。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- 🟡 `SheetSidebarSlot` 已存在，但 `SheetLayout` 在 `src/workspace-sheets/SheetLayout.tsx:40` 通过 `useWorkspaceStore.getState()` 读取折叠值，非响应式；统一 contract 仍需验证。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I09-A-FE-01` | FE | A | I01-A-FE-01 | 统一 Sheet sidebar capability/context 响应式订阅；sidebarCollapsed 使用响应式订阅；无 sidebar 不生成可操作折叠按钮。 | L1 |
| `I09-A-FE-02` | FE | A | I09-A-FE-01 | 冻结 sidebar width token 与 WebView bounds contract；统一 token 后 resize/折叠时 bounds 与 CSS 一致。 | L2 |
| `I09-B-FX-01` | FX | B | I09-A-FE-01 | 公共 sidebar 动效 contract proposal；先 Preview/提案，未冻结不得改公共布局；包含 reduced-motion 和性能预算。 | L2 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
