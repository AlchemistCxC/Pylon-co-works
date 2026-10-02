/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, Show, Suspense, type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { createZustandSignal } from '../host/solidStoreBridge.ts'
import { LucideIcon } from './LucideIcon.solid.tsx'
import { refreshSessionsBackend, useIdentityStore } from '../domains/identity/identityStore'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore'
import { createRegistrySignal } from '../sheets/solidSheetSupport.solid.tsx'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.solid.tsx'
import { PluginContributionBoundary } from '../plugin-runtime/ui/PluginContributionBoundary.solid.tsx'

import type { SheetContext } from '../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import type {
  AgentSidebarContribution,
  AgentSidebarContributionProps,
} from '../plugin-runtime/sidebar/sidebarTypes.ts'
import type { AgentSidebarSurfaceInput } from '../plugin-runtime/sidebar/sidebarSurfaceProtocol.ts'
import {
  isBlockCollapsed,
  isBlockPageOpen,
  normalizePageState,
  openBlockPage,
  resolveBlockCollapsible,
  resolveTitleAction,
  shouldShowOpenPageAction,
  toggleBlockCollapsed,
} from '../plugin-runtime/sidebar/sidebarBlockState.ts'
import {
  applyModulePrefs,
  sidebarModulePrefsStore,
} from '../domains/appearance/sidebarModulePrefs.ts'
import { sidebarBlockCollapseStore } from '../domains/appearance/sidebarBlockCollapse.ts'
import { appClients } from '../app/appClients.ts'
import { save } from '@tauri-apps/plugin-dialog'
import { useWorkspaceEntityStore } from '../infrastructure/persistence/workspaceEntityStore'
import { useRuntimeStore } from '../domains/runtime/runtimeStore'
import { reportRuntimeError } from '../app/runtimeError'
import { removeSessionTransaction, sessionDurableOwnerKey } from '../application/transactions/removeSessionTransaction'
import { runSessionNotificationHook } from '../application/transactions/sessionHookTransactions'
import { getCanonicalEventFeed } from '../infrastructure/events/canonicalEventFeed.ts'
import { clearMessageStorage } from '../domains/chat/messagePersistence'
import { validateExportPath } from '../domains/overview/persistedHistory.ts'
import type { LaunchIconKey } from '../workspace-sheets/launchIconKeys.ts'
import type { AgentSidebarSharedProps } from './sidebar/useSidebarContributionProps.ts'

// ---- 插件贡献体（#515 岛退役）：贡献组件是 **Solid 组件**，宿主直连渲染。 ----

/**
 * 稳定图标键 → LucideIcon 具名的映射（launchIcons.tsx 的 LAUNCH_ICONS 同键表，
 * Solid 侧渲染走 LucideIcon.solid；键集与 launchIconKeys.ts 编译期穷举，漂移会在此
 * 表缺失时安全降级为 SquareStack）。
 */
const LAUNCH_ICON_NAMES: Readonly<Record<LaunchIconKey, string>> = {
  activity: 'Activity',
  'book-open': 'BookOpen',
  agent: 'Bot',
  boxes: 'Boxes',
  clock: 'Clock',
  'folder-tree': 'FolderTree',
  globe: 'Globe',
  history: 'History',
  'layout-dashboard': 'LayoutDashboard',
  messages: 'MessageSquare',
  plus: 'Plus',
  search: 'Search',
  settings: 'Settings',
  sliders: 'SlidersHorizontal',
  waypoints: 'Waypoints',
}

const launchIconName = (icon?: string): string | null =>
  (icon && (LAUNCH_ICON_NAMES as Readonly<Record<string, string>>)[icon]) || (icon ? 'SquareStack' : null)

type BlockActionHandler = (actionId: string) => void

/** 自动补的「打开整页」动作 id——贡献自己的动作 id 不得与它冲突（注册期不校验，宿主这里避开即可）。 */
const OPEN_PAGE_ACTION = '__open_page__'

/** 长按多久进入拖拽。太短会被点击误触，太长会让人觉得拖不动。 */
const LONG_PRESS_MS = 260
/** 长按期间移动超过这个距离（px）即判定为点击/滚动，取消拖拽。 */
const LONG_PRESS_SLOP_PX = 6
/**
 * 拖拽结束后多久内忽略 click——否则抬起那一下会连带触发标题的展开/进页面。
 *
 * 拖拽时指针已被捕获，`click` 会被改派到模块头（见 `onHeadPointerDown`），标题本就不该收到它；
 * 这条是**兜底**：捕获不可用的环境（如 jsdom、旧 WebView2）里改派不发生，click 会照常落在按钮上。
 */
const DRAG_CLICK_SUPPRESS_MS = 320

const NO_GENERATING_SOURCES: readonly string[] = []

/**
 * 贡献 props 的**唯一接线处**（`useSidebarContributionProps` 的 Solid 形态，#515 内联；
 * 与 AgentSheetPageHost.solid 的同族内联逐条对齐）。
 *
 * 同一份内容会以两种体量出现——左栏区块里的小样，与主区整页（`presentation: 'page'`）。
 * 两处必须拿到**同一批**会话/工作区数据与回调。须在响应式 owner 内调用（组件体 / createRoot）。
 */
export function createSidebarContributionProps(ctx: SheetContext): () => AgentSidebarSharedProps {
  const activeProfileId = createZustandSignal(useIdentityStore, s => s.activeProfileId)
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  const sessions = createZustandSignal(useIdentityStore, s => s.sessions)
  const workspaces = createZustandSignal(useWorkspaceEntityStore, s => s.workspaces)
  const liveGeneratingSources = createZustandSignal(useRuntimeStore, s => s.liveGeneratingSources ?? NO_GENERATING_SOURCES)

  const ownSessions = createMemo(() => {
    return sessions()
      .filter(s => s.profileId === activeProfileId() && s.agentId === activeAgent() && !s.archivedAt)
      // 置顶的排在各自工作区最前，其余按最近活跃（`sort` 稳定，同档内保持原序）。
      .sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
        || ((b.lastActiveAt || 0) - (a.lastActiveAt || 0)))
  })

  const handleDelete = async (id: string) => {
    if (!window.confirm('删除会话？')) return
    const sessionClient = appClients.session()
    const sessionsNow = sessions()
    const result = await removeSessionTransaction(id, {
      findSession: sessionId => sessionsNow.find(s => s.id === sessionId),
      deleteSessionLocal: s => sessionClient.deleteUserSessionLocal({ sessionId: s.id, ownerKey: sessionDurableOwnerKey(s) }),
      refreshSessionsBackend,
      // tombstone 成功后立即封住在途 canonical 写；revision 刷新可能仍在等待。
      markSessionDeleting: sessionId => {
        const target = sessionsNow.find(session => session.id === sessionId)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
        }
      },
      markSessionDeleted: sessionId => {
        const target = sessionsNow.find(s => s.id === sessionId)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
        }
      },
      closeSession: s => sessionClient.closeSession({ agentId: s.agentId, source: s.source }),
      // #398：agent 侧 session/delete（close 之后）；periId 缺失（从未连接 agent）跳过。
      deleteSessionRemote: s => s.periId
        ? sessionClient.deleteSessionAgentSide({ agentId: s.agentId, source: s.source, periId: s.periId })
        : Promise.resolve(),
      finalizeSessionDelete: s => sessionClient.finalizeUserSessionDelete({ sessionId: s.id, ownerKey: sessionDurableOwnerKey(s) }),
      removeSession: sessionId => useIdentityStore.getState().removeSession(sessionId),
      clearMessages: sessionId => clearMessageStorage(sessionId, localStorage),
      reportError: (action, error) => reportRuntimeError(action, error),
      // API 1.3 生命周期通知:closing→deleting→deleted→closed(观察语义)。
      notifySessionHook: runSessionNotificationHook,
    })
    if (!result.ok) return
    if (ctx.activeSession === id) ctx.selectSession(null)
  }

  const createSessionUnderCwd = (workspaceId: string) => {
    if (!workspaces().some(workspace => workspace.id === workspaceId)) return
    window.dispatchEvent(new CustomEvent('pylon:new-session', { detail: { workspaceId } }))
    ctx.selectSession(null)
  }

  const handleArchive = (id: string) => {
    const target = sessions().find(session => session.id === id)
    if (!target || !window.confirm(`归档会话“${target.name}”？可在存档页回放。`)) return
    useIdentityStore.getState().updateSession(id, { archivedAt: Date.now(), lastActiveAt: Date.now() })
    if (ctx.activeSession === id) ctx.selectSession(null)
  }

  const handleExport = async (id: string) => {
    const target = sessions().find(session => session.id === id)
    if (!target?.periId) return
    try {
      const outputPath = await save({ defaultPath: `session-${target.periId}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (!outputPath) return
      const validation = validateExportPath(outputPath)
      if (validation) { reportRuntimeError('导出会话', validation); return }
      await appClients.session().exportSession({ agentId: target.agentId, periId: target.periId, format: 'markdown', outputPath })
    } catch (error) { reportRuntimeError('导出会话', error) }
  }

  return () => ({
    activeAgentId: activeAgent(),
    activeSessionId: ctx.activeSession,
    // 会话区里两个族群（挂在工作区上的 / 无 cwd 的）由同一个贡献渲染并按 cwd 分组，
    // 因此给它全集，分组语义留在面板里，宿主不再做 work/chat 预切分。
    sessions: ownSessions(),
    workspaces: workspaces(),
    liveGeneratingSources: liveGeneratingSources(),
    onSelectSession: id => ctx.selectSession(id),
    onDeleteSession: handleDelete,
    onExportSession: handleExport,
    onArchiveSession: handleArchive,
    onOpenSessionSettings: id => ctx.openSessionSettings(id),
    onToggleSessionPin: (id: string) => {
      const target = sessions().find(session => session.id === id)
      if (!target) return
      useIdentityStore.getState().updateSession(id, { pinned: !target.pinned })
    },
    // #393：改名是用户意图，置 `renamedByUser` 后显示恒以 `name` 为准——
    // Agent 后续推的标题只更新 `autoName`（存储以 Agent 为准，显示以用户为准）。
    onRenameSession: (id: string, name: string) => useIdentityStore.getState().updateSession(id, { name, renamedByUser: true, lastActiveAt: Date.now() }),
    onCreateLooseSession: () => { window.dispatchEvent(new CustomEvent('pylon:new-session')); ctx.selectSession(null) },
    onCreateWorkspace: async (name: string, rootPath: string) => { await useWorkspaceEntityStore.getState().createWorkspace(name, rootPath) },
    onCreateWorkspaceSession: createSessionUnderCwd,
  })
}

export interface SidebarProps {
  ctx: SheetContext
  state?: unknown
  sheet?: { id: string }
}

/**
 * Agent Sheet 左栏。
 *
 * 左栏是**一个有序的模块栈**：会话就是其中一个模块（声明 `alwaysOpen`，因此不可折叠、
 * 不可隐藏、默认排在最后），与插件注册的模块走同一条路——同一套图标、点击语义、
 * 拖拽重排与显隐设置，不为会话开特例。
 *
 * **模块外壳（标题 + 折叠钮 + 头部动作 + 拖拽手柄）归宿主渲染，贡献只画内容。**
 * 标题的唯一来源是贡献声明的 `label`。
 *
 * 点击语义由贡献声明（`onTitleClick`）：`expand` 时标题展开/折叠，若同时声明了 `page`，
 * 宿主在头部自动补一个「打开」按钮（用户所说「都要」）；`page` 时标题进入主区整页，
 * 折叠改由独立折叠钮负责。
 *
 * **折叠/展开是跨 Sheet 的应用级偏好**（`sidebarBlockCollapseStore`，独立持久化 key）：
 * 任意 Sheet 里收起/展开某模块，切到别的 Sheet、乃至重启应用都不改变（issue #202）。
 * 整页（`activePageId`）则相反——它是「这张 Sheet 的主区此刻显示什么」，留在 Sheet 级。
 *
 * #515：Solid 实体——偏好 store 经注册表信号订阅（原 sidebarPrefsHooks 内联），
 * 贡献体经 React 岛宿主挂载；DOM/aria/data-* 契约与 React 版逐字同构。
 */
export default function Sidebar(props: SidebarProps) {
  const pageState = createMemo(() => normalizePageState(props.state))
  // 折叠/显隐偏好是框架无关外部 store：原 useSyncExternalStore 订阅内联为注册表信号。
  const collapsedMap = createRegistrySignal(sidebarBlockCollapseStore, () => sidebarBlockCollapseStore.getSnapshot())
  const modulePrefs = createRegistrySignal(sidebarModulePrefsStore, () => sidebarModulePrefsStore.getSnapshot())
  const profiles = createZustandSignal(useIdentityStore, s => s.profiles)
  const activeProfileId = createZustandSignal(useIdentityStore, s => s.activeProfileId)
  const activeAgent = createZustandSignal(useIdentityStore, s => s.activeAgent)
  const sharedProps = createSidebarContributionProps(props.ctx)

  const sidebarRegistry = getAgentSidebarRegistry()
  const sidebarSnapshot = createRegistrySignal(sidebarRegistry, () => sidebarRegistry.getSnapshot())

  // 模块头动作：头部由宿主渲染，语义在贡献组件里。贡献在挂载期把处理器注册回来，
  // 宿主持有 ref 并在点击时调用。隔离表面走不了这条路（它是独立文档），改为把请求
  // 塞进 `input`，靠既有的 `host:input` 重放通道送达。
  const actionHandlers = new Map<string, BlockActionHandler>()
  const [pendingSurfaceAction, setPendingSurfaceAction] = createSignal<{ contributionId: string; actionId: string; nonce: number } | null>(null)
  let surfaceActionNonce = 0

  const modules = createMemo(() => {
    const visible = applyModulePrefs(
      sidebarSnapshot().entries.map(entry => entry.value),
      modulePrefs(),
    )
    return visible.filter(contribution => contribution.when?.({ activeAgentId: activeAgent(), activeSessionId: props.ctx.activeSession }) ?? true)
  })

  // ── 拖拽重排 ──
  // 拖拽期间只改**渲染次序**（预览），抬起才落库——与左栏调宽同一取舍：每帧写
  // localStorage 没有意义，而 live 预览是拖拽体感的关键。
  const [drag, setDrag] = createSignal<{ id: string; pointerId: number } | null>(null)
  const [dropIndex, setDropIndex] = createSignal<number | null>(null)
  let pressRef: { timer: number; pointerId: number; startX: number; startY: number } | null = null
  let dragEndedAt = 0
  /**
   * 拖拽开始时**冻结**各模块头的几何。
   *
   * 曾经是「实时重排预览」：pointermove 里直接改渲染次序。那会形成反馈环——重排把被拖
   * 模块挪到光标之外 → 目标位置按新布局重算 → 又挪回去 → 来回翻转，实机表现为疯狂抖动。
   * 冻结几何后落点只由按下那一刻的布局决定，预览改用一条落点指示线，抖动在结构上不可能发生。
   */
  let dragGeometry: readonly { id: string; center: number }[] | null = null
  const moduleIds = createMemo(() => modules().map(contribution => contribution.id))
  /**
   * 钉区起点：栈里第一个 `alwaysOpen` 模块的下标（`applyModulePrefs` 保证它们都在栈底）。
   * 拖拽只能落在钉区**之前**——常驻模块是左栏主体（会话），用户要求它「始终位于模块最下方」，
   * 不该被一次拖拽挤到中间去，也不该被谁顶下去。
   */
  const pinnedStart = createMemo(() => {
    const index = modules().findIndex(contribution => contribution.alwaysOpen === true)
    return index < 0 ? modules().length : index
  })

  /** 落点序号：冻结几何里中心线在光标之上的模块个数，钳在钉区之前。 */
  const dropIndexAt = (clientY: number): number => {
    const geometry = dragGeometry
    if (!geometry) return 0
    let index = 0
    for (const entry of geometry) { if (clientY > entry.center) index += 1 }
    return Math.min(index, pinnedStart())
  }

  const cancelPress = () => {
    const press = pressRef
    if (!press) return
    window.clearTimeout(press.timer)
    pressRef = null
  }

  /**
   * **长按**模块头进入拖拽——不再有独立的拖拽手柄。
   *
   * 手柄方案有两个代价：常驻一个抓取图标是噪声（用户点名过「折叠按钮太显眼」同一类问题），
   * 而按需显形就必须给它 `visibility/pointer-events` 门控，否则是个看不见却能拖的靶子。
   * 长按把手势和「点击标题」区分开，头部因此可以完全干净。
   */
  const onHeadPointerDown = (event: PointerEvent, contributionId: string) => {
    if (event.button !== 0) return
    // 钉住的常驻模块不拖：它能去哪儿？钉区之上的位置对它没有意义，又会让「会话永远在最后」失效。
    if (modules().find(contribution => contribution.id === contributionId)?.alwaysOpen === true) return
    // **捕获只能发生在真的进入拖拽那一刻，绝不能在按下时。**
    // 捕获会把 `pointerup` 的目标改写成捕获元素（模块头），而 `click` 派发在「按下目标」与
    // 「抬起目标」的**最近公共祖先**上——于是头内部的按钮（标题、折叠钮、「打开」、头部动作）
    // 全都收不到 click，实机表现为「左栏所有按钮点了没反应」。实测捕获在按时：
    // pointerdown@.sidebar-block-toggle → pointerup@.sidebar-block-head → click@.sidebar-block-head。
    // jsdom 不实现指针捕获，这个改派在单测里复现不出来，所以由 `Sidebar.blocks.solid.test.tsx`
    // 对**捕获时机**本身下断言。
    const head = event.currentTarget as HTMLElement
    const pointerId = event.pointerId
    const timer = window.setTimeout(() => {
      pressRef = null
      // 指针仍按着才可能走到这里——抬起与取消都会清掉这个计时器。
      // 捕获是「拖出元素外仍收得到 pointermove」的关键，但并非所有环境都实现
      // （jsdom 就没有）。缺了它拖拽退化但仍可用，不该整个拖不动。
      head.setPointerCapture?.(pointerId)
      dragGeometry = [...document.querySelectorAll<HTMLElement>('.sidebar-block[data-module-id]')].map(node => {
        const rect = node.getBoundingClientRect()
        return { id: node.dataset.moduleId ?? '', center: rect.top + rect.height / 2 }
      })
      setDrag({ id: contributionId, pointerId })
      setDropIndex(moduleIds().indexOf(contributionId))
    }, LONG_PRESS_MS)
    pressRef = { timer, pointerId, startX: event.clientX, startY: event.clientY }
  }

  /**
   * 按下后指针离开模块头就取消长按。
   *
   * 取消捕获之后，头以外的 pointermove 收不到了，`LONG_PRESS_SLOP_PX` 也就测不到——用户按住
   * 又快速移开（其实是想滚动或点别处）时计时器仍会照常触发拖拽。`pointerleave` 补上这个信号：
   * 它只在真的离开头的边界时触发，在头内部的子元素之间移动不会触发。
   */
  const onHeadPointerLeave = () => {
    // 已经在拖拽（几何已冻结）时不取消：捕获之后指针本就该自由移动。
    if (dragGeometry === null) cancelPress()
  }

  const onHeadPointerMove = (event: PointerEvent) => {
    const press = pressRef
    if (press) {
      if (press.pointerId !== event.pointerId) return
      if (Math.abs(event.clientX - press.startX) > LONG_PRESS_SLOP_PX || Math.abs(event.clientY - press.startY) > LONG_PRESS_SLOP_PX) cancelPress()
      return
    }
    const current = drag()
    if (!current || event.pointerId !== current.pointerId) return
    const next = dropIndexAt(event.clientY)
    if (next !== dropIndex()) setDropIndex(next)
  }

  const endDrag = (event: PointerEvent) => {
    cancelPress()
    const current = drag()
    if (!current) return
    const head = event.currentTarget as HTMLElement
    if (head.hasPointerCapture?.(event.pointerId)) head.releasePointerCapture?.(event.pointerId)
    const targetIndex = dropIndex()
    if (targetIndex !== null) {
      const ids = moduleIds()
      const from = ids.indexOf(current.id)
      // 落点序号是「插入到第几个之前」；移除自身后，靠后的落点要左移一位。
      const to = from >= 0 && targetIndex > from ? targetIndex - 1 : targetIndex
      if (from >= 0 && to !== from) {
        const next = [...ids]
        next.splice(from, 1)
        next.splice(to, 0, current.id)
        sidebarModulePrefsStore.setPrefs({ order: next, hidden: modulePrefs().hidden })
      }
    }
    dragGeometry = null
    dragEndedAt = Date.now()
    setDrag(null)
    setDropIndex(null)
  }

  // 折叠写全局 store（跨 Sheet 共享 + 独立持久化）；整页写 Sheet 级状态。
  const toggleBlock = (contribution: AgentSidebarContribution) => {
    sidebarBlockCollapseStore.setCollapseMap(toggleBlockCollapsed(contribution, collapsedMap()))
  }

  const openPage = (contribution: AgentSidebarContribution) => {
    if (!props.sheet) return
    const next = openBlockPage(contribution, pageState())
    useWorkspaceStore.getState().patchSheetState(props.sheet.id, { activePageId: next.activePageId })
  }

  const dispatchBlockAction = (contribution: AgentSidebarContribution, actionId: string) => {
    if (actionId === OPEN_PAGE_ACTION) { openPage(contribution); return }
    if (contribution.renderKind === 'isolated-surface') {
      surfaceActionNonce += 1
      setPendingSurfaceAction({ contributionId: contribution.id, actionId, nonce: surfaceActionNonce })
      return
    }
    actionHandlers.get(contribution.id)?.(actionId)
  }

  const renderBlock = (contribution: AgentSidebarContribution) => {
    const contributionId = contribution.id
    const collapsible = () => resolveBlockCollapsible(contribution)
    const collapsed = () => isBlockCollapsed(contribution, collapsedMap())
    const pageOpen = () => isBlockPageOpen(contribution, pageState())
    const titleAction = resolveTitleAction(contribution)
    const isolated = contribution.renderKind === 'isolated-surface'
    const streamedAction = () => pendingSurfaceAction()?.contributionId === contributionId ? pendingSurfaceAction() : null
    const openPageAction = shouldShowOpenPageAction(contribution)

    const surfaceInput = (): AgentSidebarSurfaceInput => {
      const shared = sharedProps()
      return {
        activeAgentId: shared.activeAgentId,
        activeSessionId: shared.activeSessionId,
        presentation: 'block',
        collapsed: collapsed(),
        pageOpen: pageOpen(),
        blockAction: streamedAction() ? { actionId: streamedAction()!.actionId, nonce: streamedAction()!.nonce } : null,
        sessions: shared.sessions.map(session => ({ id: session.id, name: session.name, workspaceId: session.workspaceId })),
        workspaces: shared.workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, rootPath: workspace.rootPath })),
      }
    }

    // 贡献体直连渲染（#515 岛退役）：共享 props / 折叠态 / wire 输入经细粒度响应直通
    // 贡献组件；错误边界 + Suspense 语义与原 React 岛一致。
    const contributionProps = () => ({
      ...sharedProps(),
      presentation: 'block' as const,
      collapsed: collapsed(),
      onBlockAction: () => {},
      registerBlockActionHandler: (handler: ((actionId: string) => void) | null) => {
        if (handler) actionHandlers.set(contributionId, handler)
        else actionHandlers.delete(contributionId)
      },
    })
    const onSurfaceEvent = (event: string, detail: unknown) => {
      const shared = sharedProps()
      if (event === 'host:select-session' && typeof detail === 'string') shared.onSelectSession(detail)
      if (event === 'host:create-loose-session') shared.onCreateLooseSession()
      if (event === 'host:create-workspace-session' && typeof detail === 'string') shared.onCreateWorkspaceSession(detail)
      if (event === 'host:open-session-settings' && typeof detail === 'string') shared.onOpenSessionSettings(detail)
    }
    const body = () => (
      <PluginContributionBoundary contributionId={contributionId}>
        {isolated ? (
          <IsolatedPluginSurface
            surfaceId={(contribution as { surfaceId: string }).surfaceId}
            className="sidebar-block-body-surface"
            input={surfaceInput()}
            onEvent={onSurfaceEvent}
          />
        ) : (
          <Suspense fallback={null}>
            {/* 运行时边界收窄：first-party 贡献组件是 Solid 组件（宿主内置注册）；
                联合类型在 isolated 分支外不含 component，此处与原 FirstPartyContribution
                的边界纪律一致按 Solid 组件收窄。 */}
            <Dynamic
              component={(contribution as { component?: unknown }).component as Component<AgentSidebarContributionProps>}
              {...contributionProps()}
            />
          </Suspense>
        )}
      </PluginContributionBoundary>
    )

    const iconName = launchIconName(contribution.icon)
    const dragging = () => drag()?.id === contributionId

    return (
      <section
        class="sidebar-block"
        data-module-id={contributionId}
        data-collapsed={collapsed() ? 'true' : 'false'}
        data-page-open={pageOpen() ? 'true' : 'false'}
        data-always-open={contribution.alwaysOpen === true ? 'true' : 'false'}
        data-dragging={dragging() ? 'true' : 'false'}
        aria-label={contribution.label}
      >
        <div
          class="sidebar-block-head"
          title={contribution.alwaysOpen === true ? '常驻模块固定在栈底' : '长按可拖动调整模块次序'}
          onPointerDown={event => onHeadPointerDown(event, contributionId)}
          onPointerMove={onHeadPointerMove}
          onPointerLeave={onHeadPointerLeave}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <button
            class="sidebar-block-toggle"
            type="button"
            aria-pressed={titleAction === 'page' ? pageOpen() : undefined}
            aria-expanded={titleAction === 'expand' && collapsible() ? (collapsed() ? 'false' : 'true') : undefined}
            onClick={() => {
              // 拖拽抬起那一下会补一个 click；不吞掉就会连带展开/进页面。
              if (Date.now() - dragEndedAt < DRAG_CLICK_SUPPRESS_MS) return
              if (titleAction === 'page') openPage(contribution)
              else if (collapsible()) toggleBlock(contribution)
            }}
          >
            <Show when={iconName}>
              <span class="sidebar-block-icon" aria-hidden="true"><LucideIcon name={iconName!} size={13} /></span>
            </Show>
            <span class="sidebar-block-title">{contribution.label}</span>
          </button>
          {/* 标题被「进入页面」占用时，折叠必须另给一个控件。 */}
          <Show when={collapsible() && titleAction === 'page'}>
            <button
              class="sidebar-block-collapse"
              type="button"
              aria-expanded={collapsed() ? 'false' : 'true'}
              aria-label={`${collapsed() ? '展开' : '折叠'} ${contribution.label}`}
              onClick={() => toggleBlock(contribution)}
            >
              <LucideIcon name="ChevronsUpDown" size={12} />
            </button>
          </Show>
          <div class="sidebar-block-actions">
            <Show when={openPageAction}>
              <button
                class="sidebar-block-action"
                type="button"
                title={`打开 ${contribution.label} 页面`}
                aria-label={`打开 ${contribution.label} 页面`}
                onClick={() => dispatchBlockAction(contribution, OPEN_PAGE_ACTION)}
              >
                <LucideIcon name="ChevronsUpDown" size={13} />
                <span>打开</span>
              </button>
            </Show>
            <For each={contribution.headerActions ?? []}>{action => (
              <button
                class="sidebar-block-action"
                type="button"
                disabled={action.disabled}
                title={action.title ?? action.label}
                aria-label={action.title ?? action.label}
                onClick={() => dispatchBlockAction(contribution, action.id)}
              >
                <Show when={action.icon}><LucideIcon name={launchIconName(action.icon) ?? 'SquareStack'} size={13} /></Show>
                <span>{action.label}</span>
              </button>
            )}</For>
          </div>
        </div>
        {/* body **常驻**，折叠靠 CSS 把行高收到 0（`grid-template-rows: 1fr → 0fr` + 淡出），
            于是展开/折叠有过渡——此前是「折叠即卸载」，动作是瞬跳的，而同一栏里的工作区组
            早就有收起动画（用户：「折叠动效…只有部分地方有」）。
            折叠时必须 `inert`：高度 0 挡不住键盘焦点，本仓踩过「宽度 0 的按钮照样 focusable」。
            副作用是贡献在折叠期间保持挂载——与右栏「折叠不卸载面板」同一取舍，模块内状态
            （如搜索词）因此跨折叠保留。 */}
        <div class="sidebar-block-body" ref={el => createEffect(() => {
          // inert 是属性而非 DOM property（jsdom 的 property 不反射）：折叠置 inert、
          // 展开移除——契约由 Sidebar.blocks.solid.test 的 hasAttribute 断言锁定。
          if (collapsed()) el.setAttribute('inert', '')
          else el.removeAttribute('inert')
        })}>
          <div class="sidebar-block-body-inner">{body()}</div>
        </div>
      </section>
    )
  }

  // #154：本组件提供左栏内容；外壳挂共享几何类 .sidebar（宽度/竖直分割线/折叠可见性
  // 全归布局层，各 Sheet 不得自带宽度或边框）。
  return (
    <aside class="sidebar agent-sidebar">
      {/* 单一滚动容器：各模块都是内容高度，整栈一起滚。这样「模块」只有一种形状，
          会话不再是「另一个会自己滚动的分区」。 */}
      <div class="sidebar-modules" role="list">
        <For each={modules()}>{(contribution, index) => (
          <>
            <Show when={drag() && dropIndex() === index()}>
              <div class="sidebar-modules-drop" aria-hidden="true" />
            </Show>
            {renderBlock(contribution)}
          </>
        )}</For>
        <Show when={drag() && dropIndex() === modules().length}>
          <div class="sidebar-modules-drop" aria-hidden="true" />
        </Show>
        <Show when={modules().length === 0}>
          <div class="session-empty">暂无模块</div>
        </Show>
      </div>

      <div class="profile-bar">
        <div class="profile-list flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Profiles">
          <For each={profiles()}>{p => (
            <button class={`profile-avatar ${p.id === activeProfileId() ? 'active' : ''}`}
              type="button" title={p.name} aria-label={p.name} aria-pressed={p.id === activeProfileId()}
              onClick={() => useIdentityStore.getState().setActiveProfile(p.id)}>
              <Show when={p.avatar} fallback={<>{p.name[0]}</>}>
                <img src={p.avatar} alt={p.name} />
              </Show>
            </button>
          )}</For>
        </div>
        <button type="button" class="profile-edit" title="编辑当前 Profile" aria-label="编辑当前 Profile" onClick={() => props.ctx.openProfileEdit()}><LucideIcon name="SlidersHorizontal" size={15} /></button>
      </div>
    </aside>
  )
}
