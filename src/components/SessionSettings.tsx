import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { invoke } from '@tauri-apps/api/core'
import { refreshSessionsBackend, useIdentityStore } from '../identityStore'
import { reportRuntimeError } from '../runtimeError'
import { createSessionClient } from '../infrastructure/acp/sessionClient'
import { removeSessionTransaction, sessionDurableOwnerKey } from '../application/transactions/removeSessionTransaction'

import { getCanonicalEventFeed } from '../infrastructure/events/canonicalEventFeed.ts'
import { clearMessageStorage } from './chat/messagePersistence'
import { createSessionSettingsValues, isSessionSettingsDirty } from './sessionSettingsForm'

interface Props { sessionId: string; open: boolean; onClose: () => void; onDeleted?: () => void }

export default function SessionSettings({ sessionId, open, onClose, onDeleted }: Props) {
  const updateSession = useIdentityStore(state => state.updateSession)
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

  useEffect(() => {
    setName(session?.name || '')
    setPlatform(session?.platform || 'local')
    setWorkdir(session?.workdir || '')
    setSessionPrompt(session?.sessionPrompt || '')
  }, [sessionId, session?.name, session?.platform, session?.workdir, session?.sessionPrompt])

  if (!session) return null

  const currentValues = { name, platform, workdir, sessionPrompt }
  const dirty = isSessionSettingsDirty(currentValues, initialValues)

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
      // tombstone 成功后立即封住在途 canonical 写；revision 刷新可能仍在等待。
      markSessionDeleting: id => {
        const target = useIdentityStore.getState().sessions.find(item => item.id === id)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
        }
      },
      // DEL-04（§5.13）删除终态：丢弃 canonical 未落盘事件（不复活；messages 表已停写）
      markSessionDeleted: id => {
        const target = useIdentityStore.getState().sessions.find(item => item.id === id)
        if (target) {
          getCanonicalEventFeed().discard(sessionDurableOwnerKey(target))
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
                <p id="session-settings-description" className="settings-dialog-description">管理当前会话的名称与基础操作。</p>
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
                  <p className="session-settings-section-description settings-section-description">用于侧栏识别。</p>
                </div>
              </div>
              <div className="session-settings-grid">
                <div className="sess-field">
                  <label htmlFor="session-name">名称</label>
                  <input id="session-name" className="settings-control" value={name} onChange={event => setName(event.target.value)} />
                </div>
              </div>
            </section>

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
