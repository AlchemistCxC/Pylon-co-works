# Dev Record — #90 Shell Recipe 重排层（界面模式可声明 Shell 布局重排）

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/90
- 分支：`Ru5t/Reflector`
- 提交范围：`9692dfc0..<head>`（见 PR）
- 日期：2026-09-15
- 路线决策：ADR-0003（`.agents/decisions/0003-shell-recipe-rearrangement.md`）

## 目标与范围

界面模式可声明 Shell 布局**重排**：模式经 `shellRecipeId` 引用 Shell Recipe，声明会话侧栏与上下文面板所在侧（v1 双栏互斥）。宿主仍渲染骨架——**不做什么**：不替换原生窗口控制与拖拽区；不动 `SheetLayout`/`WorkspaceTitlebar` 结构与 keep-alive 不变量（W1-03/A17/G5/FE-AUD）；不做整壳替换；不动 `shellSurface` overlay 的标题栏边界；不改持久化 schema。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugin-runtime/shell-recipe/` | `shellRecipeTypes`（类型 + `DEFAULT_SHELL_RECIPE`）/ `shellRecipeRegistry`（校验 + 注册表）/ `pluginShellRecipeApi`（插件 API）及 `__tests__` | 新增 |
| `src/plugin-runtime/runtimeServices.ts`、`pluginHostServices.ts`、`pluginActivationContext.ts`、`shadowUpdate.ts`、`management/pluginContributionProjection.ts` | 注册表挂载、getter、`shellRecipes` API + transaction 穿线、`shell-recipes` 贡献投影 | 修改 |
| `src/plugin-runtime/interface-mode/interfaceModeTypes.ts` | 删除零消费预留字段 `titlebarRecipeId`/`leftRailRecipeId`/`rightRailRecipeId`，增 `shellRecipeId?`（ADR-0003 决策 2） | 修改 |
| `src/plugin-runtime/interface-mode/interfaceModeRegistry.ts` | `shellRecipeId` 结构校验（id pattern） | 修改 |
| `src/plugin-runtime/renderers/rendererSuiteReferences.ts` | 跨注册表校验增 `shellRecipeId` 存在性（`shellRecipes?` 图参数，向后兼容） | 修改 |
| `src/application/transactions/activateInterfaceMode.ts` | `interfaceModeIsUsable` 纳入 recipe 存在性；新增渲染期兜底 `resolveShellRecipe`；引用校验图传入 recipes | 修改 |
| `src/plugins/core/interfaceMode/builtinInterfaceModes.ts`、`src/plugins/product/builtinPylonRenderers.ts` | 三内置模式引用 `builtin.shell.classic`；先注册默认 recipe 再注册模式 | 修改 |
| `src/App.tsx` | 订阅 recipe registry；`.app` 根写 `data-shell-sidebar-side` / `data-shell-context-side`（仅数据属性，零结构改动） | 修改 |
| `src/plugins/product/packages/builtin.pylon-shell/styles/App.css` | 尾部追加重排规则块：`.layout` flex order 互换、边框/resize 手柄朝向、标题栏 grid 列镜像 | 修改 |
| `src/sdk/index.ts`、`src/sdk/testing.ts`、`src/sdk/__tests__/sdkExports.test.ts` | 导出 `PluginShellRecipeApi`/`ShellRecipeContribution`/`ShellRailSide`；测试基建 mock 增 `shellRecipes` 面 | 修改 |
| `docs/说明书/Pylon-插件系统说明书-用户版.md` | §8 漂移修正（三内置模式 + 插件可注册完整模式）+ Shell Recipe 用户可见表述 | 修改 |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md` | §6.4.1 前后：`interfaceModes.registerMode` 契约改写 + Shell Recipe 契约 | 修改 |
| `.agents/records/`、`.agents/decisions/` | 本记录、ADR-0003 | 新增 |

## 方案要点

1. **单 recipe 取代 per-rail 三预留字段**：三字段零消费（全仓仅类型声明），且多区域独立声明需要一致性仲裁层；单 recipe 内 `sidebarSide ≠ contextPanelSide` 由注册表校验闭环（ADR-0003）。
2. **数据属性 + CSS，而非 DOM 重排**：CSS 枚举解析值（`left`/`right`）而非 recipe id，插件自定义 id 不进样式层；`.layout` 子项用 flex `order`（右栏 `-2`、侧栏 `2`、主区默认 `0` 居中，绕开 keep-alive `display:contents` 包装的选择器难题）；标题栏 3 直接子项 grid auto-placement + 轨道块 `order:4`。
3. **韧性与既有语义对齐**：`interfaceModeIsUsable` 把悬空 recipe 视为模式不可用（与 workbench surface 同款硬约束），回退走既有 A17 链；`resolveShellRecipe` 在渲染期对瞬态（HMR/热换窗口）兜底 `DEFAULT_SHELL_RECIPE`，不影响激活语义。跨注册表校验沿用全图遍历——悬空引用在场时任何激活被拒（既有行为，测试固化）。
4. **API 版本策略**：`shellRecipes` 与 `titlebar`/`interfaceModes` 同为激活上下文加法式扩展，不设 capability 门，不 bump `PYLON_PLUGIN_API_LATEST`。

## 验收标准与结果

spec 验收逐条：

1. 内置模式行为不变 → 默认解析值 left/right，重排 CSS 只在 `"right"` 时命中；既有 appearance/preset 契约测试原样通过。
2. 重排生效 → 契约测试锁定 App 根数据属性写入 + App.css 互换/镜像规则（`shellRecipeCssContract.test.ts`）。
3. 注册表校验逐例 → `shellRecipeRegistry.test.ts`（id/label/order/side 枚举/两侧互斥/shadow 替换与 revert）。
4. 悬空引用拒绝激活 + 回退 → `interfaceMode.test.ts`（`interfaceModeIsUsable` false、`activateInterfaceMode` false、`ensureInterfaceModeProfile` 回退默认模式）。
5. 渲染期兜底 → `resolveShellRecipe` 对 undefined/悬空 id 均返回 classic。
6. keep-alive 不变量 → `SheetLayout.tsx` / `WorkspaceTitlebar.tsx` 零改动；全量测试无既有用例修改（仅 harness 增补默认 recipe 注册）。
7. 门禁 → `tsc -b` 0 错误；vitest 全量 3738+ 通过；`check:solid`、`check:frontend`（lint 0 error，唯一 warning 位于未触碰的 `RightRailHost.tsx`，属基线）退出码 0；Rust 零改动。

## 测试处置

- 新增：`shellRecipeRegistry.test.ts`（3）、`shellRecipeCssContract.test.ts`（4）、`rendererSuiteReferences.test.ts` 增 shellRecipeId 用例（1）、`interfaceMode.test.ts` 增激活/兜底/回退用例（2）。
- 既有行为测试：无删除、无断言弱化；`interfaceMode.test.ts` 与 `customPresetOverwrite.test.ts` 的 harness 增补 `DEFAULT_SHELL_RECIPE` 注册（内置模式引用它，激活期校验要求在场）；`sdkExports.test.ts` 增编译期面断言。

## 未决/后续

- 同侧堆叠（双栏同侧）留待后续旋钮（数据属性可平滑扩展）。
- `titlebar` 区段级重排（如窗口控制列位置语义）需产品决策，本期只做随侧栏的镜像。
