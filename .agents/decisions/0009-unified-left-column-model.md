# ADR-0009 左列统一模型：几何归布局层（单一宽度真值 + 单一分割线 + 折叠为 0）

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0009-unified-left-column-model.md`

- **日期**：2026-09-18
- **状态**：已采用
- **关系**：部分反向 ADR 未记载的 I09-A-FE-01/02 决定（「Sheet 自持左栏」），并替代其 42px 折叠轨道冻结口径（D-08）；与 ADR-0003（Shell Recipe 重排）正交——本 ADR 不改排列方向，只改「谁拥有左列几何」。

## 背景与约束

用户在真机报告：**部分页面的左侧栏分割线与标题栏「折叠按钮/状态灯右边」那条分割线无法对齐，且成因是「基于 sheet 自身数据」（点名浏览器 sheet、gateway）；希望统一侧栏模型。**

只读核查 + webview2 MCP 实测确认左列当时没有单一主人，存在三套独立宽度与两套独立边框：

| 表面 | 宽度来源 | 折叠感知 |
|---|---|---|
| 标题栏左轨道 | `--titlebar-sidebar-width` | 是 |
| 布局左栏 `.sidebar` | `--workspace-sidebar-track-width` | 是 |
| 8 个 Sheet 内联 `<aside>` | `--sheet-sidebar-width`（恒为展开宽） | 否 |
| Browser | 硬编码 `156px` / 折叠 `42px` | 否 |

实测（视口 1200×800，左栏 240）：Agent 展开 240/240 对齐；**Browser 展开 240/156，错开 84px**；Gateway 折叠后标题栏轨道 42px 仍带 1px 边框，而其左栏整块不渲染 ⇒ **悬空分割线**。

结构性成因：只有 agent 声明了注册表 `sidebar:`，其余 8 个 Sheet 在自己内容区画 `<aside>`；而 `sidebarEnabled` 只看 `sidebarMode`，于是标题栏为「左栏在内容区里」的 Sheet 也空占一条轨道并自画边框。

约束：

- `sidebarMode` 的三个字符串值（`'workspace' | 'sheet' | 'none'`）是契约，不得改名（dev-standards §29）。
- 左栏 clamp（160/520）、`applyWorkspaceLayoutChange` 事务、`pylon-workspace-layout-v3` 持久化键不变。
- 中控区不碰。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 只收敛宽度 token（保留各 Sheet 自画 `<aside>` 与各自的 `border-right`） | 用户明确否掉：仍是「每个 Sheet 各画一条边框」，靠尺寸相等而重合，不是结构上单一。 |
| 把 8 个 Sheet 的左栏 JSX 全部迁进注册表 `sidebar:`（真正的「内容也归布局」） | 实测每个左栏都读 Sheet 局部状态（Runtime 的 `filtered`/`filter`、Search 的 `results`/`query`、History 的 `paged`、Gateway 的 `status`，File 甚至渲染 Sheet 的 `children` 面板树）。迁走需先把这些状态整体上提，属独立的大重构；本轮以低风险方式先解决几何所有权。 |
| 保留 42px 折叠轨道，只把各 Sheet 宽度对齐 | 用户明确要求「折叠后不要有紧凑左列」（agentsheet 的空列、filesheet 的图标条都不要）。 |

## 决定

1. **宽度唯一真值**：`--sheet-sidebar-track-width`（展开 = 用户宽；折叠或本 Sheet 无左栏 = `0`）。退休 `--titlebar-sidebar-width`、`--workspace-sidebar-track-width`、`--workspace-sidebar-collapsed-width`、`--sheet-sidebar-width` 四套。
2. **单一分割线所有者**：布局层的 `.layout[data-sidebar="expanded"]::before` 是全应用唯一一条左列竖线；标题栏左格只在左列可见时补上 titlebar 高度那一段（共用同一变量，故共线）；各 Sheet 一律不自画竖边框。
3. **折叠 = 0 宽**：不再保留紧凑轨道。可见性由布局层状态 `.layout[data-sidebar="collapsed"] .sidebar { visibility:hidden }` 统一负责（`visibility` 继承到后代，键盘焦点一并移出）。
4. **共享几何类**：每个 Sheet 的左栏外壳挂同一个 `.sidebar`；各 Sheet 不得自带宽度 / flex 基准 / 竖边框。
5. **折叠按钮放在工作区带首位**（左栏紧邻处），**不放进右侧应用控制簇**：后者会挤动「右侧栏 / 界面 / 设置」与窗口控制的落点，而这三者加窗口按钮的位置必须恒定（用户明确要求）。之所以放在工作区带可行——标题栏是三列 grid，第 2 列是 `minmax(0,1fr)`，第 3 列宽度由自身内容决定，故第 2 列的增删不移动第 3 列。之所以不放在左格里——折叠后左轨道为 0 宽，按钮会随轨道消失，用户将无法再展开。按钮**始终渲染**（本 Sheet 无左栏时禁用），避免随 Sheet 能力忽隐忽现；图标表达「左栏在/不在」（`PanelLeftClose`/`PanelLeftOpen`；glyph 皮肤用 `▤`/`▢`）而不是读成「打开菜单」的 ☰。
   - 推论：折叠时标题栏左格**必须留在 grid 流里**（0 宽 + 不可见），不能用 `display:none`——移除它会让后两个兄弟自动前移一列，右侧两簇整体跑到窗口最左侧（实测菜单 957/997/1037 → 4/44/84、窗口按钮 1086/1124/1162 → 133/171/209）。
6. **`sheetHasLeftColumn` 是唯一判据**，App（标题栏是否占轨道）与 SheetLayout（`data-sidebar`）共用，避免两处各算一套。
7. **新增左栏拖拽实时调宽**：与右栏手柄同形（`role="separator"` + 指针捕获 + 方向键），拖拽中把宽度直接写到 `.app` 的 CSS 变量上，抬起时经 `setLeftRailWidth` 落库（clamp 复用 `clampLeftRailWidth`）。

保留 `sheetMode` 枚举字符串不变，仅改变 `'sheet'` 的渲染路径语义：由「Sheet 自画」变为「左栏内容挂共享几何类 `.sidebar`」。

## 后果

- 正面：任一 Sheet（含插件贡献的新 kind）左栏与标题栏分割线由构造保证共线，不再逐 Sheet 漂移；折叠后无空列、无悬空分割线；新增拖拽实时调宽。
- 正面：消灭了 PrismSheet 里逐个数 8 个 Sheet 类名的 `:is(...)` 枚举——该枚举每加一个 Sheet 就漏一个。
- 负面：`sheetMode: 'sheet'` 的契约从「Sheet 拥有左栏节点与几何」变为「Sheet 只出内容，几何归布局」；`SheetInternalSidebars.test.tsx` 等契约测试按新模型改写（见开发记录，逐条登记，未降级断言）。
- 负面：`PrismSheet` 的 `.ps-nav::before`（PRISM 标题）与 `.sidebar::before`（侧栏背景）争同一伪元素，已改为真实元素 `.ps-nav-kicker`。
- 风险：宽度真值住在 `.app` 的 CSS 变量上，而拖拽手柄在 `.layout` 里，故拖拽用命令式写变量 + 抬起落库；这是刻意取舍（否则每次 pointermove 都要重渲染整棵 Sheet 子树）。
- 风险：完全「内容也归布局」（注册表 `sidebar:`）仍未完成，`SheetSidebarSlot` 目前只服务 agent 一个 kind。若要继续，需先上提各 Sheet 左栏状态。

## 证据

- `src/domains/theme/themeCssSnapshot.ts`（唯一真值发射）
- `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css`（`.sidebar` 宽度取自真值 + 折叠态）
- `src/plugins/product/packages/builtin.pylon-shell/styles/App.css`（`.layout[data-sidebar="expanded"]::before` 分割线 + `.left-rail-resize-handle`）
- `src/workspace-sheets/LeftRailResizeHandle.tsx`、`src/workspace-sheets/SheetLayout.tsx`（`data-sidebar`）、`src/workspace-sheets/sheetSidebarState.ts`（`sheetHasLeftColumn`）
- 静态契约：`src/workspace-sheets/__tests__/sidebarUnifiedModel.css.test.ts`（6 项：唯一真值 / 旧 token 不得复活 / 唯一分割线 / 各 Sheet 无竖边框 / 折叠可见性 / 手柄）
- 行为契约：`src/sheets/__tests__/SheetInternalSidebars.test.tsx`、`src/workspace-sheets/__tests__/sheetLayoutSidebarCollapsedReactive.test.tsx`、`src/sheets/file/__tests__/FileSheetView.sidebarSingleState.test.tsx`
