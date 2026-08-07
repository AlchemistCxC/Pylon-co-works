import { useState, useRef, KeyboardEvent, useEffect, forwardRef, useImperativeHandle, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useStore } from '../../store'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { useAgentCapabilities } from '../../infrastructure/acp/useAgentCapabilities'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { createSessionClient } from '../../infrastructure/acp/sessionClient'
import { resolveAttachGate, resolveAttachFilters } from '../../infrastructure/acp/agentContracts'
import { createAttachment, validateAttachment, type AttachmentItem } from '../../domains/attachment/attachmentItem'
import { reportRuntimeError } from '../../runtimeError'
import { setSessionModel } from './sessionModel'
import { setSessionMode } from './sessionMode'
import { nextSessionMode } from './sessionModeState'
import { runSendTransaction } from './sendTransaction'
import { buildSendMessagePayload } from './sessionRuntime'
import { resolveSessionSource } from './sessionCommandState'
import { resolveSessionProfile } from './sessionProfile'
import { getChatController } from './chatEventController'
import { stripHiddenUnicode } from '../../utils/unicodeSanitizer'
import { Paperclip, ArrowUp, Square, Pencil, Send, Trash2 } from 'lucide-react'
import type { AvailableCommand } from '../../infrastructure/acp/chatContracts'
import { resolveCliTextareaLayout, resolveDefaultTextareaHeight } from './inputOverflowState'
import { resolveCommandSuggestions, filterCommandSuggestions, parseSlashCommand, type CommandSuggestion } from './commandRegistry'
import { useSessionUiState } from './sessionUiState'
import './InputBar.css'

interface Props { sessionId: string | null; split?: boolean; ariaDescribedBy?: string; externalSend?: boolean; externalAttach?: boolean }

const EMPTY_COMMANDS: readonly AvailableCommand[] = Object.freeze([])

interface QueuedMessage {
  id: number
  text: string
  editing: boolean
}

export default forwardRef<{ send: () => void; attachFile: () => void; cancel: () => void }, Props>(function InputBar({ sessionId, split, ariaDescribedBy, externalSend = false, externalAttach = false }, ref) {
  // 草稿按会话作用域：切会话不串（A 草稿不显示在 B）、不丢（切回 A 恢复）
  const [value, setValue] = useSessionUiState(sessionId, 'draft', '')
  const [cmdIdx, setCmdIdx] = useState(0)
  const [sendError, setSendError] = useState('')
  const [attached, setAttached] = useState<AttachmentItem[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [historyLength, setHistoryLength] = useState(0)
  // FE-AUD-020：队列按 session 保存（sessionUiState）——切 Sheet/重挂载不丢，删除 session 清理
  const [queuedMessages, setQueuedMessages] = useSessionUiState<QueuedMessage[]>(sessionId, 'queued-messages', [])
  const lastMsg = useRef('')
  const historyBySourceRef = useRef<Record<string, string[]>>({})
  const historyDraftRef = useRef('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const profiles = useIdentityStore(s => s.profiles)
  const sessions = useIdentityStore(s => s.sessions)
  const addSession = useIdentityStore(s => s.addSession)
  const inputVariant = useStore(s => s.inputVariant || (s.inputMode === 'cli' ? 'cli' : 'composer'))
  const showPlaceholder = useStore(s => s.inputShowPlaceholder !== false)
  const showHistoryHint = useStore(s => s.inputShowHistoryHint !== false)
  const submitButtonMode = useStore(s => s.inputSubmitButtonMode || 'inline')
  const cliOverflowMode = useStore(s => s.cliOverflowMode || 'fixed-scroll')
  const sessionSource = useIdentityStore(s => resolveSessionSource(sessionId, s.sessions))
  const liveCommands = useRuntimeStore(state => sessionSource
    ? (state.sessionLiveStats[sessionSource]?.commands ?? EMPTY_COMMANDS)
    : EMPTY_COMMANDS)
  // 当前 session 是否正在生成（用于把发送按钮切成"停止"）
  const generating = useRuntimeStore(s => sessionSource != null && (s.liveGeneratingSources || []).includes(sessionSource))
  // 附件能力（F4-C）：gate 拦截未连接；filters 按 promptImage 降级 accept
  const attachCapabilities = useAgentCapabilities()
  const attachImageUnsupported = attachCapabilities.connected && !attachCapabilities.promptImage

  useEffect(() => {
    historyDraftRef.current = ''
    setHistoryIndex(-1)
    setHistoryLength(sessionSource ? (historyBySourceRef.current[sessionSource]?.length || 0) : 0)
  }, [sessionSource])

  useEffect(() => {
    setQueuedMessages([])
  }, [sessionSource])

  const sessionProfile = resolveSessionProfile(sessionId, sessions, profiles)
  const persona = sessionProfile?.persona || ''

  const COMMANDS = useMemo(() => resolveCommandSuggestions(liveCommands), [liveCommands])

  const recordHistory = (text: string) => {
    if (!sessionSource || !text) return
    const previous = historyBySourceRef.current[sessionSource] || []
    const next = previous.filter(item => item !== text).concat(text).slice(-50)
    historyBySourceRef.current[sessionSource] = next
    setHistoryLength(next.length)
    setHistoryIndex(-1)
    historyDraftRef.current = ''
  }

  const isCmd = value.startsWith('/')
  const filtered = isCmd ? filterCommandSuggestions(value, COMMANDS) : []

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    if (inputVariant !== 'cli') {
      textarea.style.height = `${resolveDefaultTextareaHeight(textarea.scrollHeight)}px`
      textarea.style.overflowY = textarea.scrollHeight > 200 ? 'auto' : 'hidden'
      return
    }
    const layout = resolveCliTextareaLayout(textarea.scrollHeight, cliOverflowMode)
    textarea.style.height = `${layout.height}px`
    textarea.style.overflowY = layout.overflowY
    textarea.dataset.expanded = String(layout.expanded)
  }, [value, inputVariant, cliOverflowMode])

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
      if (!(useRuntimeStore.getState().liveGeneratingSources || []).includes(sessionSource)) return
      const isEsc = e.key === 'Escape'
      const isCtrlC = e.ctrlKey && (e.key === 'c' || e.key === 'C') && !window.getSelection()?.toString()
      if (isEsc || isCtrlC) {
        e.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onGlobalKey)
    return () => window.removeEventListener('keydown', onGlobalKey)
    // cancel 是稳定 useCallback（引用型），事件监听靠 sessionId/generating 重绑
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const s = useIdentityStore.getState().sessions.find(item => item.id === sessionId || item.source === sessionId)
        if (!s || !sessionSource || s.source !== sessionSource) {
          setSendError('当前会话不可用')
          return false
        }
        return runSendTransaction({
          send: () => createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).sendMessage(buildSendMessagePayload({
            session: s,
            content: '/compact',
            persona,
            attachments: attached.filter(file => file.status !== 'error').map(file => file.path),
          })),
          onSuccess: () => {
            recordHistory('/compact')
            setValue('')
            setAttached([])
            setSendError('')
          },
          onError: error => setSendError(String(error)),
        })
      }
      case '/export': {
        const s = useIdentityStore.getState().sessions.find(x => x.id === sessionId || x.source === sessionId)
        if (s?.periId) {
          // 2026-08-02 修复：invoke 失败不再冒泡成未处理 rejection（旧实现无 try/catch）
          try {
            const outputPath = await save({
              defaultPath: `session-${s.periId}.md`,
              filters: [{ name: 'Markdown', extensions: ['md'] }],
            })
            if (outputPath) {
              await createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).exportSession({ periId: s.periId, format: 'markdown', outputPath })
              setSendError('')
            }
          } catch (error) {
            setSendError(String(error))
            return false
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

  const sendText = async (text: string) => {
    if (!text || !sessionId) return false

    if (isCmd && filtered.length > 0) {
      const parsed = parseSlashCommand(text)
      if (!parsed) {
        setSendError('命令格式无效')
        return
      }
      await execCommand(parsed.name, parsed.args)
      return true
    }

    const s = useIdentityStore.getState().sessions.find(s => s.id === sessionId || s.source === sessionId)
    if (!s) {
      setSendError('当前会话不可用')
      return
    }

    await runSendTransaction({
      send: () => createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).sendMessage(buildSendMessagePayload({
        session: s,
        content: stripHiddenUnicode(text),
        persona,
        attachments: attached.filter(file => file.status !== 'error').map(file => file.path),
      })),
      onSuccess: () => {
        lastMsg.current = text
        recordHistory(text)
        setValue('')
        setAttached([])
        setSendError('')
      },
      onError: error => setSendError(String(error)),
    })
    return true
  }

  const enqueue = (text: string) => {
    if (!text || !sessionSource) return
    setQueuedMessages(previous => [...previous, { id: Date.now() + previous.length, text, editing: false }])
    setValue('')
    setAttached([])
    setSendError('')
  }

  const send = async () => {
    const text = value.trim()
    if (!text || !sessionId) return
    if (generating) {
      enqueue(text)
      return
    }
    await sendText(text)
  }

  const sendQueued = async (item: QueuedMessage) => {
    if (generating || !item.text.trim()) return
    const sent = await sendText(item.text.trim())
    if (sent) setQueuedMessages(previous => previous.filter(queued => queued.id !== item.id))
  }

  const cancel = async () => {
    if (!sessionId || !sessionSource) return
    // 统一取消入口：与 Footer 停止按钮同路径（controller.requestCancel →
    // reducer begin-cancel 去重 → invoke → cancel-success/rejected 收敛）
    getChatController()?.requestCancel(sessionSource)
  }

  const attachFile = async () => {
    const gate = resolveAttachGate(attachCapabilities)
    if (!gate.allowed) {
      reportRuntimeError('打开附件选择器', gate.reason)
      return
    }
    try {
      const selected = await open({ multiple: false, filters: resolveAttachFilters(attachCapabilities) })
      if (!selected) return
      const path = selected as string
      const name = path.replace(/^.*[\\\\/]/, '')
      // FE-AUD-019：选择后校验（重复/未知类型）——error 附件保留并显示原因
      const item = createAttachment(path, name)
      const validation = validateAttachment(item, { existingPaths: new Set(attached.map(file => file.path)) })
      setAttached(prev => [...prev, validation.ok ? { ...item, status: 'ready' } : { ...item, status: 'error', error: validation.error }])
    } catch { /* cancelled */ }
  }

  // deps 必须覆盖 send 引用的 generating 与 sendText 引用的 persona，否则外部 ref.send()
  // 在生成状态翻转瞬间使用过期闭包（enqueue 与直接发送二选一错位）。
  // send/cancel 是稳定 useCallback，无需入 deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({ send, attachFile, cancel }), [value, attached, sessionId, sessionSource, isCmd, filtered, generating, persona, attachCapabilities])

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
      const currentMode = useRuntimeStore.getState().sessionModes[sessionSource] || 'default'
      setSessionMode(sessionSource, nextSessionMode(currentMode)).catch(error => setSendError(String(error)))
      return
    }
    if (isCmd && filtered.length > 0) {
      if (e.key === 'Tab') { e.preventDefault(); setCmdIdx(i => (i + 1) % filtered.length); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIdx(i => Math.min(i + 1, filtered.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIdx(i => Math.max(i - 1, 0)); return }
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!sessionSource || historyLength === 0) return
      e.preventDefault()
      const history = historyBySourceRef.current[sessionSource] || []
      if (historyIndex < 0) historyDraftRef.current = value
      // nextIndex 语义 = "从最新往回数第几条"（0 = 最新一条，len-1 = 最旧一条）。
      // 修复（2026-08-02）：↑ 应 +1 前进到更旧，首次按必须从最新（0）开始；
      // 旧实现首次直接跳 len-1（最旧）且再次 ↑ 卡死（min(historyIndex+1, len-1) 恒等于 len-1）。
      const nextIndex = e.key === 'ArrowUp'
        ? Math.min(historyIndex + 1, history.length - 1)
        : Math.max(historyIndex - 1, -1)
      setHistoryIndex(nextIndex)
      setValue(nextIndex < 0 ? historyDraftRef.current : history[history.length - 1 - nextIndex])
      return
    }
    if (e.key === 'Escape' && historyIndex >= 0) {
      e.preventDefault()
      setHistoryIndex(-1)
      setValue(historyDraftRef.current)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div className={`input-bar input-variant-${inputVariant} ${inputVariant === 'cli' ? 'cli-mode' : ''} cli-overflow-${cliOverflowMode}`}>
      {inputVariant === 'command' && <div className="input-command-kicker">COMMAND</div>}
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
          {filtered.map((c: CommandSuggestion, i: number) => (
            <div key={c.cmd} className={`cmd-item ${i === cmdIdx ? 'active' : ''}`}
              onClick={() => { setValue(c.cmd + c.args + ' '); textareaRef.current?.focus() }}>
              <span className="cmd-name">{c.cmd}{c.args}</span>
              <span className="cmd-info">{c.info}</span>
            </div>
          ))}
        </div>
      )}
      {showHistoryHint && historyIndex >= 0 && historyLength > 0 && (
        <div className="input-history-hint" aria-live="polite">
          历史记录 {historyIndex + 1}/{historyLength} · ↑/↓ 浏览 · Esc 返回草稿
        </div>
      )}
      {queuedMessages.length > 0 && (
        <div className="queued-message-list" aria-label="待发送消息">
          <div className="queued-message-title">待发送 · {queuedMessages.length}</div>
          {queuedMessages.map(item => (
            <div className="queued-message" key={item.id}>
              {item.editing
                ? <textarea
                  className="queued-message-editor"
                  value={item.text}
                  onChange={event => setQueuedMessages(previous => previous.map(queued => queued.id === item.id ? { ...queued, text: event.target.value } : queued))}
                  aria-label="编辑待发送消息"
                />
                : <span className="queued-message-text">{item.text}</span>}
              <div className="queued-message-actions">
                <button type="button" onClick={() => setQueuedMessages(previous => previous.map(queued => queued.id === item.id ? { ...queued, editing: !queued.editing } : queued))} aria-label="编辑待发送消息" title="编辑">
                  <Pencil size={13} />
                </button>
                <button type="button" onClick={() => sendQueued(item)} disabled={generating || !item.text.trim()} aria-label="发送待发送消息" title={generating ? '稍后发送（手动）' : '发送'}>
                  <Send size={13} />
                </button>
                <button type="button" onClick={() => setQueuedMessages(previous => previous.filter(queued => queued.id !== item.id))} aria-label="取消待发送消息" title="取消">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="queued-message-clear" onClick={() => setQueuedMessages([])}>清空队列</button>
        </div>
      )}
      <div className="input-row">
        {inputVariant === 'cli' && <span className="cli-prefix">❯</span>}
        {inputVariant !== 'cli' && !split && !externalAttach && (
          <button className="input-btn attach" onClick={attachFile}
            title={attachImageUnsupported ? '当前 Agent 不支持图片（文本附件可用）(Ctrl+O)' : 'Attach file (Ctrl+O)'}>
            <Paperclip size={16} />
          </button>
        )}
        <textarea ref={textareaRef} className="input-textarea" value={value}
          onChange={e => {
            setValue(e.target.value)
            setCmdIdx(0)
            if (historyIndex >= 0) setHistoryIndex(-1)
          }}
          onKeyDown={onKey}
          aria-describedby={ariaDescribedBy}
          placeholder={showPlaceholder ? (inputVariant === 'cli' ? '' : inputVariant === 'command' ? '/ 命令或消息…' : '输入消息...（Enter 发送，Shift+Enter 换行，/ 命令）') : ''}
          rows={1} />
        {inputVariant !== 'cli' && !split && submitButtonMode !== 'hidden' && !externalSend && (
          <button className={`input-btn ${generating ? 'stop' : 'send'}`} onClick={generating ? cancel : send}
            title={generating ? '停止生成 (Esc / Ctrl+C)' : 'Send (Enter)'} aria-label={generating ? '停止生成' : '发送'}>
            {generating ? <Square size={16} /> : <ArrowUp size={18} />}
          </button>
        )}
      </div>
    </div>
  )
})
