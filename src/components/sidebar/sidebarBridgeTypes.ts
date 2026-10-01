/**
 * sidebarBridgeTypes — sidebar 域 Solid 迁移的**中立桥面类型**落点（#515）。
 *
 * React 薄桥（.tsx）与 Solid 实体（.solid.tsx）互相 import 会把对方的 JSX 拉进自己的
 * tsconfig 程序（jsxImportSource 冲突），因此共享 props/岛输入类型一律放本文件
 * （纯类型、零 JSX、零框架依赖），两侧各自 import 这份唯一事实。
 */
import type { Workspace } from '../../domains/workspace/workspaceEntities.ts'
import type { SheetContext } from '../../workspace-sheets/sheetTypes.ts'
import type { AgentSidebarContribution, AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import type { AgentSidebarSurfaceInput } from '../../plugin-runtime/sidebar/sidebarSurfaceProtocol.ts'

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

/**
 * AgentSheetPagePluginIsland（React 岛）输入：主区整页的贡献体。
 *
 * 页面头部（返回 + 标题）由 Solid 实体渲染；本岛只承载**内容**——两类贡献的渲染面
 * 都在 React 运行时（first-party 组件 / IsolatedPluginSurface + 错误边界 + Suspense）。
 */
export interface AgentSheetPagePluginIslandInput {
  contributionId: string
  renderKind: 'first-party-react' | 'isolated-surface'
  surfaceId?: string
  /** first-party 贡献组件（运行时边界不透明；岛内经 FirstPartyContribution 收窄渲染）。 */
  component?: unknown
  /** first-party 贡献 props（含 `presentation: 'page'` 体量覆盖）。 */
  contributionProps?: AgentSidebarContributionProps
  /** isolated-surface 的 wire 输入投影。 */
  surfaceInput?: AgentSidebarSurfaceInput
  /** isolated-surface 的宿主事件回派。 */
  onSurfaceEvent?: (event: string, detail: unknown) => void
}
