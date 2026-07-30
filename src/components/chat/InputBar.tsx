import { useState, useRef, KeyboardEvent, useEffect, forwardRef, useImperativeHandle } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useStore } from '../../store'
import { setSessionModel } from './sessionModel'
import { setSessionMode } from './sessionMode'
import { nextSessionMode } from './sessionModeState'
import { runSendTransaction } from './sendTransaction'
import { buildSendMessagePayload } from './sessionRuntime'
import { resolveSessionSource } from './sessionCommandState'
import { resolveSessionProfile } from './sessionProfile'
import { beginCancel, createCancelState, rejectCancelCommand, resolveCancelCommand, type CancelState } from './cancelState'
import { reportRuntimeError } from '../../runtimeError'
import { Paperclip, ArrowUp, Square } from 'lucide-react'
import type { AvailableCommand } from './acpTypes'
import { resolveCliTextareaLayout, resolveDefaultTextareaHeight } from './inputOverflowState'
import './InputBar.css'

interface Props { sessionId: string | null; split?: boolean; ariaDescribedBy?: string }

const EMPTY_COMMANDS: readonly AvailableCommand[] = Object.freeze([])

const FALLBACK_COMMANDS = [
  { cmd: '/model', args: ' <name>', info: '切换模型' },
  { cmd: '/compact', args: '', info: '压缩上下文' },
  { cmd: '/new', args: '', info: '新会话' },
  { cmd: '/export', args: '', info: '导出记录' },
  { cmd: '/clear', args: '', info: '清屏' },
  { cmd: '/mode', args: ' <default|edit|auto|bypass>', info: '切换权限模式' },
]

export default forwardRef<{ send: () => void; attachFile: () => void; cancel: () => void }, Props>(function InputBar({ sessionId, split, ariaDescribedBy }, ref) {
  const [value, setValue] = useState('')
  const [cmdIdx, setCmdIdx] = useState(0)
  const [sendError, setSendError] = useState('')
  const [attached, setAttached] = useState<{path:string;name:string;size:number}[]>([])
  const lastMsg = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const profiles = useStore(s => s.profiles)
  const sessions = useStore(s => s.sessions)
  const addSession = useStore(s => s.addSession)
  const inputMode = useStore(s => s.inputMode)
  const cliOverflowMode = useStore(s => s.cliOverflowMode || 'fixed-scroll')
  const sessionSource = useStore(s => resolveSessionSource(sessionId, s.sessions))
  const liveCommands = useStore(state => sessionSource
    ? (state.sessionLiveStats[sessionSource]?.commands ?? EMPTY_COMMANDS)
    : EMPTY_COMMANDS)
  // 当前 session 是否正在生成（用于把发送按钮切成"停止"）
  const generating = useStore(s => sessionSource != null && (s.liveGeneratingSources || []).includes(sessionSource))
  const cancelStateRef = useRef<CancelState>(createCancelState(sessionSource || ''))

  useEffect(() => {
    if (cancelStateRef.current.source !== (sessionSource || '')) {
      cancelStateRef.current = createCancelState(sessionSource || '')
    }
    if (sessionSource && generating && cancelStateRef.current.status !== 'canceling') {
      cancelStateRef.current = { source: sessionSource, status: 'generating' }
    }
  }, [sessionSource, generating])

  const sessionProfile = resolveSessionProfile(sessionId, sessions, profiles)
  const persona = sessionProfile?.persona || ''

  const COMMANDS = liveCommands.length > 0
    ? liveCommands.map((c: {name: string; input_hint?: string; description?: string}) => ({ cmd: '/' + c.name, args: c.input_hint ? ' ' + c.input_hint : '', info: c.description || '' }))
    : FALLBACK_COMMANDS

  const isCmd = value.startsWith('/')
  const filtered = isCmd ? COMMANDS.filter((c: typeof COMMANDS[number]) => c.cmd.startsWith(value.split(' ')[0])) : []

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    if (inputMode !== 'cli') {
      textarea.style.height = `${resolveDefaultTextareaHeight(textarea.scrollHeight)}px`
      textarea.style.overflowY = textarea.scrollHeight > 200 ? 'auto' : 'hidden'
      return
    }
    const layout = resolveCliTextareaLayout(textarea.scrollHeight, cliOverflowMode)
    textarea.style.height = `${layout.height}px`
    textarea.style.overflowY = layout.overflowY
    textarea.dataset.expanded = String(layout.expanded)
  }, [value, inputMode, cliOverflowMode])

  useEffect(() => {
    const onModelError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      setSendError(message || '模型切换失败')
    }
    window.addEventListener('pylon:model-error', onModelError)
    return () => window.removeEventListener('pylon:model-error', onModelError)
  }, [])

  useEffect(() => {
    const onModeError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      setSendError(message || '权限模式切换失败')
    }
    window.addEventListener('pylon:mode-error', onModeError)
    return () => window.removeEventListener('pylon:mode-error', onModeError)
  }, [])

  // 全局取消：焦点不在输入框（如阅读长回复）时，Esc / Ctrl+C 也能中断生成
  useEffect(() => {
    const onGlobalKey = (e: globalThis.KeyboardEvent) => {
      if (!sessionId || !sessionSource) return
      if (!(useStore.getState().liveGeneratingSources || []).includes(sessionSource)) return
      const isEsc = e.key === 'Escape'
      const isCtrlC = e.ctrlKey && (e.key === 'c' || e.key === 'C') && !window.getSelection()?.toString()
      if (isEsc || isCtrlC) {
        e.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onGlobalKey)
    return () => window.removeEventListener('keydown', onGlobalKey)
  }, [sessionId, sessionSource, generating])

  const execCommand = async (cmd: string, rest: string) => {
    switch (cmd) {
      case '/model': {
        const model = rest.trim()
        if (!model) {
          setSendError('请输入模型名称')
          return false
        }
        if (!sessionSource) {
          setSendError('当前会话不可用')
          return false
        }
        try {
          await setSessionModel(sessionSource, model)
        } catch (error) {
          setSendError(String(error))
          return false
        }
        break
      }
      case '/mode': {
        const mode = rest.trim()
        if (!mode) {
          setSendError('请输入权限模式')
          return false
        }
        if (!sessionSource) {
          setSendError('当前会话不可用')
          return false
        }
        try {
          await setSessionMode(sessionSource, mode)
        } catch (error) {
          setSendError(String(error))
          return false
        }
        break
      }
      case '/new': addSession(`session-${Date.now().toString(36)}`); break
      case '/compact': {
        const s = useStore.getState().sessions.find(item => item.id === sessionId || item.source === sessionId)
        if (!s || !sessionSource || s.source !== sessionSource) {
          setSendError('当前会话不可用')
          return false
        }
        return runSendTransaction({
          send: () => invoke('send_message', buildSendMessagePayload({
            session: s,
            content: '/compact',
            persona,
            attachments: attached.map(file => file.path),
          })),
          onSuccess: () => {
            setValue('')
            setAttached([])
            setSendError('')
          },
          onError: error => setSendError(String(error)),
        })
      }
      case '/export': {
        const s = useStore.getState().sessions.find(x => x.id === sessionId || x.source === sessionId)
        if (s?.periId) {
          const outputPath = await save({
            defaultPath: `session-${s.periId}.md`,
            filters: [{ name: 'Markdown', extensions: ['md'] }],
          })
          if (outputPath) {
            await invoke('export_session', { periId: s.periId, format: 'markdown', outputPath })
          }
        }
        break
      }
      case '/clear': window.dispatchEvent(new CustomEvent('peri:clear')); break
    }
    setValue('')
    setCmdIdx(0)
    return true
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

    const s = useStore.getState().sessions.find(s => s.id === sessionId || s.source === sessionId)
    if (!s) {
      setSendError('当前会话不可用')
      return
    }

    await runSendTransaction({
      send: () => invoke('send_message', buildSendMessagePayload({
        session: s,
        content: text,
        persona,
        attachments: attached.map(file => file.path),
      })),
      onSuccess: () => {
        lastMsg.current = text
        setValue('')
        setAttached([])
        setSendError('')
      },
      onError: error => setSendError(String(error)),
    })
  }

  const cancel = async () => {
    if (!sessionId || !sessionSource) return
    const begun = beginCancel(sessionSource, cancelStateRef.current)
    if (!begun.shouldInvoke) return
    cancelStateRef.current = begun.state
    try {
      await invoke('cancel_prompt', { source: sessionSource })
      cancelStateRef.current = resolveCancelCommand(sessionSource, cancelStateRef.current)
    } catch (error) {
      cancelStateRef.current = rejectCancelCommand(sessionSource, cancelStateRef.current, error)
      const detail = reportRuntimeError('取消生成', error)
      setSendError(detail.message)
    }
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

  useImperativeHandle(ref, () => ({ send, attachFile, cancel }), [value, attached, sessionId, sessionSource, isCmd, filtered])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && generating) { e.preventDefault(); cancel(); return }
    // Ctrl+C 取消生成 — 但若有选中文本则让浏览器复制优先，不拦截
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && generating) {
      const hasSelection = !!window.getSelection()?.toString()
      if (!hasSelection) { e.preventDefault(); cancel(); return }
    }
    if (e.ctrlKey && e.key === 'ArrowUp') { e.preventDefault(); if (lastMsg.current) setValue(lastMsg.current) }
    if (e.key === 'Tab' && e.shiftKey && sessionSource) {
      e.preventDefault()
      const currentMode = useStore.getState().sessionModes[sessionSource] || 'default'
      setSessionMode(sessionSource, nextSessionMode(currentMode)).catch(error => setSendError(String(error)))
      return
    }
    if (isCmd && filtered.length > 0) {
      if (e.key === 'Tab') { e.preventDefault(); setCmdIdx(i => (i + 1) % filtered.length); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIdx(i => Math.min(i + 1, filtered.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIdx(i => Math.max(i - 1, 0)); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div className={`input-bar ${inputMode === 'cli' ? 'cli-mode' : ''} cli-overflow-${cliOverflowMode}`}>
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
              onClick={() => { setValue(c.cmd + c.args + ' '); textareaRef.current?.focus() }}>
              <span className="cmd-name">{c.cmd}{c.args}</span>
              <span className="cmd-info">{c.info}</span>
            </div>
          ))}
        </div>
      )}
      <div className="input-row">
        {inputMode === 'cli' && <span className="cli-prefix">❯</span>}
        {!split && (
          <button className="input-btn attach" onClick={attachFile} title="Attach file (Ctrl+O)">
            <Paperclip size={16} />
          </button>
        )}
        <textarea ref={textareaRef} className="input-textarea" value={value}
          onChange={e => { setValue(e.target.value); setCmdIdx(0) }}
          onKeyDown={onKey}
          aria-describedby={ariaDescribedBy}
          placeholder={inputMode === 'cli' ? '' : '输入消息...（Enter 发送，Shift+Enter 换行，/ 命令）'}
          rows={1} />
        {!split && (
          <button className={`input-btn ${generating ? 'stop' : 'send'}`} onClick={generating ? cancel : send}
            title={generating ? '停止生成 (Esc / Ctrl+C)' : 'Send (Enter)'} aria-label={generating ? '停止生成' : '发送'}>
            {generating ? <Square size={16} /> : <ArrowUp size={18} />}
          </button>
        )}
      </div>
    </div>
  )
})
