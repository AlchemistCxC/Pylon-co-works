import { Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronsUpDown, GripVertical } from 'lucide-react'
import { useIdentityStore } from '../identityStore'
import { useWorkspaceStore } from '../workspaceStore'

import type { SheetContext } from '../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import type {
  AgentSidebarContribution,
} from '../plugin-runtime/sidebar/sidebarTypes.ts'
import {
  isBlockCollapsed,
  isBlockPageOpen,
  normalizeBlockState,
  openBlockPage,
  resolveBlockCollapsible,
  resolveTitleAction,
  shouldShowOpenPageAction,
  toggleBlockCollapsed,
} from '../plugin-runtime/sidebar/sidebarBlockState.ts'
import {
  applyModulePrefs,
  reorderModuleIds,
  sidebarModulePrefsStore,
  useSidebarModulePrefs,
} from '../domains/workbench/sidebarModulePrefs.ts'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../plugin-runtime/ui/PluginContributionBoundary.tsx'
import { resolveLaunchIcon } from '../workspace-sheets/launchIcons.tsx'
import { useSidebarContributionProps, type AgentSidebarSharedProps } from './sidebar/useSidebarContributionProps.ts'
import { FirstPartyContribution } from './sidebar/FirstPartyContribution.tsx'

type BlockActionHandler = (actionId: string) => void

/** 自动补的「打开整页」动作 id——贡献自己的动作 id 不得与它冲突（注册期不校验，宿主这里避开即可）。 */
const OPEN_PAGE_ACTION = '__open_page__'

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
 */
export default function Sidebar({ ctx, state, sheet }: { ctx: SheetContext; state?: unknown; sheet?: { id: string } }) {
  const [search, setSearch] = useState('')
  const blockState = useMemo(() => normalizeBlockState(state), [state])
  const modulePrefs = useSidebarModulePrefs()
  const patchSheetState = useWorkspaceStore(s => s.patchSheetState)
  const profiles = useIdentityStore(s => s.profiles)
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const setActiveProfile = useIdentityStore(s => s.setActiveProfile)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const activeSession = ctx.activeSession
  const showPet = useWorkspaceStore(s => s.showPet)
  const setShowPet = useWorkspaceStore(s => s.setShowPet)

  const sharedProps = useSidebarContributionProps(ctx, search, setSearch)

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
    return visible.filter(contribution => contribution.when?.({
      activeAgentId: activeAgent,
      activeSessionId: activeSession,
      query: search,
    }) ?? true)
  }, [sidebarSnapshot, modulePrefs, activeAgent, activeSession, search])

  // ── 拖拽重排 ──
  // 拖拽期间只改**渲染次序**（预览），抬起才落库——与左栏调宽同一取舍：每帧写
  // localStorage 没有意义，而 live 预览是拖拽体感的关键。
  const [drag, setDrag] = useState<{ id: string; pointerId: number } | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const moduleIds = useMemo(() => modules.map(contribution => contribution.id), [modules])
  const renderedModules = useMemo(() => {
    if (!drag || !dragOverId || drag.id === dragOverId) return modules
    const nextOrder = reorderModuleIds(moduleIds, drag.id, dragOverId)
    const byId = new Map(modules.map(contribution => [contribution.id, contribution]))
    return nextOrder.map(id => byId.get(id)!)
  }, [modules, moduleIds, drag, dragOverId])

  const targetIndexAt = useCallback((clientY: number): string | null => {
    const heads = [...document.querySelectorAll<HTMLElement>('.sidebar-block[data-module-id]')]
    for (const head of heads) {
      const rect = head.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return head.dataset.moduleId ?? null
    }
    return heads.at(-1)?.dataset.moduleId ?? null
  }, [])

  const onGripPointerDown = useCallback((event: React.PointerEvent<HTMLElement>, contributionId: string) => {
    event.preventDefault()
    event.stopPropagation()
    // 指针捕获是「拖出元素外仍收得到 pointermove」的关键，但并非所有环境都实现
    // （jsdom 就没有）。缺了它拖拽退化但仍可用，不该整个拖不动。
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDrag({ id: contributionId, pointerId: event.pointerId })
    setDragOverId(contributionId)
  }, [])

  const onGripPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const over = targetIndexAt(event.clientY)
    if (over && over !== dragOverId) setDragOverId(over)
  }, [drag, dragOverId, targetIndexAt])

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!drag) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId)
    const over = dragOverId && dragOverId !== drag.id ? dragOverId : null
    if (over) {
      const nextOrder = reorderModuleIds(moduleIds, drag.id, over)
      sidebarModulePrefsStore.setPrefs({ order: nextOrder, hidden: modulePrefs.hidden })
    }
    setDrag(null)
    setDragOverId(null)
  }, [drag, dragOverId, moduleIds, modulePrefs.hidden])

  const writeState = useCallback((next: ReturnType<typeof toggleBlockCollapsed>) => {
    if (!sheet) return
    patchSheetState(sheet.id, { blockCollapsed: next.blockCollapsed, activePageId: next.activePageId })
  }, [patchSheetState, sheet])

  const toggleBlock = useCallback((contribution: AgentSidebarContribution) => {
    writeState(toggleBlockCollapsed(contribution, blockState))
  }, [blockState, writeState])

  const openPage = useCallback((contribution: AgentSidebarContribution) => {
    writeState(openBlockPage(contribution, blockState))
  }, [blockState, writeState])

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
    const collapsed = isBlockCollapsed(contribution, blockState)
    const pageOpen = isBlockPageOpen(contribution, blockState)
    const titleAction = resolveTitleAction(contribution)
    const isolated = contribution.renderKind === 'isolated-surface'
    const streamedAction = pendingSurfaceAction?.contributionId === contributionId ? pendingSurfaceAction : null
    const openPageAction = shouldShowOpenPageAction(contribution)

    const surfaceInput = {
      query: search,
      activeAgentId: activeAgent,
      activeSessionId: activeSession,
      presentation: 'block' as const,
      collapsed,
      pageOpen,
      blockAction: streamedAction ? { actionId: streamedAction.actionId, nonce: streamedAction.nonce } : null,
      sessions: sharedProps.sessions.map(session => ({ id: session.id, name: session.name, workspaceId: session.workspaceId })),
      workspaces: sharedProps.workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, rootPath: workspace.rootPath })),
    }

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
                onQueryChange: setSearch,
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
        <div className="sidebar-block-head">
          <button
            className="sidebar-block-grip"
            type="button"
            title="拖拽调整模块次序"
            aria-label={`拖拽调整 ${contribution.label} 的次序`}
            onPointerDown={event => onGripPointerDown(event, contributionId)}
            onPointerMove={onGripPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <GripVertical size={12} aria-hidden="true" />
          </button>
          <button
            className="sidebar-block-toggle"
            type="button"
            aria-pressed={titleAction === 'page' ? pageOpen : undefined}
            aria-expanded={titleAction === 'expand' && collapsible ? (collapsed ? 'false' : 'true') : undefined}
            onClick={() => { if (titleAction === 'page') openPage(contribution); else if (collapsible) toggleBlock(contribution) }}
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
        {!collapsed && <div className="sidebar-block-body">{body}</div>}
      </section>
    )
  }

  // #154：本组件提供左栏内容；外壳挂共享几何类 .sidebar（宽度/竖直分割线/折叠可见性
  // 全归布局层，各 Sheet 不得自带宽度或边框）。
  return (
    <aside className="sidebar">
      {/* 单一滚动容器：各模块都是内容高度，整栈一起滚。这样「模块」只有一种形状，
          会话不再是「另一个会自己滚动的分区」。 */}
      <div className="sidebar-modules" role="list">
        {renderedModules.map(renderBlock)}
        {modules.length === 0 && <div className="session-empty">暂无模块</div>}
      </div>

      <div className="profile-bar">
        {profiles.map(p => (
          <button key={p.id} className={`profile-avatar ${p.id === activeProfileId ? 'active' : ''}`}
            onClick={() => setActiveProfile(p.id)}>
            {p.avatar ? <img src={p.avatar} alt={p.name} /> : p.name[0]}
          </button>
        ))}
        {/* #116 子项 4：同排宠物按钮的 title 已是中文，此处原为 "Edit Profile"。 */}
        <button className="profile-edit" title="编辑当前 Profile" onClick={ctx.openProfileEdit}>✎</button>
        <button className="profile-pet" title={showPet ? '隐藏宠物' : '显示宠物'} aria-pressed={showPet} onClick={() => setShowPet(!showPet)}>🐾</button>
      </div>
    </aside>
  )
}

export type { AgentSidebarSharedProps }
