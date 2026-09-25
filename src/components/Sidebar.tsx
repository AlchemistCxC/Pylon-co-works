import { Fragment, Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronsUpDown, PawPrint, SlidersHorizontal } from 'lucide-react'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useWorkspaceStore } from '../workspaceStore'

import type { SheetContext } from '../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import type {
  AgentSidebarContribution,
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
  useSidebarModulePrefs,
} from '../domains/workbench/sidebarModulePrefs.ts'
import { sidebarBlockCollapseStore, useSidebarBlockCollapse } from '../domains/workbench/sidebarBlockCollapse.ts'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../plugin-runtime/ui/PluginContributionBoundary.tsx'
import { resolveLaunchIcon } from '../workspace-sheets/launchIcons.tsx'
import { useSidebarContributionProps, type AgentSidebarSharedProps } from './sidebar/useSidebarContributionProps.ts'
import { FirstPartyContribution } from './sidebar/FirstPartyContribution.tsx'

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
 */
export default function Sidebar({ ctx, state, sheet }: { ctx: SheetContext; state?: unknown; sheet?: { id: string } }) {
  const pageState = useMemo(() => normalizePageState(state), [state])
  const collapsedMap = useSidebarBlockCollapse()
  const modulePrefs = useSidebarModulePrefs()
  const patchSheetState = useWorkspaceStore(s => s.patchSheetState)
  const profiles = useIdentityStore(s => s.profiles)
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const setActiveProfile = useIdentityStore(s => s.setActiveProfile)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const activeSession = ctx.activeSession
  const showPet = useWorkspaceStore(s => s.showPet)
  const setShowPet = useWorkspaceStore(s => s.setShowPet)

  const sharedProps = useSidebarContributionProps(ctx)

  const sidebarRegistry = getAgentSidebarRegistry()
  const sidebarSnapshot = useSyncExternalStore(
    listener => sidebarRegistry.subscribe(listener),
    () => sidebarRegistry.getSnapshot(),
    () => sidebarRegistry.getSnapshot(),
  )

  // 模块头动作：头部由宿主渲染，语义在贡献组件里。贡献在挂载期把处理器注册回来，
  // 宿主持有 ref 并在点击时调用。隔离表面走不了这条路（它是独立文档），改为把请求
  // 塞进 `input`，靠既有的 `host:input` 重放通道送达。
  const actionHandlers = useRef(new Map<string, BlockActionHandler>())
  const [pendingSurfaceAction, setPendingSurfaceAction] = useState<{ contributionId: string; actionId: string; nonce: number } | null>(null)
  const surfaceActionNonce = useRef(0)

  const modules = useMemo(() => {
    const visible = applyModulePrefs(
      sidebarSnapshot.entries.map(entry => entry.value),
      modulePrefs,
    )
    return visible.filter(contribution => contribution.when?.({ activeAgentId: activeAgent, activeSessionId: activeSession }) ?? true)
  }, [sidebarSnapshot, modulePrefs, activeAgent, activeSession])

  // ── 拖拽重排 ──
  // 拖拽期间只改**渲染次序**（预览），抬起才落库——与左栏调宽同一取舍：每帧写
  // localStorage 没有意义，而 live 预览是拖拽体感的关键。
  const [drag, setDrag] = useState<{ id: string; pointerId: number } | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const pressRef = useRef<{ timer: number; pointerId: number; startX: number; startY: number } | null>(null)
  const dragEndedAtRef = useRef(0)
  /**
   * 拖拽开始时**冻结**各模块头的几何。
   *
   * 曾经是「实时重排预览」：pointermove 里直接改渲染次序。那会形成反馈环——重排把被拖
   * 模块挪到光标之外 → 目标位置按新布局重算 → 又挪回去 → 来回翻转，实机表现为疯狂抖动。
   * 冻结几何后落点只由按下那一刻的布局决定，预览改用一条落点指示线，抖动在结构上不可能发生。
   */
  const dragGeometryRef = useRef<readonly { id: string; center: number }[] | null>(null)
  const moduleIds = useMemo(() => modules.map(contribution => contribution.id), [modules])
  /**
   * 钉区起点：栈里第一个 `alwaysOpen` 模块的下标（`applyModulePrefs` 保证它们都在栈底）。
   * 拖拽只能落在钉区**之前**——常驻模块是左栏主体（会话），用户要求它「始终位于模块最下方」，
   * 不该被一次拖拽挤到中间去，也不该被谁顶下去。
   */
  const pinnedStart = useMemo(() => {
    const index = modules.findIndex(contribution => contribution.alwaysOpen === true)
    return index < 0 ? modules.length : index
  }, [modules])

  /** 落点序号：冻结几何里中心线在光标之上的模块个数，钳在钉区之前。 */
  const dropIndexAt = useCallback((clientY: number): number => {
    const geometry = dragGeometryRef.current
    if (!geometry) return 0
    let index = 0
    for (const entry of geometry) { if (clientY > entry.center) index += 1 }
    return Math.min(index, pinnedStart)
  }, [pinnedStart])

  const cancelPress = useCallback(() => {
    const press = pressRef.current
    if (!press) return
    window.clearTimeout(press.timer)
    pressRef.current = null
  }, [])

  /**
   * **长按**模块头进入拖拽——不再有独立的拖拽手柄。
   *
   * 手柄方案有两个代价：常驻一个抓取图标是噪声（用户点名过「折叠按钮太显眼」同一类问题），
   * 而按需显形就必须给它 `visibility/pointer-events` 门控，否则是个看不见却能拖的靶子。
   * 长按把手势和「点击标题」区分开，头部因此可以完全干净。
   */
  const onHeadPointerDown = useCallback((event: React.PointerEvent<HTMLElement>, contributionId: string) => {
    if (event.button !== 0) return
    // 钉住的常驻模块不拖：它能去哪儿？钉区之上的位置对它没有意义，又会让「会话永远在最后」失效。
    if (modules.find(contribution => contribution.id === contributionId)?.alwaysOpen === true) return
    // **捕获只能发生在真的进入拖拽那一刻，绝不能在按下时。**
    // 捕获会把 `pointerup` 的目标改写成捕获元素（模块头），而 `click` 派发在「按下目标」与
    // 「抬起目标」的**最近公共祖先**上——于是头内部的按钮（标题、折叠钮、「打开」、头部动作）
    // 全都收不到 click，实机表现为「左栏所有按钮点了没反应」。实测捕获在按时：
    // pointerdown@.sidebar-block-toggle → pointerup@.sidebar-block-head → click@.sidebar-block-head。
    // jsdom 不实现指针捕获，这个改派在单测里复现不出来，所以由 `Sidebar.blocks.test.tsx`
    // 对**捕获时机**本身下断言。
    const head = event.currentTarget
    const pointerId = event.pointerId
    const timer = window.setTimeout(() => {
      pressRef.current = null
      // 指针仍按着才可能走到这里——抬起与取消都会清掉这个计时器。
      // 捕获是「拖出元素外仍收得到 pointermove」的关键，但并非所有环境都实现
      // （jsdom 就没有）。缺了它拖拽退化但仍可用，不该整个拖不动。
      head.setPointerCapture?.(pointerId)
      dragGeometryRef.current = [...document.querySelectorAll<HTMLElement>('.sidebar-block[data-module-id]')].map(node => {
        const rect = node.getBoundingClientRect()
        return { id: node.dataset.moduleId ?? '', center: rect.top + rect.height / 2 }
      })
      setDrag({ id: contributionId, pointerId })
      setDropIndex(moduleIds.indexOf(contributionId))
    }, LONG_PRESS_MS)
    pressRef.current = { timer, pointerId, startX: event.clientX, startY: event.clientY }
  // moduleIds / 模块集合变化（显隐、次序、钉住与否）时要重建回调：长按进入拖拽时用它算初始落点，
  // 用旧次序会导致一按下就偏位。
  }, [moduleIds, modules])

  /**
   * 按下后指针离开模块头就取消长按。
   *
   * 取消捕获之后，头以外的 pointermove 收不到了，`LONG_PRESS_SLOP_PX` 也就测不到——用户按住
   * 又快速移开（其实是想滚动或点别处）时计时器仍会照常触发拖拽。`pointerleave` 补上这个信号：
   * 它只在真的离开头的边界时触发，在头内部的子元素之间移动不会触发。
   */
  const onHeadPointerLeave = useCallback(() => {
    // 已经在拖拽（几何已冻结）时不取消：捕获之后指针本就该自由移动。
    if (dragGeometryRef.current === null) cancelPress()
  }, [cancelPress])

  const onHeadPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const press = pressRef.current
    if (press) {
      if (press.pointerId !== event.pointerId) return
      if (Math.abs(event.clientX - press.startX) > LONG_PRESS_SLOP_PX || Math.abs(event.clientY - press.startY) > LONG_PRESS_SLOP_PX) cancelPress()
      return
    }
    if (!drag || event.pointerId !== drag.pointerId) return
    const next = dropIndexAt(event.clientY)
    if (next !== dropIndex) setDropIndex(next)
  }, [drag, dropIndex, cancelPress, dropIndexAt])

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    cancelPress()
    if (!drag) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (dropIndex !== null) {
      const from = moduleIds.indexOf(drag.id)
      // 落点序号是「插入到第几个之前」；移除自身后，靠后的落点要左移一位。
      const to = from >= 0 && dropIndex > from ? dropIndex - 1 : dropIndex
      const next = [...moduleIds]
      if (from >= 0 && to !== from) {
        next.splice(from, 1)
        next.splice(to, 0, drag.id)
        sidebarModulePrefsStore.setPrefs({ order: next, hidden: modulePrefs.hidden })
      }
    }
    dragGeometryRef.current = null
    dragEndedAtRef.current = Date.now()
    setDrag(null)
    setDropIndex(null)
  }, [drag, dropIndex, moduleIds, modulePrefs.hidden, cancelPress])

  // 折叠写全局 store（跨 Sheet 共享 + 独立持久化）；整页写 Sheet 级状态。
  const toggleBlock = useCallback((contribution: AgentSidebarContribution) => {
    sidebarBlockCollapseStore.setCollapseMap(toggleBlockCollapsed(contribution, collapsedMap))
  }, [collapsedMap])

  const openPage = useCallback((contribution: AgentSidebarContribution) => {
    if (!sheet) return
    const next = openBlockPage(contribution, pageState)
    patchSheetState(sheet.id, { activePageId: next.activePageId })
  }, [pageState, patchSheetState, sheet])

  const dispatchBlockAction = useCallback((contribution: AgentSidebarContribution, actionId: string) => {
    if (actionId === OPEN_PAGE_ACTION) { openPage(contribution); return }
    if (contribution.renderKind === 'isolated-surface') {
      surfaceActionNonce.current += 1
      setPendingSurfaceAction({ contributionId: contribution.id, actionId, nonce: surfaceActionNonce.current })
      return
    }
    actionHandlers.current.get(contribution.id)?.(actionId)
  }, [openPage])

  const renderBlock = (contribution: AgentSidebarContribution) => {
    const contributionId = contribution.id
    const collapsible = resolveBlockCollapsible(contribution)
    const collapsed = isBlockCollapsed(contribution, collapsedMap)
    const pageOpen = isBlockPageOpen(contribution, pageState)
    const titleAction = resolveTitleAction(contribution)
    const isolated = contribution.renderKind === 'isolated-surface'
    const streamedAction = pendingSurfaceAction?.contributionId === contributionId ? pendingSurfaceAction : null
    const openPageAction = shouldShowOpenPageAction(contribution)

    const surfaceInput = {
      activeAgentId: activeAgent,
      activeSessionId: activeSession,
      presentation: 'block' as const,
      collapsed,
      pageOpen,
      blockAction: streamedAction ? { actionId: streamedAction.actionId, nonce: streamedAction.nonce } : null,
      sessions: sharedProps.sessions.map(session => ({ id: session.id, name: session.name, workspaceId: session.workspaceId })),
      workspaces: sharedProps.workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, rootPath: workspace.rootPath })),
    } satisfies AgentSidebarSurfaceInput

    const body = isolated
      ? (
        <PluginContributionBoundary contributionId={contributionId}>
          <IsolatedPluginSurface
            surfaceId={contribution.surfaceId}
            className="sidebar-block-body-surface"
            input={surfaceInput}
            onEvent={(event, detail) => {
              if (event === 'host:select-session' && typeof detail === 'string') sharedProps.onSelectSession(detail)
              if (event === 'host:create-loose-session') sharedProps.onCreateLooseSession()
              if (event === 'host:create-workspace-session' && typeof detail === 'string') sharedProps.onCreateWorkspaceSession(detail)
              if (event === 'host:open-session-settings' && typeof detail === 'string') sharedProps.onOpenSessionSettings(detail)
            }}
          />
        </PluginContributionBoundary>
      )
      : (
        <PluginContributionBoundary contributionId={contributionId}>
          <Suspense fallback={null}>
            <FirstPartyContribution
              component={contribution.component}
              props={{
                ...sharedProps,
                presentation: 'block',
                collapsed,
                onBlockAction: () => {},
                registerBlockActionHandler: handler => {
                  if (handler) actionHandlers.current.set(contributionId, handler)
                  else actionHandlers.current.delete(contributionId)
                },
              }}
            />
          </Suspense>
        </PluginContributionBoundary>
      )

    const Icon = contribution.icon ? resolveLaunchIcon(contribution.icon) : null
    const dragging = drag?.id === contributionId

    return (
      <section
        key={contributionId}
        className="sidebar-block"
        data-module-id={contributionId}
        data-collapsed={collapsed ? 'true' : 'false'}
        data-page-open={pageOpen ? 'true' : 'false'}
        data-always-open={contribution.alwaysOpen === true ? 'true' : 'false'}
        data-dragging={dragging ? 'true' : 'false'}
        aria-label={contribution.label}
      >
        <div
          className="sidebar-block-head"
          title={contribution.alwaysOpen === true ? '常驻模块固定在栈底' : '长按可拖动调整模块次序'}
          onPointerDown={event => onHeadPointerDown(event, contributionId)}
          onPointerMove={onHeadPointerMove}
          onPointerLeave={onHeadPointerLeave}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <button
            className="sidebar-block-toggle"
            type="button"
            aria-pressed={titleAction === 'page' ? pageOpen : undefined}
            aria-expanded={titleAction === 'expand' && collapsible ? (collapsed ? 'false' : 'true') : undefined}
            onClick={() => {
              // 拖拽抬起那一下会补一个 click；不吞掉就会连带展开/进页面。
              if (Date.now() - dragEndedAtRef.current < DRAG_CLICK_SUPPRESS_MS) return
              if (titleAction === 'page') openPage(contribution)
              else if (collapsible) toggleBlock(contribution)
            }}
          >
            {Icon && <span className="sidebar-block-icon" aria-hidden="true"><Icon size={13} /></span>}
            <span className="sidebar-block-title">{contribution.label}</span>
          </button>
          {/* 标题被「进入页面」占用时，折叠必须另给一个控件。 */}
          {collapsible && titleAction === 'page' && (
            <button
              className="sidebar-block-collapse"
              type="button"
              aria-expanded={collapsed ? 'false' : 'true'}
              aria-label={`${collapsed ? '展开' : '折叠'} ${contribution.label}`}
              onClick={() => toggleBlock(contribution)}
            >
              <ChevronsUpDown size={12} aria-hidden="true" />
            </button>
          )}
          <div className="sidebar-block-actions">
            {openPageAction && (
              <button
                className="sidebar-block-action"
                type="button"
                title={`打开 ${contribution.label} 页面`}
                aria-label={`打开 ${contribution.label} 页面`}
                onClick={() => dispatchBlockAction(contribution, OPEN_PAGE_ACTION)}
              >
                <ChevronsUpDown size={13} aria-hidden="true" />
                <span>打开</span>
              </button>
            )}
            {(contribution.headerActions ?? []).map(action => {
              const ActionIcon = resolveLaunchIcon(action.icon)
              return (
                <button
                  key={action.id}
                  className="sidebar-block-action"
                  type="button"
                  disabled={action.disabled}
                  title={action.title ?? action.label}
                  aria-label={action.title ?? action.label}
                  onClick={() => dispatchBlockAction(contribution, action.id)}
                >
                  {action.icon && <ActionIcon size={13} aria-hidden="true" />}
                  <span>{action.label}</span>
                </button>
              )
            })}
          </div>
        </div>
        {/* body **常驻**，折叠靠 CSS 把行高收到 0（`grid-template-rows: 1fr → 0fr` + 淡出），
            于是展开/折叠有过渡——此前是「折叠即卸载」，动作是瞬跳的，而同一栏里的工作区组
            早就有收起动画（用户：「折叠动效…只有部分地方有」）。
            折叠时必须 `inert`：高度 0 挡不住键盘焦点，本仓踩过「宽度 0 的按钮照样 focusable」。
            副作用是贡献在折叠期间保持挂载——与右栏「折叠不卸载面板」同一取舍，模块内状态
            （如搜索词）因此跨折叠保留。 */}
        <div className="sidebar-block-body" inert={collapsed || undefined}>
          <div className="sidebar-block-body-inner">{body}</div>
        </div>
      </section>
    )
  }

  // #154：本组件提供左栏内容；外壳挂共享几何类 .sidebar（宽度/竖直分割线/折叠可见性
  // 全归布局层，各 Sheet 不得自带宽度或边框）。
  return (
    <aside className="sidebar agent-sidebar">
      {/* 单一滚动容器：各模块都是内容高度，整栈一起滚。这样「模块」只有一种形状，
          会话不再是「另一个会自己滚动的分区」。 */}
      <div className="sidebar-modules" role="list">
        {modules.map((contribution, index) => (
          <Fragment key={contribution.id}>
            {drag && dropIndex === index && <div className="sidebar-modules-drop" aria-hidden="true" />}
            {renderBlock(contribution)}
          </Fragment>
        ))}
        {drag && dropIndex === modules.length && <div className="sidebar-modules-drop" aria-hidden="true" />}
        {modules.length === 0 && <div className="session-empty">暂无模块</div>}
      </div>

      <div className="profile-bar">
        <div className="profile-list flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Profiles">
        {profiles.map(p => (
          <button key={p.id} className={`profile-avatar ${p.id === activeProfileId ? 'active' : ''}`}
            type="button" title={p.name} aria-label={p.name} aria-pressed={p.id === activeProfileId}
            onClick={() => setActiveProfile(p.id)}>
            {p.avatar ? <img src={p.avatar} alt={p.name} /> : p.name[0]}
          </button>
        ))}
        </div>
        <button type="button" className="profile-edit" title="编辑当前 Profile" aria-label="编辑当前 Profile" onClick={ctx.openProfileEdit}><SlidersHorizontal size={15} aria-hidden="true" /></button>
        <button type="button" className="profile-pet" title={showPet ? '隐藏宠物' : '显示宠物'} aria-label={showPet ? '隐藏宠物' : '显示宠物'} aria-pressed={showPet} onClick={() => setShowPet(!showPet)}><PawPrint size={15} aria-hidden="true" /></button>
      </div>
    </aside>
  )
}

export type { AgentSidebarSharedProps }
