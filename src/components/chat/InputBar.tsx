import { useState, useRef, KeyboardEvent } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import './InputBar.css'

interface Props { sessionId: string | null }

export default function InputBar({ sessionId }: Props) {
  const [value, setValue] = useState('')
  const [showCmds, setShowCmds] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  const cmds = [
    { cmd: '/model', desc: '切换模型' }, { cmd: '/compact', desc: '压缩会话' },
    { cmd: '/new', desc: '新建会话' }, { cmd: '/clear', desc: '清空视图' },
    { cmd: '/export', desc: '导出会话' },
  ]
  const filtered = value.startsWith('/') ? cmds.filter(c => c.cmd.startsWith(value.split(' ')[0])) : []

  const send = () => { if (!value.trim()) return; console.log('send:', value); setValue(''); setShowCmds(false) }
  const pickFile = async () => {
    const path = await open({ multiple: false })
    if (path) setValue(v => v + (v ? ' ' : '') + path)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
    if (e.key === 'Escape') setShowCmds(false)
  }

  return (
    <div className="input-bar">
      {showCmds && filtered.length > 0 && (
        <div className="command-palette">
          {filtered.map(c => (
            <div key={c.cmd} className="command-item" onClick={() => { setValue(c.cmd + ' '); setShowCmds(false); ref.current?.focus() }}>
              <span className="command-name">{c.cmd}</span>
              <span className="command-desc">{c.desc}</span>
            </div>
          ))}
        </div>
      )}
      <div className="input-row">
        <button className="attach-btn" title="Attach file" onClick={pickFile}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>
        <textarea ref={ref} className="input-textarea" value={value}
          onChange={e => { setValue(e.target.value); if (e.target.value.startsWith('/')) setShowCmds(true) }}
          onKeyDown={onKey} placeholder="Message (Enter 发送，Shift+Enter 换行，/ 命令)" rows={1}
        />
        <button className="send-btn" disabled={!value.trim()} onClick={send}>⏎</button>
      </div>
    </div>
  )
}
