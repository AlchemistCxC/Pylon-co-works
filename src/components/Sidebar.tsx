import { Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useIdentityStore } from '../identityStore'
import { useWorkspaceStore } from '../workspaceStore'

import type { SheetContext } from '../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import type {
  AgentSidebarContribution,
  AgentSidebarRegion,
} from '../plugin-runtime/sidebar/sidebarTypes.ts'
import { AGENT_SIDEBAR_REGIONS } from '../plugin-runtime/sidebar/sidebarTypes.ts'
import {
  isBlockCollapsed,
  isBlockPageOpen,
  normalizeBlockState,
  openBlockPage,
  resolveBlockCollapsible,
  toggleBlockCollapsed,
} from '../plugin-runtime/sidebar/sidebarBlockState.ts'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../plugin-runtime/ui/PluginContributionBoundary.tsx'
import { resolveLaunchIcon } from '../workspace-sheets/launchIcons.tsx'
import { useSidebarContributionProps, type AgentSidebarSharedProps } from './sidebar/useSidebarContributionProps.ts'
import { FirstPartyContribution } from './sidebar/FirstPartyContribution.tsx'

type BlockActionHandler = (actionId: string) => void

const REGION_LABELS: Readonly<Record<AgentSidebarRegion, string>> = { modules: '模块', sessions: '会话' }
const REGION_EMPTY: Readonly<Record<AgentSidebarRegion, string>> = { modules: '暂无模块', sessions: '暂无会话' }

/**
 * Agent Sheet 左栏。
 *
 * 结构是**两个分区的纵向堆叠**，不是一对互斥视图：
 * - `modules`（上）：常驻能力区块，内容高度、自身滚动、默认可折叠。
 * - `sessions`（下）：会话列表，占满剩余高度，是左栏唯一的会话滚动态。
 *
 * **区块外壳（标题 + 折叠钮 + 头部动作）归宿主渲染，贡献只画内容**。标题的唯一来源是
 * 贡献声明的 `label`，`order` 与 `when` 也第一次真正生效。
 *
 * 点击语义刻意分工：**标题**在区块声明了 `page` 时把内容展开成主区整页（替换聊天视图，
 * 不开新 Sheet）；**箭头**只管折叠。声明了页面却没有独立折叠钮的区块不会出现——
 * 折叠钮按 `collapsible` 独立渲染。
 */
export default function Sidebar({ ctx, state, sheet }: { ctx: SheetContext; state?: unknown; sheet?: { id: string } }) {
  const [search, setSearch] = useState('')
  const blockState = useMemo(() => normalizeBlockState(state), [state])
  const patchSheetState = useWorkspaceStore(s => s.patchSheetState)
  const profiles = useIdentityStore(s => s.profiles)
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const setActiveProfile = useIdentityStore(s => s.setActiveProfile)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const activeSession = ctx.activeSession
  const showPet = useWorkspaceStore(s => s.showPet)
  const setShowPet = useWorkspaceStore(s => s.setShowPet)

  const sharedProps = useSidebarContributionProps(ctx, search)

  const sidebarRegistry = getAgentSidebarRegistry()
  const sidebarSnapshot = useSyncExternalStore(
    listener => sidebarRegistry.subscribe(listener),
    () => sidebarRegistry.getSnapshot(),
    () => sidebarRegistry.getSnapshot(),
  )

  // 区块头动作：头部由宿主渲染，语义在贡献组件里。贡献在挂载期把处理器注册回来，
  // 宿主持有 ref 并在点击时调用。隔离表面走不了这条路（它是独立文档），改为把请求
  // 塞进 `input`，靠既有的 `host:input` 重放通道送达。
  const actionHandlers = useRef(new Map<string, BlockActionHandler>())
  const [pendingSurfaceAction, setPendingSurfaceAction] = useState<{ contributionId: string; actionId: string; nonce: number } | null>(null)
  const surfaceActionNonce = useRef(0)

  const contributionsByRegion = useMemo(() => {
    const grouped: Record<AgentSidebarRegion, AgentSidebarContribution[]> = { modules: [], sessions: [] }
    for (const entry of sidebarSnapshot.entries) {
      const value = entry.value
      const context = { region: value.region, activeAgentId: activeAgent, activeSessionId: activeSession, query: search }
      if (!(value.when?.(context) ?? true)) continue
      grouped[value.region].push(value)
    }
    return grouped
  }, [sidebarSnapshot, activeAgent, activeSession, search])

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

  const dispatchBlockAction = useCallback((contributionId: string, actionId: string, isolated: boolean) => {
    if (isolated) {
      surfaceActionNonce.current += 1
      setPendingSurfaceAction({ contributionId, actionId, nonce: surfaceActionNonce.current })
      return
    }
    actionHandlers.current.get(contributionId)?.(actionId)
  }, [])

  const renderBlock = (contributionId: string, contribution: AgentSidebarContribution) => {
    const collapsible = resolveBlockCollapsible(contribution)
    const collapsed = isBlockCollapsed(contribution, blockState)
    const pageOpen = isBlockPageOpen(contribution, blockState)
    const canOpenPage = contribution.page !== undefined
    const headerActions = contribution.headerActions ?? []
    const isolated = contribution.renderKind === 'isolated-surface'
    const streamedAction = pendingSurfaceAction?.contributionId === contributionId ? pendingSurfaceAction : null
    const surfaceInput = {
      region: contribution.region,
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
    const isolatedProps = {
      presentation: 'block' as const,
      collapsed,
      onBlockAction: () => {},
      registerBlockActionHandler: () => {},
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
                ...isolatedProps,
                registerBlockActionHandler: handler => {
                  if (handler) actionHandlers.current.set(contributionId, handler)
                  else actionHandlers.current.delete(contributionId)
                },
              }}
            />
          </Suspense>
        </PluginContributionBoundary>
      )

    const titleContent = <span className="sidebar-block-title">{contribution.label}</span>
    const interactiveTitle = canOpenPage || collapsible

    return (
      <section
        key={contributionId}
        className="sidebar-block"
        data-region={contribution.region}
        data-contribution-id={contributionId}
        data-collapsed={collapsed ? 'true' : 'false'}
        data-page-open={pageOpen ? 'true' : 'false'}
        aria-label={contribution.label}
      >
        <div className="sidebar-block-head">
          {interactiveTitle ? (
            <button
              className="sidebar-block-toggle"
              type="button"
              aria-pressed={canOpenPage ? pageOpen : undefined}
              aria-expanded={canOpenPage ? undefined : (collapsed ? 'false' : 'true')}
              onClick={() => { if (canOpenPage) openPage(contribution); else toggleBlock(contribution) }}
            >
              {titleContent}
            </button>
          ) : <span className="sidebar-block-toggle" aria-hidden="false">{titleContent}</span>}
          {collapsible && (
            <button
              className="sidebar-block-collapse"
              type="button"
              aria-expanded={collapsed ? 'false' : 'true'}
              aria-label={`${collapsed ? '展开' : '折叠'} ${contribution.label}`}
              onClick={() => toggleBlock(contribution)}
            >
              <span className="sidebar-block-arrow" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            </button>
          )}
          {headerActions.length > 0 && (
            <div className="sidebar-block-actions">
              {headerActions.map(action => {
                const Icon = resolveLaunchIcon(action.icon)
                return (
                  <button
                    key={action.id}
                    className="sidebar-block-action"
                    type="button"
                    disabled={action.disabled}
                    title={action.title ?? action.label}
                    aria-label={action.title ?? action.label}
                    onClick={() => dispatchBlockAction(contributionId, action.id, isolated)}
                  >
                    {action.icon && <Icon size={13} aria-hidden="true" />}
                    <span>{action.label}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {!collapsed && <div className="sidebar-block-body">{body}</div>}
      </section>
    )
  }

  // #154：本组件提供左栏内容；外壳挂共享几何类 .sidebar（宽度/竖直分割线/折叠可见性
  // 全归布局层，各 Sheet 不得自带宽度或边框）。折叠可见性由布局层的
  // .layout[data-sidebar="collapsed"] 统一处理，这里不再自行判断。
  return (
    <aside className="sidebar">
      {AGENT_SIDEBAR_REGIONS.map(region => {
        const blocks = contributionsByRegion[region]
        return (
          <div className="sidebar-region" data-region={region} key={region} role="region" aria-label={REGION_LABELS[region]}>
            {region === 'sessions' && (
              <div className="sidebar-region-search">
                {/* 搜索只过滤会话，因此归会话区，不再是整栏的表头。 */}
                <input className="search-input" placeholder="搜索会话..." value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            )}
            {blocks.map(contribution => renderBlock(contribution.id, contribution))}
            {blocks.length === 0 && <div className="session-empty">{REGION_EMPTY[region]}</div>}
          </div>
        )
      })}

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
