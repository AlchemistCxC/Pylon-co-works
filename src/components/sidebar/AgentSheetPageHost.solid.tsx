/** @jsxImportSource solid-js */
import { createMemo, onCleanup, onMount, Show, Suspense } from 'solid-js'
import { save } from '@tauri-apps/plugin-dialog'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import { createZustandSignal } from '../../host/solidStoreBridge.ts'
import { appClients } from '../../app/appClients.ts'
import { refreshSessionsBackend, useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { useWorkspaceEntityStore } from '../../infrastructure/persistence/workspaceEntityStore'
import { useWorkspaceStore } from '../../domains/workspace/workspaceStore'
import { reportRuntimeError } from '../../app/runtimeError'
import { removeSessionTransaction, sessionDurableOwnerKey } from '../../application/transactions/removeSessionTransaction'
import { runSessionNotificationHook } from '../../application/transactions/sessionHookTransactions'
import { getCanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'
import { clearMessageStorage } from '../../domains/chat/messagePersistence'
import { validateExportPath } from '../../domains/overview/persistedHistory.ts'
import type { Component } from 'solid-js'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.solid.tsx'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.solid.tsx'
import type { AgentSidebarSurfaceInput } from '../../plugin-runtime/sidebar/sidebarSurfaceProtocol.ts'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import type { AgentSheetPageHostProps } from './sidebarBridgeTypes.ts'
import type { AgentSidebarSharedProps } from './useSidebarContributionProps.ts'

const NO_GENERATING_SOURCES: readonly string[] = []

/**
 * 主区整页宿主：把声明了 `page` 的左栏区块内容展开成 AgentSheet 的整页。
 *
 * **不是新 Sheet**——它替换当前 Sheet 的聊天视图，左栏仍是该 Sheet 的左栏。
 * 页面渲染的是**同一个贡献组件**，只是 `presentation: 'page'`；因此「区块里的小样」
 * 与「整页」共享同一批会话/工作区数据与回调。
 *
 * 头部（返回 + 标题）由宿主渲染，贡献只画内容——与左栏区块外壳同一条约定。
 *
 * #515：`useSidebarContributionProps` 的 Solid 形态内联在本组件（该 hook 原 .ts 保留给
 * 域外 React 消费者 Sidebar.tsx，两份接线语义逐条对齐）。
 */
export default function AgentSheetPageHost(props: AgentSheetPageHostProps) {
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
    if (props.ctx.activeSession === id) props.ctx.selectSession(null)
  }

  const createSessionUnderCwd = (workspaceId: string) => {
    if (!workspaces().some(workspace => workspace.id === workspaceId)) return
    window.dispatchEvent(new CustomEvent('pylon:new-session', { detail: { workspaceId } }))
    props.ctx.selectSession(null)
  }

  const handleArchive = (id: string) => {
    const target = sessions().find(session => session.id === id)
    if (!target || !window.confirm(`归档会话“${target.name}”？可在存档页回放。`)) return
    useIdentityStore.getState().updateSession(id, { archivedAt: Date.now(), lastActiveAt: Date.now() })
    if (props.ctx.activeSession === id) props.ctx.selectSession(null)
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

  /** 除逐区块字段（`presentation` / `collapsed` / 动作注册）之外的贡献 props 快照。 */
  const sharedSnapshot = (): AgentSidebarSharedProps => ({
    activeAgentId: activeAgent(),
    activeSessionId: props.ctx.activeSession,
    // 会话区里两个族群（挂在工作区上的 / 无 cwd 的）由同一个贡献渲染并按 cwd 分组，
    // 因此给它全集，分组语义留在面板里，宿主不再做 work/chat 预切分。
    sessions: ownSessions(),
    workspaces: workspaces(),
    liveGeneratingSources: liveGeneratingSources(),
    onSelectSession: id => props.ctx.selectSession(id),
    onDeleteSession: handleDelete,
    onExportSession: handleExport,
    onArchiveSession: handleArchive,
    onOpenSessionSettings: id => props.ctx.openSessionSettings(id),
    onToggleSessionPin: (id: string) => {
      const target = sessions().find(session => session.id === id)
      if (!target) return
      useIdentityStore.getState().updateSession(id, { pinned: !target.pinned })
    },
    // #393：改名是用户意图，置 `renamedByUser` 后显示恒以 `name` 为准——
    // Agent 后续推的标题只更新 `autoName`（存储以 Agent 为准，显示以用户为准）。
    onRenameSession: (id: string, name: string) => useIdentityStore.getState().updateSession(id, { name, renamedByUser: true, lastActiveAt: Date.now() }),
    onCreateLooseSession: () => { window.dispatchEvent(new CustomEvent('pylon:new-session')); props.ctx.selectSession(null) },
    onCreateWorkspace: async (name: string, rootPath: string) => { await useWorkspaceEntityStore.getState().createWorkspace(name, rootPath) },
    onCreateWorkspaceSession: createSessionUnderCwd,
  })

  const close = () => {
    // 整页是 Sheet 级状态，只写 activePageId；模块折叠在全局 store（issue #202），与此无关。
    useWorkspaceStore.getState().patchSheetState(props.sheet.id, { activePageId: null })
  }

  // Esc 关闭：整页是「临时离开聊天」，键盘用户需要一个不依赖指针的退路。
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })

  const pageDecl = createMemo(() => props.page.page)

  // isolated-surface 的 wire 输入投影（字段见 sidebarSurfaceProtocol，page 体量）。
  const surfaceInput = (): AgentSidebarSurfaceInput => {
    const shared = sharedSnapshot()
    return {
      query: '',
      activeAgentId: shared.activeAgentId,
      activeSessionId: props.ctx.activeSession,
      presentation: 'page',
      collapsed: false,
      pageOpen: true,
      blockAction: null,
      sessions: shared.sessions.map(session => ({ id: session.id, name: session.name, workspaceId: session.workspaceId })),
      workspaces: shared.workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, rootPath: workspace.rootPath })),
    }
  }
  const onSurfaceEvent = (event: string, detail: unknown) => {
    const shared = sharedSnapshot()
    if (event === 'host:select-session' && typeof detail === 'string') shared.onSelectSession(detail)
    if (event === 'host:create-loose-session') shared.onCreateLooseSession()
    if (event === 'host:create-workspace-session' && typeof detail === 'string') shared.onCreateWorkspaceSession(detail)
    if (event === 'host:open-session-settings' && typeof detail === 'string') shared.onOpenSessionSettings(detail)
  }

  /** page 体量的贡献 props（体量覆盖 + 空动作注册；memo 供 JSX 展开保持细粒度响应）。 */
  const contributionProps = createMemo(() => ({
    ...sharedSnapshot(),
    presentation: 'page' as const,
    collapsed: false,
    onBlockAction: () => {},
    registerBlockActionHandler: () => {},
  }))

  return (
    <Show when={pageDecl()}>{decl => (
      <div class="main agent-sheet-page" data-page-id={props.page.id}>
        <div class="agent-sheet-page-head">
          <button type="button" class="agent-sheet-page-back" onClick={close} title="返回聊天" aria-label="返回聊天">
            <LucideIcon name="ArrowLeft" size={14} />
            <span>返回</span>
          </button>
          <h2 class="agent-sheet-page-title">{decl().title}</h2>
        </div>
        <div class="agent-sheet-page-body">
          {/* #515 岛退役：贡献体直连渲染——两类贡献统一 PluginContributionBoundary
              （错误占位 + Runtime diagnostics 上报，与原 React 岛同语义）。keyed on 贡献
              对象：热替换/换贡献时边界（含错误态）整体重置。 */}
          <Show when={props.page} keyed>
            {page => (
              <PluginContributionBoundary contributionId={page.id}>
                {page.renderKind === 'isolated-surface'
                  ? (
                      page.surfaceId
                        ? (
                            <IsolatedPluginSurface
                              surfaceId={page.surfaceId}
                              className="agent-sheet-page-surface"
                              input={surfaceInput()}
                              onEvent={onSurfaceEvent}
                            />
                          )
                        : null)
                  : (() => {
                      // 运行时边界收窄：first-party 只由宿主内置注册（渲染面是 Solid 组件），
                      // 这层 `as` 与原 FirstPartyContribution 的边界纪律一致。
                      const Contribution = page.component as Component<AgentSidebarContributionProps> | undefined
                      if (!Contribution) return null
                      return (
                        <Suspense fallback={null}>
                          <Contribution {...contributionProps()} />
                        </Suspense>
                      )
                    })()}
              </PluginContributionBoundary>
            )}
          </Show>
        </div>
      </div>
    )}</Show>
  )
}
