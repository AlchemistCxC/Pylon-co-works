# Dev Record — #154 统一侧栏模型（左列几何归布局层）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/154-unified-sidebar-model.md`

## 元信息

- issue：AlchemistCxC/Pylon-co-works#154
- 分支：`Ru5t/Reflector`
- 提交范围：`5021082b..<本片 head>`（`5021082b` 为 L.md 域声明）
- 日期：2026-09-18
- 决策：`.agents/decisions/0009-unified-left-column-model.md`

## 目标与范围

**目标**：用户报告「部分页面的左侧栏分割线与标题栏折叠按钮/状态灯右边的分割线无法对齐，成因基于 sheet 自身数据（浏览器 sheet、gateway）」，要求**统一侧栏模型**；并明确「折叠后不要紧凑左列」（Agent 的空列、File 的图标条都不要）、「折叠按钮向右挤压消灭空列」、「布局层承载 + 拖拽实时调宽」。

**本片做**：左列几何（宽度 / 竖直分割线 / 折叠可见性）收归布局层；折叠 = 0 宽；新增左栏拖拽实时调宽。

**本片不做**：标题栏排布优化（身份填入左轨道、sheet 格宽度 token 化、sheet 总宽贴合、设置菜单收敛）；左栏视觉排布重构；设置迁入 sheet 体系；左栏新 UI/占位（用户待补充）。中控区全程未碰。

> 说明：用户最初的四项诉求中，本片只完成「统一侧栏模型」这一项（它是其余三项的地基）。标题栏排布、左栏视觉重构、设置迁入 sheet 仍待做。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/theme/themeCssSnapshot.ts` | 四套宽度 token 收敛为 `--sheet-sidebar-track-width`；删 `WORKSPACE_SIDEBAR_COLLAPSED_WIDTH` 与 `ThemeCssLayout.sidebarExpandedTrack` | 修改 |
| `src/plugins/product/packages/builtin.pylon-shell/styles/App.css` | 标题栏取新 token；左格仅展开态画边框；折叠按钮样式；`.layout[data-sidebar]` 唯一分割线；`.left-rail-resize-handle`；删三处 42px 折叠断点 | 修改 |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css` | `.sidebar` 取新 token、去掉自带边框；折叠态改由 `.layout[data-sidebar="collapsed"]` 负责；删 `.sidebar.collapsed` | 修改 |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css` | `.file-sidebar` 去宽度/边框、改内部 row 排布；删 `.file-sidebar.collapsed` 与 activity 栏的 42px 折叠义 | 修改 |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/components/PrismSheet.css` | `.ps-nav` 去宽度/边框；删逐个数 8 个 Sheet 类名的 `:is(...)` 枚举；`.ps-nav::before` → `.ps-nav-kicker` | 修改 |
| `src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/OverviewSheetView.css` | `.overview-sidebar` 去宽度/边框 | 修改 |
| `src/workspace-sheets/LeftRailResizeHandle.tsx` | 左栏拖拽实时调宽手柄（新增） | 新增 |
| `src/workspace-sheets/SheetLayout.tsx` | `.layout` 增 `data-sidebar`；挂载手柄；共用 `sheetHasLeftColumn` | 修改 |
| `src/workspace-sheets/SheetSidebarSlot.tsx` | 注释与几何归属说明（渲染路径不变） | 修改 |
| `src/workspace-sheets/sheetSidebarState.ts` | 新增 `sheetHasLeftColumn`（App 与 SheetLayout 的唯一判据） | 修改 |
| `src/workspace-sheets/WorkspaceTitlebar.tsx` | 删 `sidebarExpandedTrack`；左格只留状态灯；折叠按钮移入右侧应用控制簇 | 修改 |
| `src/App.tsx` | `sidebarEnabled` 改用 `sheetHasLeftColumn` 并计入主题 `showSidebar`；删 `sidebarExpandedTrack` 传递 | 修改 |
| `src/components/Sidebar.tsx` | 左栏外壳改挂共享几何类 `.sidebar`，不再自判折叠 | 修改 |
| `src/components/PrismSheet.tsx` | 删 `sidebarCollapsed` 透传；`.ps-nav` 挂 `.sidebar`；PRISM 标题改真实元素 | 修改 |
| `src/sheets/PrismManagerSheetView.tsx` | 不再透传折叠状态 | 修改 |
| `src/sheets/{Overview,Runtime}SheetView.tsx`、`src/sheets/{search/Search,history/History,gateway/Gateway,browser/Browser}SheetView.tsx`、`src/sheets/file/FileSheetSidebar.tsx` | 左栏去自带宽度/边框/局部窄屏断点；去 `{!ctx.sidebarCollapsed && …}` 门 | 修改 |
| `src/rightRailStore.ts` | 新增 `clampLeftRailWidth`，setter 复用它 | 修改 |
| `src/domains/theme/__tests__/themeCssSnapshot.test.ts` | 契约改写为唯一真值 + 旧 token 不得复活 | 修改（见下） |
| `src/sheets/__tests__/SheetInternalSidebars.test.tsx` | 契约改写（见下） | 修改 |
| `src/sheets/file/__tests__/FileSheetView.sidebarSingleState.test.tsx` | 契约改写（见下） | 修改 |
| `src/workspace-sheets/__tests__/sheetLayoutSidebarCollapsedReactive.test.tsx` | 观察点从 Sheet 私有类改为布局状态 | 修改（见下） |
| `src/workspace-sheets/__tests__/workspaceTitlebarSidebarToggle.test.tsx` | 折叠按钮契约改写（见下） | 修改 |
| `src/plugin-runtime/shell-recipe/__tests__/shellRecipeCssContract.test.ts` | 镜像规则断言换 token；排列属性谓词纳入 `right:` | 修改（见下） |
| `src/workspace-sheets/__tests__/sidebarUnifiedModel.css.test.ts` | 新增静态契约 6 项 | 新增 |

## 方案要点

1. **一个真值**：`--sheet-sidebar-track-width`（展开 = 用户宽；折叠或本 Sheet 无左栏 = 0）。实测驱动它的四个旧 token 全部退休，并以「旧 token 不得复活」断言钉住。
2. **一条分割线**：改由布局层 `.layout[data-sidebar="expanded"]::before` 绘制；各 Sheet 不再自画。这样「两条独立线各自漂移」在结构上不可能再发生（Browser 曾因此错开 84px）。
3. **折叠是布局状态**：`.layout[data-sidebar="collapsed"] .sidebar { visibility:hidden }`。用 `visibility` 而非只靠宽度裁剪，是因为宽度 0 挡得住像素、挡不住键盘焦点。
4. **按钮必须离开左格**：折叠后左轨道为 0 宽，按钮留在左格会随之消失 ⇒ 无法再展开。故并入右侧应用控制簇，且无左栏时不渲染（替代原 disabled）。
5. **拖拽用命令式写变量 + 抬起落库**：宽度真值在 `.app`，手柄在 `.layout`；若用 React 状态驱动需上提或加 context，且每个 pointermove 都要重渲染整棵 Sheet 子树。落库复用既有 `setLeftRailWidth`（clamp 160/520 + v3 持久化），与右栏「抬起才提交」一致，避免每帧写 localStorage。
6. **`sheetHasLeftColumn` 单一判据**：App（标题栏是否占轨道）与 SheetLayout（`data-sidebar`）共用。初版误用「注册表是否声明 `sidebar:`」，会让 7 个由自己视图渲染左栏的 Sheet 被判为「无左栏」而整体隐藏——已修正为按 `sidebarMode` 判定。
7. **`.ps-nav::before` 让位**：一个元素只有一个 `::before`，`.sidebar` 已占用它作侧栏背景，故把 PRISM 标题改为真实元素 `.ps-nav-kicker`（渲染位置与样式等价）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 逐 sheet 实测「标题栏分割线 x == 左栏分割线 x」 | **未完成**——验收时 Pylon 实例已关闭（webview2 调试端点不可达），需重启后按下方口径补测 |
| 左列区域仅一个元素带 `border-right` | 静态契约已钉（`sidebarUnifiedModel.css.test.ts`）；实机数值待补 |
| 折叠态左列宽 0、无残余列与悬空分割线 | 静态契约已钉（折叠态规则 + 手柄隐藏）；实机数值待补 |
| 折叠态 `.file-activity-bar` 不可见 | 由 `.layout[data-sidebar="collapsed"] .sidebar { visibility:hidden }` 覆盖（继承到后代） |
| 拖拽实时改宽 + clamp 160/520 + 持久化 | 实现完成；单测覆盖 clamp 与 setter（`rightRailStore`），实机交互待补测 |
| `sidebarMode` 三字符串值与持久化面零迁移 | 是：枚举未改，未动 `pylon-workspace-layout-v3` 与 `applyWorkspaceLayoutChange` |
| `tsc -b` | 我的文件 0 错误（仅并行 #155 的未跟踪文件报错，见「并行交集」） |
| `lint` | 0 error / 1 既有 warning（`RightRailHost.tsx` useMemo 依赖，非本次） |
| `check:first-party-styles` / `check:tailwind-tokens` | 通过 |
| 定向 vitest（workspace-sheets + sheets + file + browser + theme + shell-recipe） | **81 文件 / 442 项全绿** |
| `check:frontend` | 阻塞：`tsc -b` 阶段失败于并行 #155 的未跟踪文件（相对路径多一层 `../`），与本次无关 |

**实测基线（改动前，webview2 MCP，视口 1200×800，左栏 240）**：Agent 展开 标题栏 240 / 左列 240（两条独立 border）；Browser 展开 **240 / 156（错开 84px）**；Gateway 展开 240 / 240（宽度巧合相等，仍是两条独立线）；Gateway 折叠 标题栏轨道 42px 带 border、左列不存在 ⇒ 悬空分割线；`--sheet-sidebar-width` 折叠时仍为 240（不感知折叠）。

**改动后补测口径（重启 Pylon 后执行）**：逐 sheet 量 `.workspace-titlebar-sidebar` 的 `right`（展开态）与本 sheet 左栏 `.sidebar` 的 `right`，要求数值相等且 `document.querySelectorAll` 中带 `border-right` 的左列元素计数为 1；折叠态量 `.workspace-titlebar-sidebar` 宽为 0 且 `.layout[data-sidebar]` 为 `collapsed`。

## 测试处置

逐条点名（均为**契约改写**，非删除；断言强度未降）：

- `src/domains/theme/__tests__/themeCssSnapshot.test.ts` —— 原「token 冻结 42px」块改写为 `#154 左列唯一宽度真值契约（折叠 = 0）`：折叠 0 / 展开取用户宽 / 无左栏为 0，并**新增**「四套旧 token 不得复活」断言（原断言无此维度）。
- `src/sheets/__tests__/SheetInternalSidebars.test.tsx` —— 原断言「折叠时 Sheet 自行把侧栏从 DOM 摘掉」改为三条：左栏挂 `.sidebar`、左栏无自带几何（正则禁止旧 token 与 `w-[`/`basis-[`/`border-r`）、折叠时左栏仍在 DOM。原「折叠后用户看不到」由布局层状态保证，已由新增的 CSS 契约静态钉住。
- `src/sheets/file/__tests__/FileSheetView.sidebarSingleState.test.tsx` —— 原「折叠→`collapsed` 类（保留 42px 功能图标栏）」改为「左栏挂 `.sidebar`、无 collapsed/hidden 类、`ctx.sidebarCollapsed` 变化不改变左栏类集合」。
- `src/workspace-sheets/__tests__/sheetLayoutSidebarCollapsedReactive.test.tsx` —— 观察点从 `.sidebar.collapsed` 私有类改为 `.layout[data-sidebar]`（**新增**一条「手柄只在左列可见时存在」断言）。被测风险（响应式订阅 vs 陈旧 getState 快照）不变。
- `src/workspace-sheets/__tests__/workspaceTitlebarSidebarToggle.test.tsx` —— 原「无侧栏→按钮禁用」改为「完全不生成按钮」；**新增**「按钮位于右侧应用控制簇且不在左格」「折叠后状态灯隐藏」「aria-expanded」三条；原「复用同一节点」保留。
- `src/plugin-runtime/shell-recipe/__tests__/shellRecipeCssContract.test.ts` —— 镜像规则正则换用新 token；排列属性谓词由 `right:0` 放宽为 `right:`，以便容纳镜像后的分割线换边（仍只允许排列类声明）。
- 新增：`src/workspace-sheets/__tests__/sidebarUnifiedModel.css.test.ts`（6 项静态契约，是本片的主要防回归护栏）。
- 未改动的相关测试（原样通过）：`workspaceTitlebar.css.test.ts`、`Sidebar.css.test.ts`、`BrowserSheet.css.test.ts`、`FileSheet.css.test.ts`。

## 证据

- commit：本片提交（见 `git log` 本记录标题同名提交）
- 测试：`bunx vitest run src/workspace-sheets src/sheets/__tests__ src/sheets/file src/sheets/browser src/components/__tests__/Sidebar.css.test.ts src/domains/theme/__tests__ src/plugin-runtime/shell-recipe` → 81 文件 / 442 项，退出码 0
- 门禁：`check:first-party-styles` 23 files 通过；`check:tailwind-tokens` 通过；`lint` 0 error
- 手工验证：**未完成**（实例关闭）。改动前的基线数值已用 webview2 MCP 实测记录在上文。

## 与 spec 的偏差

1. **spec 写「8 个 Sheet 把 `<aside>` 抽成注册表 `sidebar:` 组件」，实际未做。** 原因：实测 6 个 Sheet 的左栏都读 Sheet 局部状态（`filtered`/`filter`、`results`/`query`、`paged`、`status`/`sessions`），File 的左栏还渲染 Sheet 的 `children` 面板树；迁走需先整体上提状态，属独立大重构。本片改为「左栏挂共享几何类 `.sidebar`」——宽度/分割线/折叠三个所有权都归布局层，Sheet 不再持有几何。这一点已写入 ADR-0009 的备选方案与风险。
2. **spec 未写「折叠按钮移入右簇」是必需项**，实施中发现它是必需：折叠后左轨道 0 宽，按钮留在左格会随之消失，用户将无法再展开。
3. **spec 未预见 `.ps-nav::before` 与 `.sidebar::before` 争伪元素**，实施中把 PRISM 标题改为真实元素。
4. **spec 提到「`.file-activity-bar` 折叠时随外壳一起消失」**——实现方式不是条件渲染，而是布局层 `visibility:hidden` 继承（同时解决键盘焦点）。
5. `check:frontend` 未能全绿，原因在并行 agent 的未跟踪文件（见下），非本次改动。

## 未解问题

1. **实机数值验收待补**：Pylon 实例在我完成改动前关闭，逐 sheet 的「分割线 x 相等」与拖拽手感未实测。补测口径见上。
2. **完全的内容归属**：注册表 `sidebar:` 仍只有 agent 一个 kind；`SheetSidebarSlot` 的注释已按新模型说明，但其余 7 个 kind 的左栏内容仍由各自视图渲染。若继续，需先上提各 Sheet 左栏状态。
3. `src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css` 里 W2-11 遗留的 `.sidebar-status-bar/-light/-label` 仍是死 CSS（全仓无渲染点），等用户的左栏占位想法确定后再决定复活或删除。
4. `BrowserSheetView` 内部仍有「折叠态适配」的类分支（`justify-center` 等），新模型下折叠即整体隐藏，这些分支已无视觉作用；未清理以免扩大 diff。

## 并行交集

- 本片碰过、其他贡献者需避让的共享文件：`src/plugins/product/packages/builtin.pylon-shell/styles/App.css`、`src/plugins/product/packages/builtin.pylon-workspace/styles/components/{Sidebar,PrismSheet}.css`、`src/App.tsx`、`src/workspace-sheets/{SheetLayout,SheetSidebarSlot,WorkspaceTitlebar}.tsx`、`src/domains/theme/themeCssSnapshot.ts`、`src/rightRailStore.ts`。
- **未触发**：`src-tauri/tauri.conf.json`（那处 `--remote-debugging-port=9222` 未提交改动按板规未提交，且它是 webview2 MCP 能连上的前提）。
- **#155（内核落盘，ADR-0008）正在并行提交**，其未跟踪文件 `src/__tests__/replay/{invariants,fixtures}.ts` 因相对路径多一层 `../`（`../../../domains/events/...` 解析到仓库根）而 `tsc -b` 报「Cannot find module」；`check:frontend` 因此阻塞。已在 `.agents/L.md` 留言提示，未触碰其文件。
