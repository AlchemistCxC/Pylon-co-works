# 开发记录 · #154 阶段 4：设置由固定覆盖层迁入 sheet 体系（收口轮）

## 元信息

- issue：AlchemistCxC/Pylon-co-works#154（refactor，残余收口）
- 分支：`Ru5t/Reflector`
- 提交：`a221857e`（阶段 4）、`eb200bb5`（#172，另见 issue-172 记录）
- spec：`.agents/spec/154-unified-sidebar-model.md` 阶段 4
- 前序：ADR-0009（左列模型）、ADR-0011（区块栈）、ADR-0012（右栏亲和）、
  `154-unified-sidebar-model.md`（阶段 1/3）、`154-titlebar-and-context-rail.md`（阶段 2）

## 用户裁定（本轮开工前确认）

1. 阶段 4 本轮一并做完（#154 关闭前无遗留）。
2. spec 阶段 2 第 1 项「左轨道填身份（Agent\Profile）」**正式放弃**——左栏底部已有
   profile 条；此项从未实现、此前也无放弃记录，现补记。
3. 不授权消耗额度造真实会话；上轮遗留的「会话行真实数据实机复核」维持未复核记录，
   不阻关闭。折叠 0 宽与拖拽等几何项（不耗额度）本轮复测。

## 实现

### 新 settings sheet kind

- `SHEET_KINDS` 增 `'settings'`（9→10，`sheetTypes.ts`）。
- 注册（`builtinWorkspacePlugins.ts`）：singleton、`getSingletonKey: singleton('settings')`、
  `sidebarMode:'sheet'`、`component: SettingsSheetView`、`sidebar: SettingsSheetSidebar`、
  状态 codec = `settingsSheetState`。不声明 launch（launcher 的「设置」管理项经
  `openOrFocusSettingsSheet` 打开，避免列表双入口）。
- `defineWorkspace` 放宽为 codec 可选（既有零状态 kind 不受影响）。

### 状态与深链（契约零迁移）

- `settingsSheetState.ts`：`SettingsSheetState = SettingsIntent + rendererCategoryId?`；
  归一口 `normalizeSettingsSheetState` → `normalizeSettingsIntent`——LEGACY 路由别名、
  domain-only 落首分区、plugins 未知分区保留为 pluginPageId 全部沿用；serialize/
  deserialize 幂等。
- `settingsSheetNavigation.ts`：`openOrFocusSettingsSheet(intent)` 幂等入口——已开则
  `patchSheetState`（codec 归一）+ 聚焦，未开则带状态打开。App 层 `pylon:open-settings`
  监听、标题栏齿轮、SheetLauncher 管理项三入口收敛于此；事件名与 detail 形状不变，
  ErrorCenter / Overview / CwdSettingsPanel 派发方零改动。

### 一二级同栏导航（SettingsSheetSidebar）

- 上半：4 个一级域（字形 + 名称 + 描述，active 态）；下半：当前域分区（小字号缩进），
  沿用 K-2 二级折叠、K-4 置顶（localStorage chrome 态）、插件页条目；页脚：重置主题
  两段式确认（#116 子项 9 语义原样迁入）。
- renderers 三级项点击经 sheet 状态 `rendererCategoryId` 驱动主区目录（两树通过
  patchSheetState + codec 通信，生产 SheetHost/SheetSidebarSlot 均反应式读 store）。
- 非渲染器子组点击保留锚点滚动 + 高亮脉冲（两树同文档，querySelector 可达）。

### 主区（Settings.tsx 剥壳）

- 删对话框外壳：`role=dialog` / `aria-modal` / 焦点陷阱 / `settings-header` / 关闭钮
  （sheet 由页签与 titlebar 关闭）；根类保留 `.settings`（各界面模式皮肤钩子不变），
  CSS 端 `position:fixed` 全视口覆盖层退位为 sheet 主区填充。
- 导航真值 `{domain, section, pluginPageId, agentId, rendererCategoryId}` 改 sheet 状态
  （patchSheetState，serialize 端 codec 归一兜 domain 反查）；`activeSessionId` 改读
  `ctx.activeSession`；`AgentRuntimePanel` 的 initialAgentId 改读 `state.agentId`。
- 贡献目录投影（插件页/上下文面板/渲染器注册表订阅 + 值适配器包装）抽
  `useSettingsContributionCatalog` 共享 hook——主区与左栏是两棵 React 树，共用同一投影。
- 中控「布局编辑」按钮进入编辑态时关闭设置 sheet（对齐旧 `onClose` 语义）。
- CSS：删 header/close/nav-context 全部规则（含三界面模式皮肤）；新增
  `.settings-sheet-nav` 一二级分层样式；`lazyWorkspace`/`lazyPanel` 泛型化透传 state。

## 测试处置（逐条登记，无断言降级）

| 文件 | 处置 |
| --- | --- |
| `sheetRegistrySidebarMode.test.tsx` | 改写：旧断言「mode='sheet' 一律无注册表 sidebar」随阶段 4 反转——settings 是首个 `mode='sheet' + sidebar` kind；其余 kind 仍逐一点名保持现状 |
| `scripts/sheetState.compat.test.mts` | 9 kind → 10 kind（计数与注释更新） |
| `B-03-settings-dialog.test.tsx` | 改写：对话框语义（role/aria-modal/焦点陷阱/关闭钮恢复焦点）随覆盖层退役，改钉 sheet 语义（无对话框角色、导航点击经 sheet 状态回路驱动正文） |
| `settingsDomainNav.test.tsx` | 改写挂载面（共享 harness），事件断言改走 `openOrFocusSettingsSheet`（App 接线同一入口）；「无一级域导航」语义反转断言为「左栏上半 4 域」 |
| `Settings.a11y / customPreset / agentOnboarding / pluginManagerDefaultPage / agentStatusConsumerMatrix` | 仅改挂载面（`<Settings initialDomain/>` → `mountSettingsSheet(intent)`），断言原文不动 |
| 新增 `settingsSheetState.test.ts` | codec 归一/别名/幂等往返 6 例 |
| 新增 `settingsSheetNavigation.test.ts` | 打开/幂等 patch+聚焦/别名 3 例 |
| 新增 `src/test/settingsSheetHarness.tsx` | 生产同构挂载助手（真实 store + registry 种子 + 反应式读 state） |

## 门禁

- `tsc -b` 无输出；`eslint src/` 0 error；`check:first-party-styles` 23 文件、
  `check:css-var-consumption`（死注入/悬空引用 0）、`check:tailwind-tokens`、`check:docs`
  通过；bundle 总 gzip 1,600,220 B，预算按惯例重定标 1,615,000（净增 0.014%，附dated注释）。
- **全量 605 文件 / 4423 用例 + 2 todo 通过**（issue150 稳定性用例全量偶发一次，单跑绿，
  属 #175 已登记的调度型 flake 家族）。

## 实机验收（webview2 MCP，重建二进制后，CDP 9222）

| 验收项 | 结果 |
| --- | --- |
| 深链 `pylon:open-settings` 打开设置 sheet | ✅ singleton 聚焦、`data-settings-domain=appearance` |
| 一二级同栏 | ✅ 4 域 + 8 个分区/动作按钮；点「工作区」→ section=window、正文渲染「当前尺寸」 |
| 分割线对齐（settings 为活动 sheet） | ✅ 标题栏左格右缘 = 左列右缘 = 240；轨道处带右边框元素恰好 1 个 |
| 折叠 0 宽 | ✅ `data-sidebar=collapsed`、左列轨道 0、正文 left=0、折叠钮恒在（rail 42）；展开复原 240 |
| 拖拽实时调宽 | ✅ pointermove 中双侧跟随（320.47/323，宽度过渡相位差）、抬手双侧 323 且 v3 `leftRailWidth=323` 落库 |
| 重开应用保持 | ✅ 整页 reload 后设置 sheet 仍为活动页签，状态恢复 workspace › 窗口，几何对齐 |
| #172 联动（同轮实机） | ✅ 空态无工作区提交失败显示后端原文 + 错误中心可分类 code（详见 issue-172 记录） |

## 遗留 / 观察登记

1. **左栏宽度重载后回到 240**（拖拽落库 323、整页 reload 后读 240）：左栏宽度存在
   workspaceStore 与 rightRailStore 双真值（`pylon-workspace-layout-v3` 单键内嵌双份字段），
   水合路径的消费顺序决定终值。该路径属 ADR-0009 几何域，本轮未触碰；重载保持性上轮
   已按当时口径验收过，此现象留档待专项核实，不阻 #154 关闭。
2. 会话行真实数据表现未实机复核（维持上轮记录；用户裁定不消耗额度）。
3. 既有（非本轮引入）：`check:solid` 的 R2 门禁红——`src/domains/workbench/sidebarModulePrefs.ts`
   import `plugin-runtime/sidebar/sidebarTypes`（`539a5642` 引入，CI 只跑 `check:frontend`
   故未暴露）；该文件属侧栏域，未经裁不动，留用户处置。
