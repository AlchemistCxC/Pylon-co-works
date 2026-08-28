import { useState, useRef, KeyboardEvent, useEffect, forwardRef, useImperativeHandle, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { stat } from '@tauri-apps/plugin-fs'
import { useStore } from '../../store'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { useAgentCapabilities } from '../../infrastructure/acp/useAgentCapabilities'
import { createAgentClient } from '../../infrastructure/acp/agentClient'
import { sendMessageWithStream } from './streamingSend.ts'
import { createSessionClient } from '../../infrastructure/acp/sessionClient'
import { resolveAttachGate, resolveAttachFilters } from '../../infrastructure/acp/agentContracts'
import { createAttachment, validateAttachment, MAX_ATTACH_BYTES, type AttachmentItem } from '../../domains/attachment/attachmentItem'
import { resolveFeatureAvailability, availabilityReason } from '../../domains/feature/featureAvailability'
import { reportRuntimeError } from '../../runtimeError'
import { setSessionModel } from './sessionModel'
import { setSessionMode } from './sessionMode'
import { nextSessionMode } from './sessionModeState'
import { runSendTransaction } from './sendTransaction'
import { buildSendMessagePayload } from './sessionRuntime'
import type { Session } from '../../identityStore'

function sendWithStream(options: { session: Session; content: string; persona: string; attachments: string[] }): Promise<unknown> {
  const payload = buildSendMessagePayload(options)
  return sendMessageWithStream(payload)
}
import { resolveSessionSource } from './sessionCommandState'
import { toAgentContextKey } from '../../agentContext'
import { resolveSessionProfile } from './sessionProfile'
import { getChatController } from './chatEventController'
import { stripHiddenUnicode } from '../../utils/unicodeSanitizer'
import { Paperclip, ArrowUp, Square, Pencil, Send, Trash2, Command, CornerDownLeft, MessageSquareText } from 'lucide-react'
import type { AvailableCommand } from '../../infrastructure/acp/chatContracts'
import { resolveCliTextareaLayout, resolveDefaultTextareaHeight } from './inputOverflowState'
import { resolveCommandSuggestions, filterCommandSuggestions, parseSlashCommand, usePluginCommandSuggestions, type CommandSuggestion } from './commandRegistry'
import { runUserMessageBeforeHook } from './hookRuntime'
import { useSessionUiState } from './sessionUiState'
import { useBindingState } from '../../domains/binding/useBindingState'
import { bindingStatusText, isBindingLocked } from '../../domains/binding/bindingState'

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
  const [reconnectPending, setReconnectPending] = useState(false)
  const [attached, setAttached] = useState<AttachmentItem[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [historyLength, setHistoryLength] = useState(0)
  // FE-AUD-020：队列按 session 保存（sessionUiState）——切 Sheet/重挂载不丢，删除 session 清理
  const [queuedMessages, setQueuedMessages] = useSessionUiState<QueuedMessage[]>(sessionId, 'queued-messages', [])
  const lastMsg = useRef('')
  const historyBySourceRef = useRef<Record<string, string[]>>({})
  const historyDraftRef = useRef('')
  // 报告 10.7：IME composition 进行中（Enter 为候选确认键，不发送）
  const composingRef = useRef(false)
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
  // I01-W2：会话运行时读写按 AgentContext（agentId+source）隔离。
  // selector 只返回 store 内对象引用（find 结果，稳定）；派生 context 在渲染内完成——
  // 避免 selector 每次返回新对象触发 useSyncExternalStore forceStoreRerender 循环（#185）
  const foundSession = useIdentityStore(s =>
    sessionId ? s.sessions.find(item => item.id === sessionId || item.source === sessionId) : null,
  )
  const sessionContext = foundSession ? { agentId: foundSession.agentId, source: foundSession.source } : null
  const liveCommands = useRuntimeStore(state => sessionContext
    ? (state.sessionLiveStats[toAgentContextKey(sessionContext)]?.commands ?? EMPTY_COMMANDS)
    : EMPTY_COMMANDS)
  // 当前 session 是否正在生成（用于把发送按钮切成"停止"）
  const generating = useRuntimeStore(s => sessionSource != null && (s.liveGeneratingSources || []).includes(sessionSource))
  // 附件能力（F4-C）：gate 拦截未连接；filters 按 promptImage 降级 accept
  const attachCapabilities = useAgentCapabilities()
  const attachImageUnsupported = attachCapabilities.connected && !attachCapabilities.promptImage
  // G7：availability 统一——未连接/能力未确认时附件与发送按钮 disabled（原因可见）
  const attachAvailability = resolveFeatureAvailability(attachCapabilities.connected ? true : undefined, attachCapabilities.connected)
  const unavailableReason = availabilityReason(attachAvailability)
  // OWNER-03：冷启动 Binding 状态机（§5.9）——Sheet 恢复≠Agent 已连；非 binding_ready
  // 时整个 InputBar 禁用并显示 owner Agent 状态（restore_error 不猜测）。
  const binding = useBindingState(sessionId)
  const bindingLocked = isBindingLocked(binding)
  const bindingMessage = bindingLocked ? bindingStatusText(binding) : ''
  const handleReconnectAgent = async () => {
    if (reconnectPending) return
    setReconnectPending(true)
    try {
      await createAgentClient({
        invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined),
      }).reconnectAgent()
    } catch (error) {
      reportRuntimeError('重连 Agent', error)
    } finally {
      setReconnectPending(false)
    }
  }
  const handleReloadSessionBinding = () => {
    if (!foundSession) return
    setSendError('')
    useRuntimeStore.getState().bumpSessionReload({
      agentId: foundSession.agentId,
      source: foundSession.source,
    })
  }

  useEffect(() => {
    historyDraftRef.current = ''
    setHistoryIndex(-1)
    setHistoryLength(sessionSource ? (historyBySourceRef.current[sessionSource]?.length || 0) : 0)
  }, [sessionSource])

  useEffect(() => {
    setQueuedMessages([])
    // setter 来自 useSessionUiState（useCallback 稳定），切会话清空队列不串 source
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSource])

  const sessionProfile = resolveSessionProfile(sessionId, sessions, profiles)
  const persona = sessionProfile?.persona || ''

  const pluginCommandSuggestions = usePluginCommandSuggestions()
  const COMMANDS = useMemo(
    () => liveCommands.length > 0 ? resolveCommandSuggestions(liveCommands) : pluginCommandSuggestions,
    [liveCommands, pluginCommandSuggestions],
  )

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
          await setSessionModel(sessionContext!, model)
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
          await setSessionMode(sessionContext!, mode)
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
        const beforeHook = await runUserMessageBeforeHook(s, '/compact')
        if (beforeHook.blocked) {
          setSendError(beforeHook.reason || '消息已被会话钩子拦截')
          return false
        }
        return runSendTransaction({
          send: () => sendWithStream({
            session: s,
            content: beforeHook.content,
            persona,
            attachments: attached.filter(file => file.status !== 'error').map(file => file.path),
          }),
          onSuccess: () => {
            recordHistory(beforeHook.content)
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
              await createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).exportSession({ agentId: s.agentId, periId: s.periId, format: 'markdown', outputPath })
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

    // OWNER-04 CR-1：binding 守卫统一收口在 sendText 层——所有发送入口
    // （send / sendQueued / pylon:load-finished 自动 flush）都必须经过。
    // binding_stale 时旧 remote session id 已失效（§5.9 rule 4），禁止继续发送。
    if (bindingLocked) {
      setSendError(bindingMessage || '会话绑定未就绪')
      return false
    }

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
    const source = s.source

    // M3：user.message.before（transform/gate；故障放行）。在排队/乐观渲染前执行，
    // 排队内容使用 transform 后的最终文本。
    const beforeHook = await runUserMessageBeforeHook(s, stripHiddenUnicode(text))
    if (beforeHook.blocked) {
      setSendError(beforeHook.reason || '消息已被会话钩子拦截')
      return false
    }
    const content = beforeHook.content

    // 通用 ACP 未必提供 message/event identity；load 期间默认排队，避免
    // replay/live 无法区分时启动不可安全合并的并发回合。
    if (getChatController()?.isSendBlockedDuringLoad(source)) {
      setQueuedMessages(previous => [...previous, { id: Date.now() + previous.length, text: content, editing: false }])
      setValue('')
      setAttached([])
      setSendError('')
      return true
    }

    // 方案 B（乐观渲染）：发送动作进入 pending 后立即把用户消息 dispatch 到 Chat
    // runtime 并清空输入——不等 `send_message` 整回合返回（最长 300s）。后端
    // `pylon:user` 到达时按 clientMsgId 去重确认（见 chatEventController）。
    const clientMsgId = `${source}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const controller = getChatController()
    controller?.sendOptimisticUser(source, content, clientMsgId)
    lastMsg.current = content
    recordHistory(content)
    setValue('')
    setAttached([])
    setSendError('')

    const sendError = await runSendTransaction({
      send: () => sendWithStream({
        session: s,
        content,
        persona,
        attachments: attached.filter(file => file.status !== 'error').map(file => file.path),
      }),
      onSuccess: () => {},
      // 失败保留乐观用户消息（已渲染），错误由后端 pylon:error 或此处可见提示呈现
      onError: error => setSendError(String(error)),
    })
    return sendError
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
    // OWNER-03：binding 未就绪（restoring/restore_error/agent_disconnected）禁止发送
    if (bindingLocked) {
      setSendError(bindingMessage || '会话绑定未就绪')
      return
    }
    const source = sessionSource
    if (!source) return
    if (getChatController()?.isSendBlockedDuringLoad(source)) {
      enqueue(text)
      return
    }
    if (generating) {
      enqueue(text)
      return
    }
    await sendText(text)
  }

  const sendQueued = async (item: QueuedMessage) => {
    // OWNER-04 CR-1：queue 手动发送与 load-finished flush 均受 binding 守卫（sendText 兜底，
    // 此处提前拦截避免乐观 dispatch 副作用）
    if (generating || !item.text.trim() || bindingLocked) return
    const sent = await sendText(item.text.trim())
    if (sent) setQueuedMessages(previous => previous.filter(queued => queued.id !== item.id))
  }
  const queuedMessagesRef = useRef(queuedMessages)
  const sendQueuedRef = useRef(sendQueued)
  queuedMessagesRef.current = queuedMessages
  sendQueuedRef.current = sendQueued

  useEffect(() => {
    const onLoadFinished = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail
      if (!sessionSource || detail?.source !== sessionSource) return
      const next = queuedMessagesRef.current[0]
      if (next) void sendQueuedRef.current(next)
    }
    window.addEventListener('pylon:load-finished', onLoadFinished)
    return () => window.removeEventListener('pylon:load-finished', onLoadFinished)
  }, [sessionSource])

  const cancel = async () => {
    if (!sessionId || !sessionSource) return
    // 统一取消入口：与 Footer 停止按钮同路径（controller.requestCancel →
    // reducer begin-cancel 去重 → invoke → cancel-success/rejected 收敛）
    getChatController()?.requestCancel(sessionSource)
  }

  const attachFile = async () => {
    // OWNER-03：binding 未就绪（restoring/restore_error/agent_disconnected）禁止附件
    if (bindingLocked) {
      reportRuntimeError('打开附件选择器', bindingMessage || '会话绑定未就绪')
      return
    }
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
      // ISSUE-15 W4：读文件大小传入 sizeBytes，maxBytes 走附件域单一 contract
      let sizeBytes: number | undefined
      try {
        sizeBytes = (await stat(path)).size
      } catch { /* stat 失败时跳过大小校验（不阻断已有流程） */ }
      // FE-AUD-019：选择后校验（重复/未知类型/超限）——error 附件保留并显示原因
      const item = createAttachment(path, name, sizeBytes)
      const validation = validateAttachment(item, { existingPaths: new Set(attached.map(file => file.path)), maxBytes: MAX_ATTACH_BYTES })
      setAttached(prev => [...prev, validation.ok ? { ...item, status: 'ready' } : { ...item, status: 'error', error: validation.error }])
    } catch { /* cancelled */ }
  }

  // deps 必须覆盖 send 引用的 generating 与 sendText 引用的 persona，否则外部 ref.send()
  // 在生成状态翻转瞬间使用过期闭包（enqueue 与直接发送二选一错位）。
  // send/cancel 是稳定 useCallback，无需入 deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({ send, attachFile, cancel }), [value, attached, sessionId, sessionSource, isCmd, filtered, generating, persona, attachCapabilities, bindingLocked, bindingMessage])

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
      const currentMode = sessionContext
        ? useRuntimeStore.getState().sessionModes[toAgentContextKey(sessionContext)] || 'default'
        : 'default'
      setSessionMode(sessionContext!, nextSessionMode(currentMode)).catch(error => setSendError(String(error)))
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
    // 报告 10.7：IME composition 期间 Enter 不发送（输入法候选确认键）
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) { e.preventDefault(); send() }
  }

  return (
    <div className={`input-bar input-variant-${inputVariant} ${inputVariant === 'cli' ? 'cli-mode' : ''} cli-overflow-${cliOverflowMode}`}>
      {inputVariant !== 'cli' && (
        <div className="input-composer-meta" aria-hidden="true">
          <span className="input-composer-kind">
            {inputVariant === 'command' ? <Command size={12} /> : <MessageSquareText size={12} />}
            {inputVariant === 'command' ? '命令与消息' : '新消息'}
          </span>
          <span className="input-composer-shortcut"><CornerDownLeft size={11} /> Enter 发送 · Shift+Enter 换行</span>
        </div>
      )}
      {sendError && <div className="input-error">{sendError}</div>}
      {bindingLocked && bindingMessage && !sendError && (
        <div className={`input-binding-status${binding.kind === 'restore_error' ? ' input-binding-status--error' : ''}`} role="status" aria-live="polite">
          {bindingMessage}
          {binding.kind === 'agent_disconnected' && (
            <button type="button" className="input-reconnect-btn" onClick={handleReconnectAgent} disabled={reconnectPending}>
              {reconnectPending ? '重连中…' : '重连'}
            </button>
          )}
          {(binding.kind === 'binding_detached' || binding.kind === 'binding_stale') && (
            <button type="button" className="input-reconnect-btn" onClick={handleReloadSessionBinding}>
              重新连接会话
            </button>
          )}
        </div>
      )}
      {attached.length > 0 && (
        <div className="attached-files">
          {attached.map((f, i) => (
            <span key={i} className="attached-chip" onClick={() => setAttached(prev => prev.filter((_, j) => j !== i))}>
              📎 {f.name} ✕
              {f.status === 'error' && f.error && (
                <span className="attach-error" role="alert" title={f.error}>{f.error}</span>
              )}
            </span>
          ))}
        </div>
      )}
      {isCmd && filtered.length > 0 && (
        <div className="command-palette">
          {filtered.map((c: CommandSuggestion, i: number) => (
            <button type="button" key={c.cmd} className={`cmd-item ${i === cmdIdx ? 'active' : ''}`}
              aria-current={i === cmdIdx ? 'true' : undefined}
              aria-label={`${c.cmd}${c.args}: ${c.info}`}
              onClick={() => { setValue(c.cmd + c.args + ' '); textareaRef.current?.focus() }}>
              <span className="cmd-name">{c.cmd}{c.args}</span>
              <span className="cmd-info">{c.info}</span>
            </button>
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
                <button type="button" onClick={() => sendQueued(item)} disabled={generating || !item.text.trim() || bindingLocked} aria-label="发送待发送消息" title={generating ? '稍后发送（手动）' : (bindingLocked ? (bindingMessage || '会话绑定未就绪') : '发送')}>
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
          <button className="input-btn attach" onClick={attachFile} disabled={bindingLocked || attachAvailability !== 'available'}
            title={bindingLocked ? (bindingMessage || '会话绑定未就绪') : (attachAvailability !== 'available' ? (unavailableReason ?? '附件暂不可用') : (attachImageUnsupported ? '当前 Agent 不支持图片（文本附件可用）(Ctrl+O)' : 'Attach file (Ctrl+O)'))}>
            <Paperclip size={16} />
          </button>
        )}
        <textarea ref={textareaRef} className="input-textarea" value={value} disabled={bindingLocked}
          onChange={e => {
            setValue(e.target.value)
            setCmdIdx(0)
            if (historyIndex >= 0) setHistoryIndex(-1)
          }}
          onKeyDown={onKey}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          aria-describedby={ariaDescribedBy}
          placeholder={showPlaceholder ? (inputVariant === 'cli' ? '' : inputVariant === 'command' ? '/ 命令或消息…' : '输入消息...（Enter 发送，Shift+Enter 换行，/ 命令）') : ''}
          rows={1} />
        {inputVariant !== 'cli' && !split && submitButtonMode !== 'hidden' && !externalSend && (
          <button className={`input-btn ${generating ? 'stop' : 'send'}`} onClick={generating ? cancel : send}
            disabled={!generating && (bindingLocked || attachAvailability !== 'available')}
            title={generating ? '停止生成 (Esc / Ctrl+C)' : (bindingLocked ? (bindingMessage || '会话绑定未就绪') : (attachAvailability !== 'available' ? (unavailableReason ?? 'Agent 不可用') : 'Send (Enter)'))} aria-label={generating ? '停止生成' : '发送'}>
            {generating ? <Square size={16} /> : <ArrowUp size={18} />}
          </button>
        )}
      </div>
    </div>
  )
})
