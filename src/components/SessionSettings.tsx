import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import { reportRuntimeError } from '../runtimeError'
import { runCloseSessionTransaction } from './chat/closeSessionTransaction'
import './SessionSettings.css'

interface Props { sessionId: string; open: boolean; onClose: () => void; onDeleted?: () => void }

export default function SessionSettings({ sessionId, open, onClose, onDeleted }: Props) {
  const sessions = useStore(s => s.sessions)
  const updateSession = useStore(s => s.updateSession)
  const removeSession = useStore(s => s.removeSession)
  const s = sessions.find(s => s.id === sessionId)
  const [name, setName] = useState(s?.name || '')
  const [platform, setPlatform] = useState(s?.platform || 'local')
  const [workdir, setWorkdir] = useState(s?.workdir || '')
  const [sessionPrompt, setSessionPrompt] = useState(s?.sessionPrompt || '')

  useEffect(() => {
    setName(s?.name || '')
    setPlatform(s?.platform || 'local')
    setWorkdir(s?.workdir || '')
    setSessionPrompt(s?.sessionPrompt || '')
  }, [sessionId, s?.name, s?.platform, s?.workdir, s?.sessionPrompt])

  if (!s) return null

  const save = () => {
    updateSession(sessionId, { name, platform, workdir, sessionPrompt, lastActiveAt: Date.now() })
    onClose()
  }

  const del = async () => {
    if (!window.confirm('删除会话？')) return
    const closed = await runCloseSessionTransaction({
      close: () => invoke('close_session', { source: s.source }),
      onSuccess: () => {},
      onError: error => reportRuntimeError('关闭会话', error),
    })
    if (!closed) return
    removeSession(sessionId)
    localStorage.removeItem('pylon-msgs-' + sessionId)
    onClose()
    onDeleted?.()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content session-settings">
          <Dialog.Title className="modal-header">
            <h3>会话设置</h3>
            <Dialog.Close className="modal-close" onClick={onClose}>✕</Dialog.Close>
          </Dialog.Title>

        <div className="sess-field">
          <label>名称</label>
          <input value={name} onChange={e => setName(e.target.value)} />
        </div>

        <div className="sess-field">
          <label>平台</label>
          <select value={platform} onChange={e => setPlatform(e.target.value)}>
            <option value="local">本地</option>
            <option value="qq-group">QQ 群聊</option>
            <option value="qq-dm">QQ 私聊</option>
            <option value="terminal">终端</option>
          </select>
        </div>

        <div className="sess-field">
          <label>工作目录</label>
          <input value={workdir} onChange={e => setWorkdir(e.target.value)} placeholder="留空使用 Agent 默认 cwd" />
        </div>

        <div className="sess-field">
          <label>会话 Prompt（覆盖 Profile persona）</label>
          <textarea value={sessionPrompt} onChange={e => setSessionPrompt(e.target.value)}
            placeholder="留空使用 Profile persona..." rows={4} />
        </div>

        <div className="sess-field sess-unavailable" role="status">
          <label>Skills / Hooks</label>
          <strong>未接入运行时</strong>
          <p>当前后端尚未提供会话级 Skills / Hooks 链路，因此此处不提供编辑，也不会把已有历史配置发送给 Agent。</p>
        </div>

        <div className="sess-actions">
          <button className="ps-btn primary" onClick={save}>保存</button>
          <button className="ps-btn" onClick={onClose}>取消</button>
          <button className="ps-btn danger" onClick={del}>删除会话</button>
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
