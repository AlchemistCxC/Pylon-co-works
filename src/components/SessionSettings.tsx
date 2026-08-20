import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { invoke } from '@tauri-apps/api/core'
import { refreshSessionsBackend, useIdentityStore } from '../identityStore'
import { useWorkspaceEntityStore } from '../workspaceEntityStore'
import { reportRuntimeError } from '../runtimeError'
import { createSessionClient } from '../infrastructure/acp/sessionClient'
import { removeSessionTransaction, sessionDurableOwnerKey } from '../application/transactions/removeSessionTransaction'
import Select from './ui/Select.tsx'

import { getChatController } from './chat/chatEventController'
import { clearMessageStorage } from './chat/messagePersistence'
import { createSessionSettingsValues, isSessionSettingsDirty } from './sessionSettingsForm'

interface Props { sessionId: string; open: boolean; onClose: () => void; onDeleted?: () => void }

export default function SessionSettings({ sessionId, open, onClose, onDeleted }: Props) {
  const updateSession = useIdentityStore(state => state.updateSession)
  const activeAgent = useIdentityStore(state => state.activeAgent)
  // 只订阅目标会话对象：其他会话的更新（消息/改名/活跃时间）不再重渲染本对话框
  const session = useIdentityStore(state => sessionId ? state.sessions.find(item => item.id === sessionId) : undefined)
  // createSessionSettingsValues 只读 name/platform/workdir/sessionPrompt，均已入 deps；
  // session 对象整体入 deps 会让任何会话更新（消息/活跃时间）都重建表单
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialValues = useMemo(() => createSessionSettingsValues(session), [
    sessionId,
    session?.name,
    session?.platform,
    session?.workdir,
    session?.sessionPrompt,
  ])
  const [name, setName] = useState(initialValues.name)
  const [platform, setPlatform] = useState(initialValues.platform)
  const [workdir, setWorkdir] = useState(initialValues.workdir)
  const [sessionPrompt, setSessionPrompt] = useState(initialValues.sessionPrompt)
  // CWD-03：Workspace 实体绑定（方案 C）
  const workspaces = useWorkspaceEntityStore(state => state.workspaces)
  const boundWorkspace = session?.workspaceId
    ? workspaces.find(workspace => workspace.id === session.workspaceId)
    : undefined

  useEffect(() => {
    setName(session?.name || '')
    setPlatform(session?.platform || 'local')
    setWorkdir(session?.workdir || '')
    setSessionPrompt(session?.sessionPrompt || '')
  }, [sessionId, session?.name, session?.platform, session?.workdir, session?.sessionPrompt])

  if (!session) return null

  const currentValues = { name, platform, workdir, sessionPrompt }
  const dirty = isSessionSettingsDirty(currentValues, initialValues)
  const promptLines = sessionPrompt ? sessionPrompt.split(/\r?\n/).length : 0

  const closeWithoutSaving = () => {
    setName(initialValues.name)
    setPlatform(initialValues.platform)
    setWorkdir(initialValues.workdir)
    setSessionPrompt(initialValues.sessionPrompt)
    onClose()
  }

  const beforeClose = () => {
    if (dirty && !window.confirm('放弃未保存的会话设置？')) return
    closeWithoutSaving()
  }

  const save = () => {
    updateSession(sessionId, {
      name,
      platform,
      sessionPrompt,
      lastActiveAt: Date.now(),
    })
    onClose()
  }

  const del = async () => {
    if (!window.confirm(`删除会话“${session.name}”？此操作无法撤销。`)) return
    const sessionClient = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    const result = await removeSessionTransaction(sessionId, {
      findSession: id => useIdentityStore.getState().sessions.find(s => s.id === id),
      // DEL-03（§5.13 本地优先）：OwnerKey = [profileId, agentId, localSessionId]（与 eventSchema 同纪律）
      deleteSessionLocal: s => invoke('user_session_delete', {
        sessionId: s.id,
        ownerKey: sessionDurableOwnerKey(s),
      }),
      refreshSessionsBackend,
      // DEL-04（§5.13）删除终态：丢弃 canonical 未落盘事件（不复活；messages 表已停写）
      markSessionDeleted: id => {
        const target = useIdentityStore.getState().sessions.find(item => item.id === id)
        if (target) {
          getChatController()?.discardCanonicalEvents(sessionDurableOwnerKey(target))
        }
      },
      // OWNER-02：close 目标 owner 由 session 携带（agentId + source）；best effort，失败仅报告
      closeSession: s => sessionClient.closeSession({ agentId: s.agentId, source: s.source }),
      // DEL-03 终态化：deleting → deleted（best effort）
      finalizeSessionDelete: s => invoke('user_session_delete_finalize', {
        sessionId: s.id,
        ownerKey: sessionDurableOwnerKey(s),
      }),
      removeSession: id => useIdentityStore.getState().removeSession(id),
      clearMessages: id => clearMessageStorage(id, localStorage),
      reportError: (action, error) => reportRuntimeError(action, error),
    })
    if (!result.ok) return
    onClose()
    onDeleted?.()
  }

  return (
    <Dialog.Root open={open} onOpenChange={nextOpen => { if (!nextOpen) beforeClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content settings-surface settings-dialog session-settings"
          aria-describedby="session-settings-description"
        >
          <Dialog.Title asChild>
            <header className="session-settings-header settings-dialog-header">
              <div>
                <h3 className="settings-dialog-title">会话设置</h3>
                <p id="session-settings-description" className="settings-dialog-description">管理当前会话的身份、运行环境与专属 Prompt。</p>
              </div>
              <Dialog.Close className="modal-close settings-dialog-close" onClick={event => {
                event.preventDefault()
                beforeClose()
              }} aria-label="关闭会话设置">✕</Dialog.Close>
            </header>
          </Dialog.Title>

          <div className="session-settings-body">
            <section className="session-settings-section" aria-labelledby="session-basic-title">
              <div className="session-settings-section-heading">
                <div>
                  <h4 id="session-basic-title" className="settings-section-title">基本信息</h4>
                  <p className="session-settings-section-description settings-section-description">用于侧栏识别和来源分类。</p>
                </div>
              </div>
              <div className="session-settings-grid">
                <div className="sess-field">
                  <label htmlFor="session-name">名称</label>
                  <input id="session-name" className="settings-control" value={name} onChange={event => setName(event.target.value)} />
                </div>
                <div className="sess-field">
                  <label htmlFor="session-platform">平台</label>
                  <Select id="session-platform" className="settings-control" value={platform} onChange={setPlatform} options={[
                    { value: 'local', label: '本地' },
                    { value: 'qq-group', label: 'QQ 群聊' },
                    { value: 'qq-dm', label: 'QQ 私聊' },
                    { value: 'terminal', label: '终端' },
                  ]} />
                </div>
              </div>
            </section>

            <section className="session-settings-section" aria-labelledby="session-agent-title">
              <div className="session-settings-section-heading">
                <div>
                  <h4 id="session-agent-title" className="settings-section-title">Agent 运行环境</h4>
                  <p className="settings-section-description">cwd 由创建分区决定（聊天 / 工作区），会话创建后不再变更。</p>
                </div>
                <span className="session-settings-agent">{activeAgent || 'peri'}</span>
              </div>
              <div className="sess-field">
                <label>工作目录</label>
                <div className="sess-field-value" role="status">
                  {boundWorkspace ? (
                    <>
                      <span className="sess-workspace-name">{boundWorkspace.name}</span>
                      <code className="sess-workspace-root">{boundWorkspace.rootPath}</code>
                    </>
                  ) : (
                    <code className="sess-workspace-root">{workdir || '聊天分区（未绑定工作区）'}</code>
                  )}
                </div>
                <div className="set-hint" role="status">
                  来源：{boundWorkspace ? `工作区 ${boundWorkspace.name}` : '聊天分区；未继承工作区 Skills/Hooks'}
                </div>
                {boundWorkspace && (
                  <div className="set-hint" role="status">
                    创建时继承：{session.skills.length} Skills · {session.hooks.length} Hook
                    {' · '}当前工作区：{boundWorkspace.skills.length} Skills · {boundWorkspace.hookPluginIds.length} Hook · {boundWorkspace.mcpServerIds.length} MCP
                  </div>
                )}
              </div>
            </section>

            <section className="session-settings-section" aria-labelledby="session-prompt-title">
              <div className="session-settings-section-heading">
                <div>
                  <h4 id="session-prompt-title" className="settings-section-title">Session Prompt</h4>
                  <p className="settings-section-description">内容会叠加在创建会话时冻结的 Profile Persona 之后。</p>
                </div>
                <span className="session-settings-counter">{sessionPrompt.length} 字 · {promptLines} 行</span>
              </div>
              <div className="sess-field sess-field-prompt">
                <label htmlFor="session-prompt">会话专属 Prompt</label>
                <textarea id="session-prompt" className="settings-control" value={sessionPrompt} onChange={event => setSessionPrompt(event.target.value)} placeholder="可选：追加此会话专属指令..." rows={8} />
              </div>
            </section>

            <details className="session-settings-advanced">
              <summary>
                <span>高级能力</span>
                <span className="session-settings-status">未接入运行时</span>
              </summary>
              <div className="session-settings-advanced-body" role="status">
                <strong>MCP / Skills / Hooks</strong>
                <p>当前后端尚未提供会话级配置链路，因此这里仅说明状态，不提供编辑，也不会向 Agent 发送历史字段。</p>
              </div>
            </details>

            <section className="session-settings-danger" aria-labelledby="session-danger-title">
              <div>
                <h4 id="session-danger-title">危险区域</h4>
                <p>删除后会关闭后端会话并清理本地消息缓存，无法撤销。</p>
              </div>
              <button type="button" className="ps-btn danger" onClick={del}>删除会话</button>
            </section>
          </div>

          <footer className="session-settings-footer settings-dialog-footer">
            <span className={`session-settings-dirty settings-dirty-state ${dirty ? 'active' : ''}`} role="status">
              {dirty ? '有未保存修改' : '所有修改已保存'}
            </span>
            <div className="session-settings-footer-actions">
              <button type="button" className="ps-btn settings-action" onClick={beforeClose}>取消</button>
              <button type="button" className="ps-btn primary settings-action primary" onClick={save} disabled={!dirty}>保存修改</button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
