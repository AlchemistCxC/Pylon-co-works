# ADR-0003 Shell Recipe：界面模式声明 Shell 布局重排，宿主保留渲染权

- **日期**：2026-09-15
- **状态**：已采用
- **关联**：issue #90；spec `.agents/spec/issue-90-shell-recipe.md`

## 背景与约束

`InterfaceModeContribution` 预留的 `titlebarRecipeId` / `leftRailRecipeId` / `rightRailRecipeId`（`interfaceModeTypes.ts:32-34`）自引入起零消费，插件没有正规通道参与 Shell 骨架重排。同时存在硬约束（红线）：

1. 原生窗口控制与拖拽区（`data-tauri-drag-region`）必须保持宿主所有（`titlebarTypes.ts:4-6` 契约）；
2. `SheetLayout` 的 keep-alive 不变量（agent/file/browser 保活、hydration 守卫、持久化报错）不可为布局而重构；
3. overlay shell surface 不得越过标题栏（`App.css` inset/z-index 边界）；
4. 韧性链（A17：插件注销 → 模式不可用 → 回退默认模式）必须覆盖新增引用，不留半套状态。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| A. 按预留字段实现三个 per-rail recipe（标题栏/左栏/右栏各自独立声明） | 三个区域声明可能互相矛盾（标题栏轨道侧与侧栏侧不一致），需要额外一致性仲裁层；v1 无对应需求，复杂度不划算 |
| B. 整壳接管：模式提供 isolated-surface 渲染全部 Shell | 触发红线 1/2：窗口控制归属与 keep-alive 舞台契约是独立的大决策（周级），不本期 |
| C. 插件 CSS 自由重排（无 selector 沙箱下用布局类选择器） | 契约外行为，壳层重构即碎，无法测试、无法门禁 |
| D. **单一 ShellRecipe 声明排列参数，宿主渲染骨架，CSS flex order 消费（采用）** | — |

## 决定

1. 新增 `ShellRecipeContribution`（v1 旋钮：`sidebarSide` / `contextPanelSide`，枚举 `'left' | 'right'`，二者互斥），注册表克隆 `ValidatedContributionRegistry` 范式，插件经 `shellRecipes.registerRecipe` 注册。
2. `InterfaceModeContribution` 以单一 `shellRecipeId?: string` **替换**三个预留字段（预留从未消费，无兼容负担；引用存在性走跨注册表校验，与 `quickSwitchTargetId` 同轨）。
3. 重排以**解析值数据属性 + CSS**实现（`data-shell-sidebar-side` 等），DOM 结构零改动；CSS 枚举解析值而非 recipe id，插件自定义 id 不进入样式层。
4. 可用性与韧性：`interfaceModeIsUsable` 纳入 recipe 存在性（硬约束，走既有 A17 回退链）；渲染期解析兜底 `DEFAULT_SHELL_RECIPE`（瞬态防白屏，不影响激活守卫语义）。

## 后果

- 正面：插件获得受支持、可校验、可测试的重排通道；宿主渲染权与红线全部保留；接口形状与既有注册表范式一致，维护成本低。
- 负面：`InterfaceModeContribution` 类型变更（删除预留字段）对已编写却从未可用的字段引用是 breaking——实际无消费方，风险为零。
- 风险：v1 双栏互斥语义未来若需同侧堆叠，需要第二版旋钮（届时数据属性可平滑扩展，CSS 规则增量添加）；标题栏 grid 镜像依赖 `WorkspaceTitlebar` 直接子项结构，壳层大改时需同步镜像规则（已有作用域先例约束在同文件内）。

## 证据

- 预留字段零消费：grep `titlebarRecipeId|leftRailRecipeId|rightRailRecipeId` 全仓仅 `interfaceModeTypes.ts:32-34`。
- overlay 边界：`builtin.pylon-shell/styles/App.css:9-14`（inset 从 `--titlebar-h` 起步）与 `:20`（标题栏 z-index 100）。
- keep-alive 不变量：`src/workspace-sheets/SheetLayout.tsx:171-207`（agent/file/browser 保活包装）。
- 回退链：`src/application/transactions/activateInterfaceMode.ts:146-165`（`ensureInterfaceModeProfile`）。
- 数据属性作用域先例：`builtin.pylon-workspace/styles/components/Sidebar.css:269`（`[data-interface-mode]` 选择器）。
