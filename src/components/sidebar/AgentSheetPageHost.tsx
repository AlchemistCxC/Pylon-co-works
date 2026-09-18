import { Suspense, useCallback, useEffect, useSyncExternalStore } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useIdentityStore } from '../../identityStore'
import { useWorkspaceStore } from '../../workspaceStore'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { closeBlockPage, normalizeBlockState, resolveOpenPage } from '../../plugin-runtime/sidebar/sidebarBlockState.ts'
import type { AgentSidebarContribution } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.tsx'
import { FirstPartyContribution } from './FirstPartyContribution.tsx'

/** 整页里没有搜索输入（搜索属于会话模块的左栏体量），故查询恒为空。 */
const noopQueryChange = () => {}
import { useSidebarContributionProps } from './useSidebarContributionProps.ts'

/**
 * 解出当前 Sheet 上「已展开成整页」的左栏区块贡献；没有则 `null`。
 *
 * 主区（`AgentSheetView`）与页面宿主共用它，避免两处各算一遍「现在到底有没有页面」。
 * 只认**同时**声明了 `page` 的贡献：id 指向已卸载/未声明页面的贡献时回落 `null`，
 * 于是插件停用后主区自然回到聊天视图，而不是锁死在一个不存在的页面上。
 */
export function useOpenSidebarPage(state: unknown): AgentSidebarContribution | null {
  const sidebarRegistry = getAgentSidebarRegistry()
  const snapshot = useSyncExternalStore(
    listener => sidebarRegistry.subscribe(listener),
    () => sidebarRegistry.getSnapshot(),
    () => sidebarRegistry.getSnapshot(),
  )
  const blockState = normalizeBlockState(state)
  return resolveOpenPage(snapshot.entries.map(entry => entry.value), blockState)
}

/**
 * 主区整页宿主：把声明了 `page` 的左栏区块内容展开成 AgentSheet 的整页。
 *
 * **不是新 Sheet**——它替换当前 Sheet 的聊天视图，左栏仍是该 Sheet 的左栏。
 * 页面渲染的是**同一个贡献组件**，只是 `presentation: 'page'`；因此「区块里的小样」
 * 与「整页」共享同一批会话/工作区数据与回调（接线见 `useSidebarContributionProps`）。
 *
 * 头部（返回 + 标题）由宿主渲染，贡献只画内容——与左栏区块外壳同一条约定。
 */
export default function AgentSheetPageHost({ page, ctx, sheet, state }: {
  page: AgentSidebarContribution
  ctx: SheetContext
  sheet: { id: string }
  state?: unknown
}) {
  const patchSheetState = useWorkspaceStore(s => s.patchSheetState)
  const activeAgent = useIdentityStore(s => s.activeAgent)

  const close = useCallback(() => {
    const next = closeBlockPage(normalizeBlockState(state))
    patchSheetState(sheet.id, { blockCollapsed: next.blockCollapsed, activePageId: next.activePageId })
  }, [patchSheetState, sheet.id, state])

  // Esc 关闭：整页是「临时离开聊天」，键盘用户需要一个不依赖指针的退路。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close])

  const sharedProps = useSidebarContributionProps(ctx, '', noopQueryChange)
  const pageDecl = page.page
  if (!pageDecl) return null

  const body = page.renderKind === 'isolated-surface'
    ? (
      <IsolatedPluginSurface
        surfaceId={page.surfaceId}
        className="agent-sheet-page-surface"
        input={{
          query: '',
          activeAgentId: activeAgent,
          activeSessionId: ctx.activeSession,
          presentation: 'page',
          collapsed: false,
          pageOpen: true,
          blockAction: null,
          sessions: sharedProps.sessions.map(session => ({ id: session.id, name: session.name, workspaceId: session.workspaceId })),
          workspaces: sharedProps.workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, rootPath: workspace.rootPath })),
        }}
        onEvent={(event, detail) => {
          if (event === 'host:select-session' && typeof detail === 'string') sharedProps.onSelectSession(detail)
          if (event === 'host:create-loose-session') sharedProps.onCreateLooseSession()
          if (event === 'host:create-workspace-session' && typeof detail === 'string') sharedProps.onCreateWorkspaceSession(detail)
          if (event === 'host:open-session-settings' && typeof detail === 'string') sharedProps.onOpenSessionSettings(detail)
        }}
      />
    )
    : (
      <Suspense fallback={null}>
        <FirstPartyContribution
          component={page.component}
          props={{
            ...sharedProps,
            presentation: 'page',
            collapsed: false,
            onBlockAction: () => {},
            registerBlockActionHandler: () => {},
          }}
        />
      </Suspense>
    )

  return (
    <div className="main agent-sheet-page" data-page-id={page.id}>
      <div className="agent-sheet-page-head">
        <button type="button" className="agent-sheet-page-back" onClick={close} title="返回聊天" aria-label="返回聊天">
          <ArrowLeft size={14} aria-hidden="true" />
          <span>返回</span>
        </button>
        <h2 className="agent-sheet-page-title">{pageDecl.title}</h2>
      </div>
      <div className="agent-sheet-page-body">
        <PluginContributionBoundary contributionId={page.id}>{body}</PluginContributionBoundary>
      </div>
    </div>
  )
}
