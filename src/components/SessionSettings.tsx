import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useStore, Session } from '../store'
import './SessionSettings.css'

interface Props { sessionId: string; open: boolean; onClose: () => void; onDeleted?: () => void }

export default function SessionSettings({ sessionId, open, onClose, onDeleted }: Props) {
  const sessions = useStore(s => s.sessions)
  const s = sessions.find(s => s.id === sessionId)
  if (!s) return null  // session deleted, close gracefully
  const [name, setName] = useState(s.name)
  const [platform, setPlatform] = useState(s.platform || 'local')
  const [workdir, setWorkdir] = useState(s.workdir || '')
  const [sessionPrompt, setSessionPrompt] = useState(s.sessionPrompt || '')
  const [skills, setSkills] = useState(s.skills || [])
  const [hooks, setHooks] = useState(s.hooks || [])
  const [newSkill, setNewSkill] = useState('')
  const [newHook, setNewHook] = useState('')

  const save = () => {
    const updated = sessions.map(ss => ss.id === sessionId ? {
      ...ss, name, platform, workdir, sessionPrompt, skills, hooks, lastActiveAt: Date.now()
    } : ss)
    useStore.setState({ sessions: updated })
    localStorage.setItem('pylon-sessions', JSON.stringify(updated))
    onClose()
  }

  const del = () => {
    if (!window.confirm('删除会话？')) return
    const updated = sessions.filter(ss => ss.id !== sessionId)
    useStore.setState({ sessions: updated })
    localStorage.setItem('pylon-sessions', JSON.stringify(updated))
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

        <div className="sess-field">
          <label>Skills</label>
          <div className="chip-row">
            {skills.map((sk, i) => (
              <span key={i} className="chip">{sk} <button onClick={() => setSkills(skills.filter((_, j) => j !== i))}>✕</button></span>
            ))}
          </div>
          <div className="chip-add">
            <input value={newSkill} onChange={e => setNewSkill(e.target.value)} placeholder="/command" />
            <button onClick={() => { if(newSkill.trim()) { setSkills([...skills, newSkill.trim()]); setNewSkill('') } }}>+</button>
          </div>
        </div>

        <div className="sess-field">
          <label>Hooks</label>
          <div className="chip-row">
            {hooks.map((h, i) => (
              <span key={i} className="chip">{h} <button onClick={() => setHooks(hooks.filter((_, j) => j !== i))}>✕</button></span>
            ))}
          </div>
          <div className="chip-add">
            <input value={newHook} onChange={e => setNewHook(e.target.value)} placeholder="hook 名" />
            <button onClick={() => { if(newHook.trim()) { setHooks([...hooks, newHook.trim()]); setNewHook('') } }}>+</button>
          </div>
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
