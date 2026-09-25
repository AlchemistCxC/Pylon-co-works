import { useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { tauriInvokeTransport } from '../../infrastructure/acp/tauriTransport.ts'
import { save } from '@tauri-apps/plugin-dialog'
import { refreshSessionsBackend, useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore'
import { reportRuntimeError } from '../../runtimeError'
import { createSessionClient } from '../../infrastructure/acp/sessionClient'
import { removeSessionTransaction, sessionDurableOwnerKey } from '../../application/transactions/removeSessionTransaction'
import { runSessionNotificationHook } from '../../application/transactions/sessionHookTransactions'
import { getCanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'
import { clearMessageStorage } from '../chat/messagePersistence'
import { validateExportPath } from '../../domains/history/persistedHistory.ts'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

const NO_GENERATING_SOURCES: readonly string[] = []

/** 除逐区块字段（`presentation` / `collapsed` / 动作注册）之外的贡献 props。 */
export type AgentSidebarSharedProps = Omit<
  AgentSidebarContributionProps,
  'presentation' | 'collapsed' | 'onBlockAction' | 'registerBlockActionHandler'
>

/**
 * 贡献 props 的**唯一接线处**。
 *
 * 同一份内容会以两种体量出现——左栏区块里的小样，与主区整页（`presentation: 'page'`）。
 * 两处必须拿到**同一批**会话/工作区数据与回调，否则「整页里删掉的会话，区块里还显示」
 * 这类分裂迟早会出现。因此把接线抽到这里，`Sidebar` 与页面宿主都消费它。
 */
export function useSidebarContributionProps(ctx: SheetContext): AgentSidebarSharedProps {
  const {
    activeSession,
    selectSession: onSelectSession,
    openSessionSettings: onSessionSettings,
  } = ctx
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const sessions = useIdentityStore(s => s.sessions)
  const removeSession = useIdentityStore(s => s.removeSession)
  const updateSession = useIdentityStore(s => s.updateSession)
  const workspaces = useWorkspaceEntityStore(s => s.workspaces)
  const createWorkspace = useWorkspaceEntityStore(s => s.createWorkspace)
  const liveGeneratingSources = useRuntimeStore(s => s.liveGeneratingSources ?? NO_GENERATING_SOURCES)

  const ownSessions = useMemo(() => {
    return sessions
      .filter(s => s.profileId === activeProfileId && s.agentId === activeAgent && !s.archivedAt)
      // 置顶的排在各自工作区最前，其余按最近活跃（`sort` 稳定，同档内保持原序）。
      .sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
        || ((b.lastActiveAt || 0) - (a.lastActiveAt || 0)))
  }, [sessions, activeProfileId, activeAgent])

  const handleDelete = async (id: string) => {
    if (!window.confirm('删除会话？')) return
    const sessionClient = createSessionClient({ invoke: tauriInvokeTransport })
    const result = await removeSessionTransaction(id, {
      findSession: sessionId => sessions.find(s => s.id === sessionId),
      deleteSessionLocal: s => invoke('user_session_delete', {
        sessionId: s.id,
        ownerKey: sessionDurableOwnerKey(s),
      }),
      refreshSessionsBackend,
      // tombstone 成功后立即封住在途 canonical 写；revision 刷新可能仍在等待。
      markSessionDeleting: sessionId => {
        const target = sessions.find(session => session.id === sessionId)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
        }
      },
      markSessionDeleted: id => {
        const target = sessions.find(s => s.id === id)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
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
      // API 1.3 生命周期通知:closing→deleting→deleted→closed(观察语义)。
      notifySessionHook: runSessionNotificationHook,
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
      await createSessionClient({ invoke: tauriInvokeTransport }).exportSession({ agentId: target.agentId, periId: target.periId, format: 'markdown', outputPath })
    } catch (error) { reportRuntimeError('导出会话', error) }
  }

  return {
    activeAgentId: activeAgent,
    activeSessionId: activeSession,
    // 会话区里两个族群（挂在工作区上的 / 无 cwd 的）由同一个贡献渲染并按 cwd 分组，
    // 因此给它全集，分组语义留在面板里，宿主不再做 work/chat 预切分。
    sessions: ownSessions,
    workspaces,
    liveGeneratingSources,
    onSelectSession,
    onDeleteSession: handleDelete,
    onExportSession: handleExport,
    onArchiveSession: handleArchive,
    onOpenSessionSettings: onSessionSettings,
    onToggleSessionPin: (id: string) => {
      const target = sessions.find(session => session.id === id)
      if (!target) return
      updateSession(id, { pinned: !target.pinned })
    },
    onRenameSession: (id: string, name: string) => updateSession(id, { name, lastActiveAt: Date.now() }),
    onCreateLooseSession: () => { window.dispatchEvent(new CustomEvent('pylon:new-session')); onSelectSession(null) },
    onCreateWorkspace: async (name: string, rootPath: string) => { await createWorkspace(name, rootPath) },
    onCreateWorkspaceSession: createSessionUnderCwd,
  }
}
