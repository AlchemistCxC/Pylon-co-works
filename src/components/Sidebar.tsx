import { Suspense, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { refreshSessionsBackend, useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { useWorkspaceStore } from '../workspaceStore'
import { useWorkspaceEntityStore } from '../workspaceEntityStore'

import { reportRuntimeError } from '../runtimeError'
import { createSessionClient } from '../infrastructure/acp/sessionClient'
import { removeSessionTransaction, sessionDurableOwnerKey } from '../application/transactions/removeSessionTransaction'
import { getChatController } from './chat/chatEventController'
import { clearMessageStorage } from './chat/messagePersistence'
import type { SheetContext } from '../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import type { AgentSidebarContributionProps } from '../plugin-runtime/sidebar/sidebarTypes.ts'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import type { AgentSidebarMode } from '../plugin-runtime/sidebar/sidebarTypes.ts'
import { PluginContributionBoundary } from '../plugin-runtime/ui/PluginContributionBoundary.tsx'
import { validateExportPath } from '../domains/history/persistedHistory.ts'

const NO_GENERATING_SOURCES: readonly string[] = []

export default function Sidebar({ ctx, state, sheet }: { ctx: SheetContext; state?: unknown; sheet?: { id: string } }) {
  const agentState = state && typeof state === 'object' ? state as { sidebarMode?: AgentSidebarMode } : undefined
  const { activeSession, selectSession: onSelectSession, openProfileEdit: onProfileEdit, openSessionSettings: onSessionSettings, sidebarCollapsed: collapsed } = ctx
  const [search, setSearch] = useState('')
  const mode = agentState?.sidebarMode ?? 'work'
  const patchSheetState = useWorkspaceStore(s => s.patchSheetState)
  const profiles = useIdentityStore(s => s.profiles)
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const setActiveProfile = useIdentityStore(s => s.setActiveProfile)
  const sessions = useIdentityStore(s => s.sessions)
  const removeSession = useIdentityStore(s => s.removeSession)
  const updateSession = useIdentityStore(s => s.updateSession)
  const workspaces = useWorkspaceEntityStore(s => s.workspaces)
  const createWorkspace = useWorkspaceEntityStore(s => s.createWorkspace)

  const liveGeneratingSources = useRuntimeStore(s => s.liveGeneratingSources ?? NO_GENERATING_SOURCES)
  const showPet = useWorkspaceStore(s => s.showPet)
  const setShowPet = useWorkspaceStore(s => s.setShowPet)

  const ownSessions = useMemo(() => {
    return sessions
      .filter(s => s.profileId === activeProfileId && s.agentId === activeAgent && !s.archivedAt)
      .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
  }, [sessions, activeProfileId, activeAgent])

  const chatSessions = ownSessions.filter(s => !s.workspaceId)
  const workSessions = ownSessions.filter(s => !!s.workspaceId)

  const sidebarRegistry = getAgentSidebarRegistry()
  const sidebarSnapshot = useSyncExternalStore(
    listener => sidebarRegistry.subscribe(listener),
    () => sidebarRegistry.getSnapshot(),
    () => sidebarRegistry.getSnapshot(),
  )
  const contributions = sidebarSnapshot.entries.filter(entry => entry.value.mode === mode && (entry.value.when?.({ mode, activeAgentId: activeAgent, activeSessionId: activeSession, query: search }) ?? true))

  const handleSelect = (id: string) => onSelectSession(id)

  const handleDelete = async (id: string) => {
    if (!window.confirm('删除会话？')) return
    const sessionClient = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    const result = await removeSessionTransaction(id, {
      findSession: sessionId => sessions.find(s => s.id === sessionId),
      deleteSessionLocal: s => invoke('user_session_delete', {
        sessionId: s.id,
        ownerKey: sessionDurableOwnerKey(s),
      }),
      refreshSessionsBackend,
      markSessionDeleted: id => {
        const target = sessions.find(s => s.id === id)
        if (target) {
          getChatController()?.discardCanonicalEvents(sessionDurableOwnerKey(target))
        }
      },
      closeSession: s => sessionClient.closeSession({ agentId: s.agentId, source: s.source }),
      finalizeSessionDelete: s => invoke('user_session_delete_finalize', {
        sessionId: s.id,
        ownerKey: sessionDurableOwnerKey(s),
      }),
      removeSession: sessionId => removeSession(sessionId),
      clearMessages: sessionId => clearMessageStorage(sessionId, localStorage),
      reportError: (action, error) => reportRuntimeError(action, error),
    })
    if (!result.ok) return
    if (activeSession === id) onSelectSession(null)
  }

  const createSessionUnderCwd = (workspaceId: string) => {
    if (!workspaces.some(workspace => workspace.id === workspaceId)) return
    window.dispatchEvent(new CustomEvent('pylon:new-session', { detail: { workspaceId } }))
    onSelectSession(null)
  }

  const handleArchive = (id: string) => {
    const target = sessions.find(session => session.id === id)
    if (!target || !window.confirm(`归档会话“${target.name}”？可在存档页回放。`)) return
    updateSession(id, { archivedAt: Date.now(), lastActiveAt: Date.now() })
    if (activeSession === id) onSelectSession(null)
  }

  const handleExport = async (id: string) => {
    const target = sessions.find(session => session.id === id)
    if (!target?.periId) return
    try {
      const outputPath = await save({ defaultPath: `session-${target.periId}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (!outputPath) return
      const validation = validateExportPath(outputPath)
      if (validation) { reportRuntimeError('导出会话', validation); return }
      await createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).exportSession({ agentId: target.agentId, periId: target.periId, format: 'markdown', outputPath })
    } catch (error) { reportRuntimeError('导出会话', error) }
  }


  const contributionProps = {
    activeAgentId: activeAgent,
    query: search,
    activeSessionId: activeSession,
    sessions: mode === 'chat' ? chatSessions : workSessions,
    workspaces,
    liveGeneratingSources,
    onSelectSession: handleSelect,
    onDeleteSession: handleDelete,
    onExportSession: handleExport,
    onArchiveSession: handleArchive,
    onOpenSessionSettings: onSessionSettings,
    onRenameSession: (id: string, name: string) => updateSession(id, { name, lastActiveAt: Date.now() }),
    onCreateChatSession: () => { window.dispatchEvent(new CustomEvent('pylon:new-session')); onSelectSession(null) },
    onCreateWorkspace: async (name: string, rootPath: string) => { await createWorkspace(name, rootPath) },
    onCreateWorkspaceSession: createSessionUnderCwd,
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        {!collapsed && <div className="sidebar-mode-tabs" role="tablist" aria-label="Agent 左栏模式">
          {(['work', 'chat'] as const).map(candidate => <button key={candidate} type="button" role="tab" aria-selected={mode === candidate} className={mode === candidate ? 'active' : ''} onClick={() => { if (sheet) patchSheetState(sheet.id, { sidebarMode: candidate }) }}>{candidate === 'work' ? '工作' : '聊天'}</button>)}
        </div>}
        {!collapsed && <input className="search-input" placeholder="搜索会话..." value={search} onChange={e => setSearch(e.target.value)} />}
      </div>

      {!collapsed && (
        <div className="sidebar-sections">
          {contributions.map(entry => {
            if (entry.value.renderKind === 'isolated-surface') {
              return <PluginContributionBoundary key={entry.contributionId} contributionId={entry.contributionId}>
                <IsolatedPluginSurface
                  surfaceId={entry.value.surfaceId}
                  className="sidebar-mode-panel"
                  input={{
                    mode,
                    query: search,
                    activeAgentId: activeAgent,
                    activeSessionId: activeSession,
                    sessions: contributionProps.sessions.map(session => ({ id: session.id, name: session.name, workspaceId: session.workspaceId })),
                    workspaces: workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, rootPath: workspace.rootPath })),
                  }}
                  onEvent={(event, detail) => {
                    if (event === 'host:select-session' && typeof detail === 'string') handleSelect(detail)
                    if (event === 'host:create-chat-session') contributionProps.onCreateChatSession()
                    if (event === 'host:create-workspace-session' && typeof detail === 'string') createSessionUnderCwd(detail)
                    if (event === 'host:open-session-settings' && typeof detail === 'string') onSessionSettings(detail)
                  }}
                />
              </PluginContributionBoundary>
            }
            const Contribution = entry.value.component as ComponentType<AgentSidebarContributionProps>
            return <PluginContributionBoundary key={entry.contributionId} contributionId={entry.contributionId}><Suspense fallback={null}><Contribution {...contributionProps} /></Suspense></PluginContributionBoundary>
          })}
          {contributions.length === 0 && <div className="session-empty">当前模式没有可用内容</div>}
        </div>
      )}

      <div className="profile-bar">
        {profiles.map(p => (
          <button key={p.id} className={`profile-avatar ${p.id === activeProfileId ? 'active' : ''}`}
            onClick={() => setActiveProfile(p.id)}>
            {p.avatar ? <img src={p.avatar} alt={p.name} /> : p.name[0]}
          </button>
        ))}
        <button className="profile-edit" title="Edit Profile" onClick={onProfileEdit}>✎</button>
        <button className="profile-pet" title={showPet ? '隐藏宠物' : '显示宠物'} aria-pressed={showPet} onClick={() => setShowPet(!showPet)}>🐾</button>
      </div>
    </aside>
  )
}
