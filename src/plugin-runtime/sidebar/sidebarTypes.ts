import type { RegistryEntry } from '../registry/types.ts'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'
import type { Workspace } from '../../workspaceEntities.ts'

/**
 * 左栏分区。左栏是**两个分区的纵向堆叠**，不是互斥视图：
 * - `modules`：常驻能力区块（定时、自动化等），贴顶、自身滚动、可折叠。
 * - `sessions`：会话列表，占满剩余高度，是左栏唯一的会话滚动态。
 *
 * 取代旧的 `AgentSidebarMode ('work' | 'chat')`。旧模型把「工作 / 聊天」做成一对
 * 互斥页签，于是注册表的 `order` 无法生效（每个 mode 只挂一个贡献），`when` 也
 * 从未被调用——而这两者恰好是区块栈需要的原语。分区维度下它们都真正生效。
 */
export type AgentSidebarRegion = 'modules' | 'sessions'

/** 贡献内容的两种体量：左栏区块内的小样，或主区整页。 */
export type AgentSidebarPresentation = 'block' | 'page'

/** 分区字面量清单。注册期校验与宿主分发共用，避免两处各写一份枚举。 */
export const AGENT_SIDEBAR_REGIONS = ['modules', 'sessions'] as const satisfies readonly AgentSidebarRegion[]

export interface AgentSidebarContributionContext {
  readonly region: AgentSidebarRegion
  readonly activeAgentId: string
  readonly activeSessionId: string | null
  readonly query: string
}

/**
 * 区块头部的动作按钮。声明成数据而不是让贡献自己画，是因为：
 * ① 宿主拥有区块外壳（标题 + 折叠），贡献只画内容，头部才不会有第二份标题；
 * ② 外置插件是隔离表面，无法往宿主头部塞 React 节点。
 * `icon` 是由宿主解释的稳定字符串键（与 Workspace launch icon 同一约定），未知键安全降级。
 */
export interface AgentSidebarHeaderAction {
  readonly id: string
  readonly label: string
  readonly title?: string
  readonly icon?: string
  readonly disabled?: boolean
}

export interface AgentSidebarContributionProps {
  readonly activeAgentId: string
  readonly query: string
  readonly activeSessionId: string | null
  readonly sessions: readonly WorkspaceSession[]
  readonly workspaces: readonly Workspace[]
  readonly liveGeneratingSources: readonly string[]
  /**
   * 同一份内容以两种体量出现：`block` 是左栏区块里的小样，`page` 是它展开到主区后的整页。
   * 贡献据此决定渲染密度（区块里紧凑、整页里铺开），而不是维护两份组件。
   */
  readonly presentation: AgentSidebarPresentation
  /** 宿主拥有折叠状态；贡献据此决定是否跳过昂贵渲染。`page` 体量下恒为 `false`。 */
  readonly collapsed: boolean
  /**
   * 注册「区块头动作」的处理器。宿主渲染头部（标题 + 折叠钮 + `headerActions`），
   * 但动作语义属于贡献，因此由贡献在挂载期把处理器注册回来、卸载时传 `null` 注销。
   * 贡献不必监听 `onBlockAction`，二者只留其一即可（前者是宿主导入，后者是占位默认值）。
   */
  readonly registerBlockActionHandler: (handler: ((actionId: string) => void) | null) => void
  /** 宿主头部的 `headerActions` 被点击时回调，参数是该 action 的 id。 */
  readonly onBlockAction: (actionId: string) => void
  readonly onSelectSession: (id: string) => void
  readonly onDeleteSession: (id: string) => Promise<void>
  readonly onExportSession?: (id: string) => Promise<void>
  readonly onArchiveSession?: (id: string) => Promise<void> | void
  readonly onOpenSessionSettings: (id: string) => void
  readonly onRenameSession: (id: string, name: string) => void
  readonly onCreateLooseSession: () => void
  readonly onCreateWorkspace: (name: string, rootPath: string) => Promise<void>
  readonly onCreateWorkspaceSession: (workspaceId: string) => void
}

interface AgentSidebarContributionBase {
  readonly id: string
  readonly region: AgentSidebarRegion
  /** 区块标题。由**宿主**渲染成区块头——贡献不得再画一份自己的标题。 */
  readonly label: string
  readonly order?: number
  /** 是否可折叠。省略时 `modules` 区默认可折叠，`sessions` 区默认不可折叠。 */
  readonly collapsible?: boolean
  readonly defaultCollapsed?: boolean
  /**
   * 声明本区块**可以展开成主区整页**：点击区块标题即打开，页面替换该 Sheet 的聊天视图
   * （不开新 Sheet）。页面渲染的是**同一个贡献组件**，只是 `presentation: 'page'`。
   * 省略即该区块只能折叠，点了无处可去。
   */
  readonly page?: AgentSidebarPage
  readonly headerActions?: readonly AgentSidebarHeaderAction[]
  readonly when?: (context: AgentSidebarContributionContext) => boolean
}

export interface AgentSidebarPage {
  /** 页面头部标题；宿主渲染头部与返回控件，贡献只画内容。 */
  readonly title: string
}

export interface FirstPartyAgentSidebarContribution extends AgentSidebarContributionBase {
  readonly renderKind: 'first-party-react'
  /** Opaque at the runtime boundary; the React host narrows it before rendering. */
  readonly component: unknown
}

export interface IsolatedAgentSidebarContribution extends AgentSidebarContributionBase {
  readonly renderKind: 'isolated-surface'
  readonly surfaceId: string
}

export type AgentSidebarContribution =
  | FirstPartyAgentSidebarContribution
  | IsolatedAgentSidebarContribution

export type AgentSidebarRegistryEntry = RegistryEntry<AgentSidebarContribution>
