import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useIdentityStore } from '../identityStore'
import { reportRuntimeError } from '../runtimeError'
import { removeSessionTransaction } from '../application/transactions/removeSessionTransaction'
import { clearMessageStorage } from './chat/messagePersistence'
import { createSessionSettingsValues, isSessionSettingsDirty } from './sessionSettingsForm'
import './SettingsCommon.css'
import './SessionSettings.css'

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
      workdir,
      sessionPrompt,
      lastActiveAt: Date.now(),
    })
    onClose()
  }

  const del = async () => {
    if (!window.confirm(`删除会话“${session.name}”？此操作无法撤销。`)) return
    const result = await removeSessionTransaction(sessionId, {
      findSession: id => useIdentityStore.getState().sessions.find(s => s.id === id),
      closeSession: source => invoke('close_session', { source }),
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
                  <select id="session-platform" className="settings-control" value={platform} onChange={event => setPlatform(event.target.value)}>
                    <option value="local">本地</option>
                    <option value="qq-group">QQ 群聊</option>
                    <option value="qq-dm">QQ 私聊</option>
                    <option value="terminal">终端</option>
                  </select>
                </div>
              </div>
            </section>

            <section className="session-settings-section" aria-labelledby="session-agent-title">
              <div className="session-settings-section-heading">
                <div>
                  <h4 id="session-agent-title" className="settings-section-title">Agent 运行环境</h4>
                  <p className="settings-section-description">工作目录只影响当前会话。</p>
                </div>
                <span className="session-settings-agent">{activeAgent || 'peri'}</span>
              </div>
              <div className="sess-field">
                <label htmlFor="session-workdir">工作目录</label>
                <input id="session-workdir" className="settings-control" value={workdir} onChange={event => setWorkdir(event.target.value)} placeholder="留空使用 Agent 默认 cwd" />
                <p className="sess-field-hint">当前 Agent：{activeAgent || 'peri'}。连接状态由全局 Agent 设置管理。</p>
              </div>
            </section>

            <section className="session-settings-section" aria-labelledby="session-prompt-title">
              <div className="session-settings-section-heading">
                <div>
                  <h4 id="session-prompt-title" className="settings-section-title">Session Prompt</h4>
                  <p className="settings-section-description">留空时继续使用 Profile persona。</p>
                </div>
                <span className="session-settings-counter">{sessionPrompt.length} 字 · {promptLines} 行</span>
              </div>
              <div className="sess-field sess-field-prompt">
                <label htmlFor="session-prompt">会话专属 Prompt</label>
                <textarea id="session-prompt" className="settings-control" value={sessionPrompt} onChange={event => setSessionPrompt(event.target.value)} placeholder="留空使用 Profile persona..." rows={8} />
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
