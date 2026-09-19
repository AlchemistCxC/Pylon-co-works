# ADR-0013 设置导航真值迁入 sheet 持久化体系

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0013-settings-navigation-state-persists-in-sheet-system.md`

- **日期**：2026-09-19
- **状态**：已采用
- **关系**：消费 ADR-0009（左列几何单一主人）与 ADR-0012（右栏亲和模型）确立的 sheet 宿主地基；归属 #154「设置迁入 sheet 体系」阶段 4。只改设置导航状态的**所有权与持久化**，不改 `settingsDomains.ts` 的信息架构契约。

## 背景与约束

#154 阶段 4 之前，设置是 `App.tsx` 直接挂载的固定覆盖层（`showSettings` 组件态 + `settingsIntent` 深链事件）：「当前域/分区」这一导航真值活在 App 组件态里——内存态、不落盘、重开归零，且与 sheet 体系的 keep-alive 生命周期彼此独立。

阶段 4 把设置迁入 sheet 体系后，sheet 是 keep-alive 宿主且 sheet 状态可持久化，导航真值随宿主迁移到 `SettingsSheetState`。所有权与持久化契约同时变化，触发 dev-standards「改变数据所有权或持久化契约的决定使用短记录落 `decisions/`」的升格条件，故补登记本 ADR（登记前经用户裁定）。

约束：

- `settingsDomains.ts` 的域/分区/深链别名契约不变（只读消费）；`pylon:open-settings` 事件、`normalizeSettingsIntent`、LEGACY 别名不变。
- 左轨身份项（spec 阶段 2-1）经用户裁定（2026-09-19）正式放弃，不在本 ADR 范围内。
- 中控区不碰（`src/renderers/solid-workbench/**`、`ControlCenter.css`）。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 导航真值留 App/store 层，sheet 只做渲染 | 双真值：sheet keep-alive 生命周期与 App 组件态不同步，重开/复挂载时互相覆盖。ADR-0009 域「左栏宽度重载回 240」的双真值水合现象是同型前车之鉴。 |
| 真值进 `settingsDomains.ts` | 该文件是信息架构契约（域/分区/深链别名，只读消费）；让契约文件承载 UI 会话态，会把「信息架构」与「此刻浏览到哪」两个变化频率悬殊的层耦死。 |

## 决定

1. **设置导航真值归 sheet 状态系统**：`SettingsSheetState`（`workspace-sheets/settingsSheetState.ts:12`，extends `SettingsIntent`）是唯一权威；`normalizeSettingsSheetState` / `serializeSettingsSheetState` / `deserializeSettingsSheetState`（:17/:45/:49）经 codec 归一——未知字段丢弃、非法值回落默认，持久化形状向后兼容。
2. **深链契约零迁移**：`pylon:open-settings` 事件、`normalizeSettingsIntent`、LEGACY 别名原样保留——事件是输入语义，sheet 状态是归宿。`SHEET_KINDS` 9→10（`sheetTypes.ts:8`），`settings` kind 注册进 sheet 注册表并声明一二级同栏导航 sidebar（`builtinWorkspacePlugins.ts`）。
3. **设置三入口幂等收敛**：统一走 `openOrFocusSettingsSheet`（`sheets/settingsSheetNavigation.ts:17`）——已存在同 kind sheet 时聚焦而非新开。
4. **`SettingsSheetState` 从此是持久化兼容面**：后续字段变更必须保持 codec 后向兼容（老状态可读）；SHEET_KINDS 计数类 compat 测试随 kind 增减同步维护。

## 后果

- 正面：重开应用恢复上次浏览的设置域；导航模型在 agent / file / settings 等消费方收敛为同一套 sheet sidebar 模式，单一真值。
- 正面：`Settings.tsx` 剥离对话框外壳成为纯内容组件（`SettingsSheetView` 的实现体），App 不再挂载设置。
- 负面：新增一个持久化形状的兼容维护义务（见决定 4）；`Settings.tsx` 的挂载语义从「覆盖层」变为「sheet 主区」，断言旧挂载方式的测试须随改写登记（B-03 已按对话框→sheet 语义改写，非降级）。
- 风险：左栏宽度重载回 240 的双真值水合现象属 ADR-0009 域（本轮未触碰），与本 ADR 的导航真值无关，勿混淆。

## 证据

- 状态形状与 codec：`src/workspace-sheets/settingsSheetState.ts:12,17,45,49`
- kind 注册与 sidebar：`src/plugins/core/sheet/builtinWorkspacePlugins.ts`、`src/sheets/SettingsSheetSidebar.tsx`、`src/sheets/SettingsSheetView.tsx`
- 幂等入口：`src/sheets/settingsSheetNavigation.ts:14,17`
- 契约不变：`src/settingsDomains.ts`（零迁移）；`check:ipc` 212 命令双向一致（2026-09-19 门禁）
- 契约测试：`src/workspace-sheets/__tests__/settingsSheetState.test.ts`、`src/sheets/__tests__/settingsSheetNavigation.test.ts`、`src/workspace-sheets/__tests__/sheetRegistrySidebarMode.test.tsx`
- 开发记录：`.agents/records/154-settings-sheet.md`
