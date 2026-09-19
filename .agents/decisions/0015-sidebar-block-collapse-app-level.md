# ADR-0015 左栏模块折叠升格为跨 Sheet 应用级偏好：独立键持久化，Sheet 级只剩整页

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0015-sidebar-block-collapse-app-level.md`

- **日期**：2026-09-19
- **状态**：已采用
- **关系**：修订 ADR-0011 决定 7（「`AgentWorkspaceState` 是区块折叠映射」）与决定 13（「`activePageId` 与 `blockCollapsed` 同住 `AgentWorkspaceState`、必须一起写」）中折叠的归属口径——这两条自本轮起只对 `activePageId` 成立。沿用 ADR-0009 锁定的几何与持久化契约（`pylon-workspace-layout-v3` 不动）与 ADR-0011 决定 18 的「跨 Sheet 偏好落独立 key」先例。归属 issue #202。

## 背景与约束

用户报（#202 原话）：「我希望左栏模块的折叠状态能被持久化，切换不同agentsheet和重启应用不改变左栏模块折叠状态」。

只读核查确认：折叠映射 `blockCollapsed` 一直住 in Sheet 级 `AgentWorkspaceState`（随 `pylon-workspace-sheets` 持久化），**每张 Agent Sheet 各一份**。切换 Sheet 读的是另一份，用户感知为「折叠没被记住」；重启后所见状态取决于恢复/新建的是哪张 Sheet，同样与「用户上次的整理意图」脱钩。折叠本身有落盘，但**归属层级错了**。

约束：

- ADR-0009 全部几何契约与 `pylon-workspace-layout-v3` 持久化面不变（宽度/分割线/整栏折叠不掺合）。
- `AgentSidebarContribution` 插件契约（`collapsible` / `defaultCollapsed` / `alwaysOpen` / `onTitleClick`）不变，插件 API 版本不动。
- 模块次序/显隐偏好（`pylon-sidebar-modules-v1`）不动。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 写进 ADR-0009 锁定的 `pylon-workspace-layout-v3`（与左栏宽度/整栏折叠同键） | ADR-0011 决定 18 已明确跨 Sheet 偏好**不写进**该被契约钉住的键；为一个字段去动锁定面得不偿失。 |
| 维持 per-Sheet 存储，只在 hydrate 时把各 Sheet 的折叠合并成一份 | 语义仍是 Sheet 级 + 合并补丁，三份真值何时收敛、冲突取谁都是新问题；不如把真值一次搬正。 |
| `activePageId`（整页打开态）一并升为全局 | 开页回答的是「**这张 Sheet** 的主区此刻显示什么」，与「用户对左栏的整理意图」是两种语义，用户诉求也不含它；留守 Sheet 级。 |

## 决定

1. **折叠映射的真值上移到应用层**：`blockCollapsed`（模块 id → 是否收起，显式映射两方向都记得住）不再是 Sheet 状态字段；新单例 store `sidebarBlockCollapseStore`（`domains/workbench/sidebarBlockCollapse.ts`）是唯一真值，UI 与 CLI 命令共用。
2. **独立持久化键 `pylon-sidebar-block-collapse-v1`**（envelope `{ collapsed: Record<string, boolean> }`），与 `sidebarModulePrefs` 同一形状与容错纪律（normalize 收敛、写盘失败静默、内存真值仍生效）；**不写进** `pylon-workspace-layout-v3`。
3. **零迁移**（沿用 ADR-0011 决定 7 先例）：已持久化在各 Sheet 状态里的 `blockCollapsed` 字段被读取路径自然丢弃，全局映射从空态起步（未显式操作的模块回落贡献声明的 `defaultCollapsed`）。
4. **`AgentSidebarPageState`（原 `AgentSidebarBlockState`）只剩 `{ activePageId }`**，仍随 Sheet 持久化；「两字段必须一起写」的 patchSheetState 约束随之废除——关整页只写 `{ activePageId: null }`。
5. **CLI 契约随语义变更**：`layout.agent-sidebar.block.set` 入参从 `{ sheetId, blockId, collapsed }` 收窄为 `{ blockId, collapsed }`（全局真值不需要 sheetId），读改写全局映射。demo 阶段破坏性变更按 ADR-0011 既定授权执行。
6. 分层纪律：领域层 store 保持结构化类型（`Readonly<Record<string, boolean>>`），**不 import plugin-runtime 贡献契约**（同 `sidebarModulePrefs` 的 A17 R2 取舍）；贡献感知的判定/翻转助手（`isBlockCollapsed` / `toggleBlockCollapsed`）留在 `plugin-runtime/sidebar/sidebarBlockState.ts`，以折叠映射为参数。

## 后果

- 正面：折叠/展开成为「对左栏的一次整理意图」，跨 Sheet 与重启稳定成立（#202 验收）；左栏模块栈的三个用户偏好（次序、显隐、折叠）全部收敛到同一档位——应用级、独立键。
- 正面：Sheet 状态变纯（只剩整页），`patchSheetState` 不再需要「一起写」的调用方纪律。
- 负面：存量用户（demo 内）各 Sheet 的折叠设置一次性回到默认值——按 ADR-0011 决定 7 的授权接受。
- 负面：`layout.agent-sidebar.block.set` 的 `sheetId` 入参废除，引用旧入参的脚本需调整。
- 风险：折叠 store 是模块级单例，测试间需显式 `resetBlockCollapse`（已提供）；`vitest` 各文件隔离不受影响。

## 证据

- 真值 store：`src/domains/workbench/sidebarBlockCollapse.ts` + `__tests__/sidebarBlockCollapse.test.ts`（normalize 容错 / 独立键往返 / 重启恢复 / 损坏回落 / reset）
- 状态收窄：`src/plugin-runtime/sidebar/sidebarBlockState.ts`（`AgentSidebarPageState` / `normalizePageState` / 以映射为参的折叠助手）、`src/workspace-sheets/agentWorkspaceState.ts`
- 消费方：`src/components/Sidebar.tsx`（折叠读写走全局 store、整页仍走 Sheet 状态）、`src/components/sidebar/AgentSheetPageHost.tsx`（关页只写 `activePageId`）、`src/plugins/core/sheet/builtinWorkspaceCommands.ts`（CLI 契约收窄）
- 行为测试：`src/components/__tests__/Sidebar.blocks.test.tsx`（折叠落独立键 / 跨 Sheet 同态 / alwaysOpen 折叠）、`src/components/__tests__/AgentSheetPageHost.test.tsx`、`src/workspace-sheets/__tests__/workspaceStore.integration.test.ts`（上一代形状零迁移往返）
- 文档：`docs/说明书/Pylon-插件系统说明书-开发者版.md` §6.8（折叠偏好段）、`docs/说明书/Pylon-CLI-命令表.md` §3.3
