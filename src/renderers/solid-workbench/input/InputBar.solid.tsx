import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor, type JSX } from 'solid-js'
import {
  resolveFallbackCommands,
  filterCommandSuggestions,
  parseSlashCommand,
  decorateSuggestions,
  selectUserTier,
  type CommandSuggestion,
} from '../../../components/chat/commandRegistry.ts'
import { subscribePluginCommands } from '../../../host/commandSetResolver.ts'
import type { WorkbenchAttachment } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { createSessionUiSignal } from '../adapters/sessionUiSignal.solid.tsx'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import type { SessionCommand } from '../../../domains/workbench/session/sessionSurface.ts'
import { findHistoryCompletion, mergeHistory, type PredictionCandidate } from './inputPredictionState.ts'
import { createPredictionScheduler, type InputPredictionProvider } from './inputPredictionProvider.ts'
import { loadInputPredictionSettings } from '../../../domains/inputPrediction/inputPredictionSettings.ts'

export interface QueuedWorkbenchMessage {
  id: number
  text: string
  editing: boolean
  attachments?: readonly WorkbenchAttachment[]
}

export interface SolidInputBarProps {
  disabled?: boolean
  /** Optional LLM provider; requests are debounced, cancellable and rate limited. */
  predictionProvider?: InputPredictionProvider
  /** Empty-state configuration. The input DOM stays mounted while a session is created. */
  empty?: {
    before?: JSX.Element
    after?: JSX.Element
    onSubmit: (text: string, attachments: readonly WorkbenchAttachment[]) => Promise<boolean>
    submitting?: Accessor<boolean>
    submitLabel?: Accessor<string>
  } | (() => {
    before?: JSX.Element
    after?: JSX.Element
    onSubmit: (text: string, attachments: readonly WorkbenchAttachment[]) => Promise<boolean>
    submitting?: Accessor<boolean>
    submitLabel?: Accessor<string>
  } | undefined)
}

/** 命令面板的一行：命令项，或「全部/常用」分层切换项（切换项进环选，键盘可达）。 */
type PaletteRow =
  | { kind: 'command'; key: string; suggestion: CommandSuggestion }
  | { kind: 'toggle'; key: string }

export function SolidInputBar(props: SolidInputBarProps) {
  const workbench = useSolidWorkbench()
  const sessionId = () => workbench.input().sessionId
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const [draft, setDraft] = createSessionUiSignal(workbench.sessionUi, sessionId, 'draft', '')
  const [queue, setQueue] = createSessionUiSignal<QueuedWorkbenchMessage[]>(workbench.sessionUi, sessionId, 'queued-messages', [])
  const [history] = createSessionUiSignal<string[]>(workbench.sessionUi, sessionId, 'input-history', [])
  const [historyIndex, setHistoryIndex] = createSessionUiSignal(workbench.sessionUi, sessionId, 'input-history-index', -1)
  const [attachments, setAttachments] = createSessionUiSignal<readonly WorkbenchAttachment[]>(workbench.sessionUi, sessionId, 'attachments', [])
  const [sendError, setSendError] = createSessionUiSignal(workbench.sessionUi, sessionId, 'input-error', '')
  const [commandIndex, setCommandIndex] = createSignal(0)
  const [queueSendingSessions, setQueueSendingSessions] = createSignal<ReadonlySet<string>>(new Set())
  const [dismissedPrediction, setDismissedPrediction] = createSignal<string | null>(null)
  const [providerPrediction, setProviderPrediction] = createSignal<string | null>(null)
  const predictionScheduler = props.predictionProvider ? createPredictionScheduler(props.predictionProvider) : null
  let textarea: HTMLTextAreaElement | undefined
  let inputBar: HTMLDivElement | undefined
  let composing = false
  let historyDraft = ''
  let autoQueueSessionId: string | null | undefined
  let autoQueueArmed = false
  const emptyState = () => typeof props.empty === 'function' ? props.empty() : props.empty
  const isDisabled = () => Boolean(props.disabled || emptyState()?.submitting?.())

  const resizeInput = () => {
    if (!textarea) return
    const slot = textarea.closest<HTMLElement>('.cc-input-slot')
    if (!slot) return
    const styles = getComputedStyle(slot)
    const staticHeight = Number.parseFloat(styles.getPropertyValue('--cc-input-height')) || textarea.clientHeight || 40
    const controlCenter = slot.closest<HTMLElement>('.control-center')
    if (inputBar?.classList.contains('cli-mode')) {
      slot.style.height = ''
      controlCenter?.style.removeProperty('--cc-input-extra-height')
      textarea.style.height = ''
      textarea.style.maxHeight = ''
      textarea.style.overflowY = ''
      inputBar.dataset.expanded = 'false'
      return
    }
    const maxHeight = staticHeight * 3
    textarea.style.height = 'auto'
    const contentHeight = Math.max(textarea.scrollHeight, staticHeight)
    const nextHeight = Math.min(maxHeight, Math.max(staticHeight, contentHeight))
    slot.style.height = `${nextHeight}px`
    const extraHeight = nextHeight - staticHeight
    if (extraHeight > 0) controlCenter?.style.setProperty('--cc-input-extra-height', `${extraHeight}px`)
    else controlCenter?.style.removeProperty('--cc-input-extra-height')
    textarea.style.height = '100%'
    textarea.style.maxHeight = `${maxHeight}px`
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'
    if (inputBar) inputBar.dataset.expanded = String(nextHeight > staticHeight)
  }

  createEffect(() => {
    const inputHeight = appearance().inputHeight
    const inputFontSize = appearance().inputFontSize
    const inputLineHeight = appearance().inputLineHeight
    const currentDraft = draft()
    void inputHeight
    void inputFontSize
    void inputLineHeight
    void currentDraft
    queueMicrotask(resizeInput)
  })
  onMount(() => queueMicrotask(resizeInput))

  const [commandRevision, setCommandRevision] = createSignal(0)
  const [showAllCommands, setShowAllCommands] = createSignal(false)
  const suggestions = createMemo(() => {
    commandRevision()
    const sessionCommands = runtime().document?.session?.commands ?? []
    const source = sessionCommands.length > 0
      ? sessionCommandSuggestions(sessionCommands)
      : resolveFallbackCommands()
    return filterCommandSuggestions(draft(), source)
  })
  const userSuggestions = createMemo(() => selectUserTier(suggestions()))
  /** #329 分层：默认只列 user 级；内部/开发者命令折叠在「全部」里。
   *  **不做「user 层没命中就放行全量」的例外**——那个条件太宽（敲 `/s` 就会漏出 11 条
   *  skin 命令，正是本 issue 要治的「内部命令淹没日常命令」）。用户要找内部命令时，
   *  面板底部的切换项就在环选里，一格键的距离。 */
  const suggestionList = createMemo(() => showAllCommands() ? suggestions() : userSuggestions())
  /** 「全部」里比默认层多出来的条数——按**实际隐藏量**算，不按命中量算：
   *  否则默认层为空的查询会报出「含内部 N 条」但一条也没藏（#329 审查 P2）。 */
  const hiddenInternalCount = createMemo(() => suggestions().length - suggestionList().length)
  /** 面板行 = 命令项 + 一个「全部/常用」切换项（进环选，键盘可达）。 */
  const paletteRows = createMemo<PaletteRow[]>(() => {
    const rows: PaletteRow[] = suggestionList().map(suggestion => ({ kind: 'command', key: `cmd:${suggestion.cmd}`, suggestion }))
    if (hiddenInternalCount() > 0 || showAllCommands()) rows.push({ kind: 'toggle', key: 'toggle-layer' })
    return rows
  })
  const toggleCommandLayer = () => {
    setShowAllCommands(current => !current)
    setCommandIndex(0)
  }
  // 展开状态跟着这一次 `/` 输入走：草稿不再是斜杠命令就收回（否则展开会粘到整个应用
  // 会话，「只看常用命令」的控件也随面板一起消失，用户再也收不回来）。
  createEffect(() => {
    if (!draft().trimStart().startsWith('/')) setShowAllCommands(false)
  })
  // 展开后列表可能高于面板：键盘选中的行必须可见（否则是「选中了但看不见」）。
  createEffect(() => {
    const index = commandIndex()
    if (!draft().trimStart().startsWith('/')) return
    const rows = inputBar?.querySelectorAll('.command-palette .cmd-item')
    rows?.[index]?.scrollIntoView({ block: 'nearest' })
  })
  // 列表长度会随查询/分层切换变化：索引越界会让「回车」落到面板外（被当成普通消息发出）。
  createEffect(() => {
    if (commandIndex() >= paletteRows().length) setCommandIndex(0)
  })
  const durableHistory = createMemo(() => {
    const document = runtime().document
    if (!document || document.sessionId !== sessionId()) return [] as readonly string[]
    return document.messages
      .filter(message => message.role === 'user')
      .map(message => message.content)
      .filter((value): value is string => typeof value === 'string')
  })
  const durableMessages = createMemo(() => {
    const document = runtime().document
    if (!document || document.sessionId !== sessionId()) return [] as readonly { role: 'user' | 'assistant'; content: string }[]
    return document.messages
      .filter(message => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
      .map(message => ({ role: message.role as 'user' | 'assistant', content: message.content as string }))
  })
  const prediction = createMemo<PredictionCandidate | null>(() => {
    const value = draft()
    if (suggestionList().length > 0 || runtime().generating || attachments().length > 0) return null
    const historyCompletion = findHistoryCompletion(value, mergeHistory(durableHistory(), history()))
    if (historyCompletion) {
      const key = `history:${value}:${historyCompletion}`
      return dismissedPrediction() === key ? null : { text: historyCompletion, source: 'history' }
    }
    if (value) return null
    const predictionMode = loadInputPredictionSettings().mode
    if (predictionMode === 'off') return null
    const llm = predictionMode === 'standalone' ? undefined : runtime().document?.sessionId === sessionId()
      ? runtime().document?.assist.prediction?.placeholder?.trim()
      : undefined
    const valueFromProvider = llm || providerPrediction()
    if (!valueFromProvider) return null
    const key = `llm:${valueFromProvider}`
    return dismissedPrediction() === key ? null : { text: valueFromProvider, source: 'llm' }
  })
  createEffect(() => {
    const scheduler = predictionScheduler
    const id = sessionId()
    const value = draft()
    const generating = runtime().generating
    const hasCommands = suggestionList().length > 0
    const hasAttachments = attachments().length > 0
    if (!scheduler || !id || value || generating || hasCommands || hasAttachments) {
      scheduler?.cancel()
      setProviderPrediction(null)
      return
    }
    const generation = runtime().generation
    const historyValues = mergeHistory(durableHistory(), history())
    const messages = durableMessages()
    setProviderPrediction(null)
    scheduler.schedule({ sessionId: id, generation, draft: value, history: historyValues, messages }, result => {
      if (sessionId() !== id || runtime().generation !== generation || draft() !== '') return
      const normalized = result?.trim()
      setProviderPrediction(normalized || null)
    })
  })
  onCleanup(() => predictionScheduler?.dispose())
  const inputVariant = () => appearance().inputVariant || (appearance().inputMode === 'cli' ? 'cli' : 'composer')
  // Placeholder copy is deferred to the send/indicator work; keep the
  // textarea free of a standalone instruction line.
  const placeholder = () => ''

  onMount(() => {
    textarea?.focus()
    const unsubscribeCommands = subscribePluginCommands(() => setCommandRevision(value => value + 1))
    const sendFromWidget = () => void send()
    const resetEmptyDraft = () => {
      if (!emptyState()) return
      setDraft('')
      setAttachments([])
      setSendError('')
      queueMicrotask(() => textarea?.focus())
    }
    window.addEventListener('pylon:solid-input-send', sendFromWidget)
    window.addEventListener('pylon:new-session', resetEmptyDraft)
    onCleanup(() => {
      unsubscribeCommands()
      window.removeEventListener('pylon:solid-input-send', sendFromWidget)
      window.removeEventListener('pylon:new-session', resetEmptyDraft)
    })
  })

  createEffect(() => {
    const error = sendError()
    const id = sessionId()
    if (!error || !id) return
    // A first-prompt failure can arrive after the empty composer has switched
    // to its session namespace. Restore keyboard focus only if the user is
    // still on that same session and the input is usable.
    queueMicrotask(() => {
      if (id === sessionId() && !isDisabled()) textarea?.focus()
    })
  })

  const recordHistory = (text: string, ui: ReturnType<typeof workbench.sessionUi.capture>) => {
    ui.update<string[]>('input-history', [], previous => [...previous.filter(item => item !== text), text].slice(-50))
    ui.set('input-history-index', -1)
  }

  const runSlashCommand = async (text: string): Promise<boolean> => {
    const parsed = parseSlashCommand(text)
    if (!parsed) return false
    const id = sessionId()
    if (!id) return false
    switch (parsed.name) {
      case '/model': {
        if (!parsed.args.trim()) throw new Error('请输入模型名称')
        const result = await workbench.commands.setModel(id, parsed.args.trim())
        if (!result.ok) throw new Error(result.error || '模型切换失败')
        return true
      }
      case '/mode': {
        if (!parsed.args.trim()) throw new Error('请输入权限模式')
        const result = await workbench.commands.setMode(id, parsed.args.trim())
        if (!result.ok) throw new Error(result.error || '权限模式切换失败')
        return true
      }
      case '/new':
        await workbench.commands.createSession()
        return true
      case '/compact': {
        const result = await workbench.commands.compact(id)
        if (!result.ok) throw new Error(result.error || '压缩失败')
        return true
      }
      case '/export': {
        const result = await workbench.commands.exportSession(id, { format: 'markdown' })
        if (!result.ok) throw new Error(result.error || '导出失败')
        return true
      }
      case '/clear': {
        const result = await workbench.commands.clearSession(id)
        if (!result.ok) throw new Error(result.error || '清屏失败')
        return true
      }
      default:
        return false
    }
  }

  const sendText = async (
    text: string,
    messageAttachments: readonly WorkbenchAttachment[] = attachments(),
    clearComposer = true,
  ): Promise<boolean> => {
    if (isDisabled()) return false
    const id = sessionId()
    const normalized = text.trim()
    if (!normalized) return false
    const wasEmptySession = !id
    if (wasEmptySession && emptyState()) {
      const ok = await emptyState()!.onSubmit(normalized, messageAttachments)
      if (ok && clearComposer) {
        // createSession may select the new session before this continuation
        // resumes. Do not route the empty-state cleanup into the new session's
        // namespace; an async first-prompt failure may need to restore this
        // exact draft for retry.
        if (!wasEmptySession || !sessionId()) {
          setDraft('')
          setAttachments([])
        }
      }
      if (!ok) queueMicrotask(() => textarea?.focus())
      return ok
    }
    if (!id) return false
    const ui = workbench.sessionUi.capture(id)
    const shouldRunSlashCommand = normalized.startsWith('/') && suggestionList().length > 0
    let clearedDraft = false
    let clearedAttachments = false
    if (clearComposer) {
      ui.update('draft', '', current => {
        if (current !== text) return current
        clearedDraft = true
        return ''
      })
      ui.update<readonly WorkbenchAttachment[]>('attachments', [], current => {
        if (!sameAttachments(current, messageAttachments)) return current
        clearedAttachments = true
        return []
      })
    }
    try {
      const handled = shouldRunSlashCommand
        ? await runSlashCommand(normalized)
        : false
      if (!handled) {
        const result = await workbench.commands.send(id, {
          text: normalized,
          attachments: messageAttachments,
        })
        if (result.status === 'rejected') throw new Error(result.error || '发送失败')
      }
      recordHistory(normalized, ui)
      ui.set('input-error', '')
      if (sessionId() === id) setCommandIndex(0)
      return true
    } catch (error) {
      if (clearComposer && clearedDraft && ui.get('draft', '') === '') {
        ui.set('draft', text)
        if (clearedAttachments && ui.get<readonly WorkbenchAttachment[]>('attachments', []).length === 0) {
          ui.set('attachments', messageAttachments)
        }
      }
      ui.set('input-error', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  const enqueue = (text: string) => {
    const normalized = text.trim()
    if (!normalized) return
    const queuedAttachments = attachments()
    setQueue(previous => [...previous, {
      id: Math.max(0, ...previous.map(item => item.id)) + 1,
      text: normalized,
      editing: false,
      attachments: queuedAttachments,
    }])
    setDraft('')
    setAttachments([])
    setSendError('')
  }

  const sendQueued = async (item: QueuedWorkbenchMessage): Promise<boolean> => {
    const id = sessionId()
    if (!id) return false
    if (queueSendingSessions().has(id)) return false
    setQueueSendingSessions(previous => new Set([...previous, id]))
    const ui = workbench.sessionUi.capture(id)
    try {
      if (await sendText(item.text, item.attachments ?? [], false)) {
        ui.update<QueuedWorkbenchMessage[]>('queued-messages', [], previous => previous.filter(current => current.id !== item.id))
        return true
      }
      return false
    } finally {
      setQueueSendingSessions(previous => new Set([...previous].filter(session => session !== id)))
    }
  }

  createEffect(() => {
    const id = sessionId()
    const generating = runtime().generating
    const first = queue()[0]
    const sending = id ? queueSendingSessions().has(id) : false
    if (id !== autoQueueSessionId) {
      autoQueueSessionId = id
      autoQueueArmed = generating || Boolean(first)
    }
    if (generating) {
      autoQueueArmed = true
      return
    }
    if (!id || !autoQueueArmed || sending || !first || first.editing) return
    autoQueueArmed = false
    void sendQueued(first)
  })

  const send = async () => {
    if (isDisabled()) return
    if (emptyState()) {
      await sendText(draft())
      return
    }
    if (runtime().generating) {
      enqueue(draft())
      return
    }
    await sendText(draft())
  }

  const cancel = async () => {
    if (isDisabled()) return
    const id = sessionId()
    if (!id) return
    const ui = workbench.sessionUi.capture(id)
    const result = await workbench.commands.cancel(id)
    if (result.status === 'rejected') ui.set('input-error', result.error || '取消失败')
  }

  const browseHistory = (direction: 'up' | 'down') => {
    const entries = history()
    if (entries.length === 0) return
    if (historyIndex() < 0) historyDraft = draft()
    const next = direction === 'up'
      ? Math.min(historyIndex() + 1, entries.length - 1)
      : Math.max(historyIndex() - 1, -1)
    setHistoryIndex(next)
    setDraft(next < 0 ? historyDraft : entries[entries.length - 1 - next] ?? '')
  }

  const canBrowseHistory = (direction: 'up' | 'down') => {
    if (history().length === 0 || !textarea || textarea.selectionStart !== textarea.selectionEnd) return false
    return direction === 'up'
      ? !textarea.value.slice(0, textarea.selectionStart).includes('\n')
      : !textarea.value.slice(textarea.selectionEnd).includes('\n')
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && runtime().generating) {
      event.preventDefault()
      void cancel()
      return
    }
    if (event.ctrlKey && (event.key === 'c' || event.key === 'C') && runtime().generating && !window.getSelection()?.toString()) {
      event.preventDefault()
      void cancel()
      return
    }
    if (paletteRows().length > 0) {
      if (event.key === 'Enter' && !event.shiftKey && !composing) {
        const row = paletteRows()[commandIndex()]
        if (row?.kind === 'toggle') {
          event.preventDefault()
          toggleCommandLayer()
          return
        }
        const parsed = parseSlashCommand(draft())
        if (row && parsed?.name.toLowerCase() !== row.suggestion.cmd.toLowerCase()) {
          event.preventDefault()
          // 中文名（`/模型 deepseek`）永远走这条补全路径，必须把已输入参数带过去——
          // 否则用户敲的参数会被提示串顶掉，且不可撤销（#327）。
          applySuggestion(row.suggestion, parsed?.args)
          return
        }
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        const row = paletteRows()[commandIndex()]
        if (row?.kind === 'command') applySuggestion(row.suggestion)
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCommandIndex(index => (index + 1) % paletteRows().length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCommandIndex(index => Math.max(index - 1, 0))
        return
      }
    }
    const currentPrediction = prediction()
    const atEnd = !textarea || (textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length)
    if (currentPrediction && (event.key === 'Tab' || (event.key === 'ArrowRight' && atEnd))) {
      event.preventDefault()
      setDraft(currentPrediction.text)
      setDismissedPrediction(null)
      setHistoryIndex(-1)
      textarea?.focus()
      return
    }
    if (currentPrediction && event.key === 'Escape') {
      event.preventDefault()
      setDismissedPrediction(currentPrediction.source === 'history'
        ? `history:${draft()}:${currentPrediction.text}`
        : `llm:${currentPrediction.text}`)
      return
    }
    if (currentPrediction && currentPrediction.source === 'llm'
      && !draft() && event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault()
      setDraft(currentPrediction.text)
      setDismissedPrediction(null)
      void sendText(currentPrediction.text)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const direction = event.key === 'ArrowUp' ? 'up' : 'down'
      if (!canBrowseHistory(direction)) return
      event.preventDefault()
      browseHistory(direction)
      return
    }
    if (event.key === 'Escape' && historyIndex() >= 0) {
      event.preventDefault()
      setHistoryIndex(-1)
      setDraft(historyDraft)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault()
      void send()
    }
  }

  /** `typedArgs` = 用户已输入的参数（如 `/模型 deepseek` 的 `deepseek`）；缺省用提示串。 */
  const applySuggestion = (suggestion: CommandSuggestion, typedArgs?: string) => {
    const args = typedArgs?.trim() || suggestion.args.trim()
    setDraft(`${suggestion.cmd}${args ? ` ${args}` : ''} `)
    setCommandIndex(0)
    textarea?.focus()
  }

  /** 点选/键盘补全共用：把草稿里已输入的参数一并带过去。 */
  const pickSuggestion = (suggestion: CommandSuggestion) => {
    applySuggestion(suggestion, parseSlashCommand(draft())?.args)
  }

  return (
    <div
      ref={inputBar}
      class={`input-bar input-variant-${inputVariant()}${inputVariant() === 'cli' ? ' cli-mode' : ''} cli-overflow-${appearance().cliOverflowMode}${emptyState() ? ' input-empty' : ''}`}
      data-expanded="false"
    >
      {/* Empty state is intentionally quiet: the control-center itself already
          communicates the affordance, so keyboard-hint chrome would make the
          centered composer look like a second instruction panel. */}
      <Show when={sendError()}>{error => <div class="input-error" role="alert">{error()}</div>}</Show>
      <Show when={!emptyState() && paletteRows().length > 0}>
        <div class="command-palette" role="listbox" aria-label="命令建议">
          <For each={paletteRows()}>{(row, index) => (
            row.kind === 'toggle'
              ? <button
                  type="button"
                  role="option"
                  aria-label={showAllCommands() ? '只看常用命令' : `显示全部命令，含内部 ${hiddenInternalCount()} 条`}
                  class={`cmd-item cmd-toggle${index() === commandIndex() ? ' active' : ''}`}
                  onClick={toggleCommandLayer}
                >
                  <span class="cmd-name">{showAllCommands() ? '只看常用命令' : `显示全部命令（含内部 ${hiddenInternalCount()} 条）`}</span>
                </button>
              : <button
                  type="button"
                  role="option"
                  aria-selected={index() === commandIndex()}
                  class={`cmd-item${index() === commandIndex() ? ' active' : ''}`}
                  onClick={() => pickSuggestion(row.suggestion)}
                >
                  <span class="cmd-name">{row.suggestion.cmd}{row.suggestion.args}</span>
                  <span class="cmd-info">{row.suggestion.info}</span>
                </button>
          )}</For>
        </div>
      </Show>
      <Show when={!emptyState() && appearance().inputShowHistoryHint && historyIndex() >= 0 && history().length > 0}>
        <div class="input-history-hint" aria-live="polite">
          历史记录 {historyIndex() + 1}/{history().length} · ↑/↓ 浏览 · Esc 返回草稿
        </div>
      </Show>
      <Show when={!emptyState() && queue().length > 0}>
        <div class="queued-message-list" aria-label="待发送消息">
          <div class="queued-message-title">待发送 · {queue().length}</div>
          <Index each={queue()}>{item => (
            <div class="queued-message" data-queue-id={item().id}>
              <Show when={item().editing} fallback={<span class="queued-message-text">{item().text}</span>}>
                <textarea
                  ref={element => queueMicrotask(() => element.focus())}
                  class="queued-message-editor"
                  value={item().text}
                  onInput={event => setQueue(previous => previous.map(current => current.id === item().id
                    ? { ...current, text: event.currentTarget.value }
                    : current))}
                  onKeyDown={event => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    const editButton = event.currentTarget.closest('.queued-message')
                      ?.querySelector<HTMLButtonElement>('.queued-message-actions button')
                    setQueue(previous => previous.map(current => current.id === item().id
                      ? { ...current, editing: false }
                      : current))
                    queueMicrotask(() => editButton?.focus())
                  }}
                  aria-label="编辑待发送消息"
                />
              </Show>
              <div class="queued-message-actions">
                <button type="button" onClick={() => setQueue(previous => previous.map(current => current.id === item().id ? { ...current, editing: !current.editing } : current))} aria-label={item().editing ? '完成编辑待发送消息' : '编辑待发送消息'}>{item().editing ? '完成' : '编辑'}</button>
                <button type="button" disabled={runtime().generating || item().editing || queueSendingSessions().has(sessionId() ?? '') || !item().text.trim()} onClick={() => void sendQueued(item())} aria-label="发送待发送消息">发送</button>
                <button type="button" onClick={() => setQueue(previous => previous.filter(current => current.id !== item().id))} aria-label="取消待发送消息">取消</button>
              </div>
            </div>
          )}</Index>
          <button type="button" class="queued-message-clear" onClick={() => setQueue([])}>清空队列</button>
        </div>
      </Show>
      <Show when={emptyState()?.before}>{content => <div class="input-empty-before">{content()}</div>}</Show>
      <div class="input-row">
        <Show when={inputVariant() === 'cli'}><span class="cli-prefix">❯</span></Show>
        <div class="input-editor-stack">
          <Show when={prediction()}>{candidate => (
            <div class="input-ghost-suggestion" aria-hidden="true">
              <span class="input-ghost-prefix">{draft()}</span><span>{candidate().text.slice(draft().length)}</span>
            </div>
          )}</Show>
          <textarea
            ref={textarea}
            class="input-textarea"
            aria-label="消息输入"
            value={draft()}
            onInput={event => {
              setDraft(event.currentTarget.value)
              setDismissedPrediction(null)
              setCommandIndex(0)
              if (historyIndex() >= 0) setHistoryIndex(-1)
              resizeInput()
            }}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composing = true }}
            onCompositionEnd={() => { composing = false }}
            placeholder={placeholder()}
            rows={1}
            disabled={isDisabled()}
          />
        </div>
      </div>
      <Show when={emptyState()?.after}>{content => <div class="input-empty-after">{content()}</div>}</Show>
    </div>
  )
}

/** 会话上报命令 → 建议项。宿主注册表里的元数据（检索词 + 可见性档）按命令名并回：
 *  只靠上报字段，中文界面下 `/新` 搜不到英文命令名（#327）、分层也落不了地（#329）。
 *  agent 主动宣告的命令默认按 user 级呈现——那是它要用户用的命令。 */
function sessionCommandSuggestions(commands: readonly SessionCommand[]): readonly CommandSuggestion[] {
  return decorateSuggestions(commands
    .filter(command => command.availability !== false && command.availability !== 'unavailable')
    .map(command => ({
      cmd: command.name.startsWith('/') ? command.name : `/${command.name}`,
      args: command.inputHint ?? '',
      info: command.description ?? command.capability ?? '会话命令',
    })), 'user')
}

function sameAttachments(left: readonly WorkbenchAttachment[], right: readonly WorkbenchAttachment[]): boolean {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id && item.path === right[index]?.path)
}
