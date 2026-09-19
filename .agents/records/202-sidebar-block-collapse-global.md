# Dev Record — #202 左栏模块折叠状态跨 Sheet 共享并持久化

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#202（feat(shell): 左栏模块折叠状态跨 Sheet 共享并持久化——切换 Agent Sheet 与重启不改变折叠状态）
- 分支：`Ru5t/Reflector`
- 提交范围：`1e6445d1..<head>`（本轮全部提交）
- 日期：2026-09-19

## 目标与范围

用户原话：「我希望左栏模块的折叠状态能被持久化，切换不同agentsheet和重启应用不改变左栏模块折叠状态」。

把模块折叠映射 `blockCollapsed` 从 Sheet 级 `AgentWorkspaceState` 迁出为**应用级、跨 Sheet 共享、独立键持久化**的界面偏好；`activePageId`（整页打开态）留守 Sheet 级；ADR-0009 几何契约、`pylon-workspace-layout-v3`、插件贡献契约均不动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/sidebarBlockCollapse.ts` | 全新：独立键 store（key `pylon-sidebar-block-collapse-v1`，normalize/read/write/单例 store/hook/reset） | 新增 |
| `src/plugin-runtime/sidebar/sidebarBlockState.ts` | `AgentSidebarBlockState`→`AgentSidebarPageState`（只剩 `activePageId`）；`normalizeBlockState`→`normalizePageState`（丢弃旧 `blockCollapsed` 字段）；折叠助手第二参数改为折叠映射；删除「两字段必须一起写」约束 | 修改 |
| `src/workspace-sheets/agentWorkspaceState.ts` | codec 收窄为整页状态 | 修改 |
| `src/components/Sidebar.tsx` | 折叠读写改走全局 store（订阅刷新），整页仍走 `patchSheetState`；`writeState` 删除 | 修改 |
| `src/components/sidebar/AgentSheetPageHost.tsx` | 关页只写 `{ activePageId: null }`；`state` prop 删除（重命名自 `normalizeBlockState` 的引用同步） | 修改 |
| `src/sheets/AgentSheetView.tsx` | PageHost 挂载不再传 `state` | 修改 |
| `src/plugins/core/sheet/builtinWorkspaceCommands.ts` | `layout.agent-sidebar.block.set` 入参收窄为 `{ blockId, collapsed }`，写全局映射 | 修改 |
| 测试 5 处 + 新增 1 处 | 见「测试处置」 | 修改/新增 |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md` | §6.8 新增「折叠/展开同属跨 Sheet 偏好」段 | 修改 |
| `docs/说明书/Pylon-CLI-命令表.md` | §3.3 命令入参与语义同步 | 修改 |
| `.agents/decisions/0015-sidebar-block-collapse-app-level.md` | 归属层变更裁定 | 新增 |

## 方案要点

- **归属层上移 + 独立键**：折叠是「用户对左栏这个界面区域的整理意图」，不是 Sheet 内容。真值在模块级单例 `sidebarBlockCollapseStore`，独立 localStorage key，与 `sidebarModulePrefs` 同构（normalize 容错、写盘失败静默、内存真值生效）。不写进 ADR-0009 锁定的 `pylon-workspace-layout-v3`（ADR-0011 决定 18 先例）。
- **零迁移**（ADR-0011 决定 7 先例）：旧 Sheet 状态里的 `blockCollapsed` 被 `normalizePageState` 自然丢弃，全局映射从空态起步；`defaultCollapsed` 继续充当「未显式操作过」的回落值。
- **UI 刷新路径变化**：折叠不再依赖「sheet 状态写回 → 重渲染」链路，`useSyncExternalStore` 订阅 store 即时刷新；因此跨 Sheet 同态由构造保证（两边读同一份真值），而不依赖状态同步时序。
- **分层**：领域 store 只持结构化 `Readonly<Record<string, boolean>>`，不 import plugin-runtime（A17 R2 同款取舍）；贡献感知助手留 `sidebarBlockState.ts`。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| Sheet A 折叠模块 → Sheet B 同态 | ✅ 单测「折叠是跨 Sheet 的应用级偏好」断言 |
| 重启后折叠不变 | ✅ 单测「重启恢复：模块重新加载时从持久化 key 读回折叠映射」（`vi.resetModules` + 动态 import 重新执行模块级读取）+ store 往返用例 |
| `activePageId` 仍 per-Sheet | ✅ 集成测试整页状态独立往返；关页只写 `activePageId` |
| 折叠落独立键、显式两方向条目 | ✅ `Sidebar.blocks` 断言 `{ mod: true }` → 翻转后 `{ mod: false }` |
| 旧形状零迁移不抛错 | ✅ 集成测试「上一代形状经 codec 收敛」+ normalize 容错用例 |
| CLI 新契约生效 | ✅ 命令表同步；命令 id 覆盖测试（builtinCliCommandCoverage）保持绿 |

## 测试处置

- 新增：`src/domains/workbench/__tests__/sidebarBlockCollapse.test.ts`（6 用例：normalize / 独立键往返 / 重启恢复 / 损坏回落 / 写盘静默失败 / 订阅与 reset）。
- 修改（逐个）：
  - `Sidebar.blocks.test.tsx`：「折叠写回 sheet」→「写入全局折叠偏好 + 独立键断言 + 展开翻转回 false」；新增「跨 Sheet 同态」用例；alwaysOpen 用例改经 `resetBlockCollapse` 驱动（`act` 包裹）；`resolveOpenPage` 入参形状收窄；移除对 `useWorkspaceStore` 的直接依赖。
  - `AgentSheetPageHost.test.tsx`：关页/Esc 断言改为只写 `{ activePageId: null }`；挂载去掉 `state` prop。
  - `workspaceStore.integration.test.ts`：「区块状态往返」→ 整页状态往返；「两字段一起往返」→「上一代形状零迁移收敛」（断言落盘只剩 `{ activePageId }`）；`sidebarMode` 零迁移期望同步。
  - `AgentSheetView.rendererMode.test.tsx`：仅注释指引更新（等价断言的新位置）。
- 未降级任何断言强度；被改写的用例均为「契约变更随行」类型。

## 证据

- 测试：`bunx vitest run`（四个直接相关文件）**4 files / 45 tests 全绿**；关联目录回归（`src/sheets/__tests__/AgentSheetView.rendererMode.test.tsx`、`src/plugins/core/commandSet`、`src/plugin-runtime/sidebar`、`src/components/__tests__`、`src/workspace-sheets/__tests__`）**52 files / 278 tests 全绿**（vitest 退出码 0）。
- 类型：`bun node_modules/typescript/bin/tsc -b` 对本域文件无错误（共享工作树上另有他人未跟踪 WIP 的瞬时类型错误，见「并行交集」）。
- 手工验证：未做 webview2 实机（行为由跨 Sheet/重启两类单测覆盖，且未触碰几何/样式/IPC；如需实机复核可后续补）。

## 与 spec 的偏差

无实质偏差。spec 的「验收建议」在实施时补强了一项：展开操作写显式 `false` 条目（而非删除条目回落默认）——`toggleBlockCollapsed` 原语义即如此，测试把它钉住。

## 未解问题

无。

## 并行交集

- 共享工作树上存在他人在途改动（`src/__tests__/replay/*`、`src/domains/events/canonicalTurnDuration.ts`、`src/domains/workbench/workbenchProjector.ts`、`src/sheets/agent-workbench/agentWorkbenchSession.ts`、`src-tauri/resources/sdk/pylon-plugin-sdk.js`），以及施工中的未跟踪目录 `src/plugin-runtime/prompt/`——本轮全部绕开，所有提交走 pathspec。
- 本轮碰过的共享文件：`docs/说明书/Pylon-插件系统说明书-开发者版.md`、`docs/说明书/Pylon-CLI-命令表.md`、`.agents/L.md`（条目待 issue 合入后移除）。
