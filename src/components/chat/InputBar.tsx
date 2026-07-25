import { useState, useRef, KeyboardEvent, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useStore } from '../../store'
import { Paperclip, ArrowUp } from 'lucide-react'
import './InputBar.css'

interface Props { sessionId: string | null }

const FALLBACK_COMMANDS = [
  { cmd: '/model', args: ' <name>', info: '切换模型' },
  { cmd: '/compact', args: '', info: '压缩上下文' },
  { cmd: '/new', args: '', info: '新会话' },
  { cmd: '/export', args: '', info: '导出记录' },
  { cmd: '/clear', args: '', info: '清屏' },
  { cmd: '/mode', args: ' <default|edit|auto|bypass>', info: '切换权限模式' },
]

export default function InputBar({ sessionId }: Props) {
  const [value, setValue] = useState('')
  const [cmdIdx, setCmdIdx] = useState(0)
  const [sendError, setSendError] = useState('')
  const [attached, setAttached] = useState<{path:string;name:string;size:number}[]>([])
  const lastMsg = useRef('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const activeProfileId = useStore(s => s.activeProfileId)
  const profiles = useStore(s => s.profiles)
  const addSession = useStore(s => s.addSession)
  const liveCommands = useStore(s => s.liveCommands || [])

  const activeProfile = profiles.find(p => p.id === activeProfileId)
  const persona = activeProfile?.persona || ''

  // Dynamic commands: peri > fallback
  const COMMANDS = liveCommands.length > 0
    ? liveCommands.map((c: {name: string; input_hint?: string; description?: string}) => ({ cmd: '/' + c.name, args: c.input_hint ? ' ' + c.input_hint : '', info: c.description || '' }))
    : FALLBACK_COMMANDS

  const isCmd = value.startsWith('/')
  const filtered = isCmd ? COMMANDS.filter((c: typeof COMMANDS[number]) => c.cmd.startsWith(value.split(' ')[0])) : []

  // Auto-resize textarea
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto'
      ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + 'px'
    }
  }, [value])

  const execCommand = async (cmd: string, rest: string) => {
    switch (cmd) {
      case '/model': {
        const m = rest.trim() || 'deepseek-v4-flash'
        const p = profiles.find(x => x.id === activeProfileId)
        if (p) useStore.getState().addProfile({ ...p, model: m })
        break
      }
      case '/mode': {
        const m = rest.trim()
        if (m && sessionId) {
          useStore.getState().setLiveStats({ liveMode: m })
          invoke('set_mode', { source: sessionId, mode: m }).catch(() => {})
        }
        break
      }
      case '/new': addSession(`session-${Date.now().toString(36)}`); break
      case '/compact': await invoke('send_message', { source: sessionId, content: '/compact', persona }); break
      case '/export': {
        const s = useStore.getState().sessions.find(x => x.source === sessionId)
        if (s?.periId) {
          await invoke('export_session', { periId: s.periId, format: 'markdown', outputPath: `session-${s.periId}.md` })
        }
        break
      }
      case '/clear': window.dispatchEvent(new CustomEvent('peri:clear')); break
    }
    setValue('')
    setCmdIdx(0)
  }

  const send = async () => {
    const text = value.trim()
    if (!text || !sessionId) return

    if (isCmd && filtered.length > 0) {
      const parts = text.split(/\s+/)
      const rest = parts.slice(1).join(' ')
      await execCommand(parts[0], rest)
      return
    }

    const s = useStore.getState().sessions.find(s => s.source === sessionId)
    const sessionPrompt = s?.sessionPrompt || ''

    try { await invoke('send_message', { source: sessionId, content: text, persona, sessionPrompt, attachments: attached.map(a => a.path) }) }
    catch (e) { setSendError(String(e)); setTimeout(() => setSendError(''), 4000) }
    lastMsg.current = text
    setValue('')
    setAttached([])
  }

  const attachFile = async () => {
    try {
      const selected = await open({ multiple: false })
      if (!selected) return
      const path = selected as string
      const name = path.replace(/^.*[\\\\/]/, '')
      setAttached(prev => [...prev, { path, name, size: 0 }])
    } catch (e) { /* cancelled */ }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'ArrowUp') { e.preventDefault(); if (lastMsg.current) setValue(lastMsg.current) }
    if (isCmd && filtered.length > 0) {
      if (e.key === 'Tab') { e.preventDefault(); setCmdIdx(i => (i + 1) % filtered.length); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIdx(i => Math.min(i + 1, filtered.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIdx(i => Math.max(i - 1, 0)); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div className={`input-bar ${useStore.getState().inputMode === 'cli' ? 'cli-mode' : ''}`}>
      {sendError && <div className="input-error">{sendError}</div>}
      {attached.length > 0 && (
        <div className="attached-files">
          {attached.map((f, i) => (
            <span key={i} className="attached-chip" onClick={() => setAttached(prev => prev.filter((_, j) => j !== i))}>
              📎 {f.name} ✕
            </span>
          ))}
        </div>
      )}
      {isCmd && filtered.length > 0 && (
        <div className="command-palette">
          {filtered.map((c: typeof COMMANDS[number], i: number) => (
            <div key={c.cmd} className={`cmd-item ${i === cmdIdx ? 'active' : ''}`}
              onClick={() => { setValue(c.cmd + c.args + ' '); ref.current?.focus() }}>
              <span className="cmd-name">{c.cmd}{c.args}</span>
              <span className="cmd-info">{c.info}</span>
            </div>
          ))}
        </div>
      )}
      <div className="input-row">
        {useStore.getState().inputMode === 'cli' && <span className="cli-prefix">&gt;</span>}
        <button className="input-btn attach" onClick={attachFile} title="Attach file (Ctrl+O)">
          <Paperclip size={16} />
        </button>
        <textarea ref={ref} className="input-textarea" value={value}
          onChange={e => { setValue(e.target.value); setCmdIdx(0) }}
          onKeyDown={onKey}
          placeholder="输入消息...（Enter 发送，Shift+Enter 换行，/ 命令）"
          rows={1} />
        <button className="input-btn send" onClick={send} title="Send (Enter)">
          <ArrowUp size={18} />
        </button>
      </div>
    </div>
  )
}
