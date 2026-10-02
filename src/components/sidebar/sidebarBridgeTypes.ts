/**
 * sidebarBridgeTypes — sidebar 域 Solid 迁移的**中立桥面类型**落点（#515）。
 *
 * React 薄桥（.tsx）与 Solid 实体（.solid.tsx）互相 import 会把对方的 JSX 拉进自己的
 * tsconfig 程序（jsxImportSource 冲突），因此共享 props 类型一律放本文件
 * （纯类型、零 JSX、零框架依赖），两侧各自 import 这份唯一事实。
 */
import type { Workspace } from '../../domains/workspace/workspaceEntities.ts'
import type { SheetContext } from '../../workspace-sheets/sheetTypes.ts'
import type { AgentSidebarContribution } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/** SessionsPanel 手写 Dialog 内嵌的 CwdSettingsPanel React 岛输入。 */
export interface CwdSettingsIslandInput {
  workspace: Workspace
  onClose: () => void
}

/** AgentSheetPageHost 的 props（原内联形状，实体化后中立化）。 */
export interface AgentSheetPageHostProps {
  page: AgentSidebarContribution
  ctx: SheetContext
  sheet: { id: string }
}
