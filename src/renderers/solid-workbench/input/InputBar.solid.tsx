import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor, type JSX } from 'solid-js'
import {
  resolveFallbackCommands,
  filterCommandSuggestions,
  parseSlashCommand,
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
  externalSend?: boolean
  externalAttach?: boolean
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
  let composing = false
  let historyDraft = ''
  let autoQueueSessionId: string | null | undefined
  let autoQueueArmed = false
  let fileInput: HTMLInputElement | undefined
  const emptyState = () => typeof props.empty === 'function' ? props.empty() : props.empty
  const isDisabled = () => Boolean(props.disabled || emptyState()?.submitting?.())

  const [commandRevision, setCommandRevision] = createSignal(0)
  const suggestions = createMemo(() => {
    commandRevision()
    const sessionCommands = runtime().document?.session?.commands ?? []
    const source = sessionCommands.length > 0
      ? sessionCommandSuggestions(sessionCommands)
      : resolveFallbackCommands()
    return filterCommandSuggestions(draft(), source)
  })
  const suggestionList = () => suggestions() ?? []
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
  // 与 React 中控一致：external 表示布局偏好；只有对应外置 send 实际可见时，
  // ControlCenter 才传 externalSend=true。外置 send 被隐藏时必须恢复内置发送按钮。
  const inlineSubmit = () => appearance().inputSubmitButtonMode !== 'hidden' && !props.externalSend
  const placeholder = () => {
    if (!appearance().inputShowPlaceholder) return ''
    if (inputVariant() === 'cli') return ''
    if (inputVariant() === 'command') return '/ 命令或消息…'
    return '输入消息...（Enter 发送，Shift+Enter 换行，/ 命令）'
  }

  onMount(() => {
    textarea?.focus()
    const unsubscribeCommands = subscribePluginCommands(() => setCommandRevision(value => value + 1))
    const sendFromWidget = () => void send()
    const attachFromWidget = () => void attach()
    const resetEmptyDraft = () => {
      if (!emptyState()) return
      setDraft('')
      setAttachments([])
      setSendError('')
      queueMicrotask(() => textarea?.focus())
    }
    window.addEventListener('pylon:solid-input-send', sendFromWidget)
    window.addEventListener('pylon:solid-input-attach', attachFromWidget)
    window.addEventListener('pylon:new-session', resetEmptyDraft)
    onCleanup(() => {
      unsubscribeCommands()
      window.removeEventListener('pylon:solid-input-send', sendFromWidget)
      window.removeEventListener('pylon:solid-input-attach', attachFromWidget)
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

  const attach = async () => {
    if (isDisabled()) return
    const id = sessionId()
    if (!id) {
      fileInput?.click()
      return
    }
    const ui = workbench.sessionUi.capture(id)
    try {
      const selected = await workbench.commands.attach(id)
      ui.update<readonly WorkbenchAttachment[]>('attachments', [], previous => {
        const seen = new Set(previous.map(item => item.path))
        const additions = selected.filter(item => {
          if (seen.has(item.path)) return false
          seen.add(item.path)
          return true
        })
        return [...previous, ...additions]
      })
    } catch (error) {
      ui.set('input-error', error instanceof Error ? error.message : String(error))
    }
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
    if (suggestionList().length > 0) {
      if (event.key === 'Enter' && !event.shiftKey && !composing) {
        const suggestion = suggestionList()[commandIndex()]
        const parsed = parseSlashCommand(draft())
        if (suggestion && parsed?.name.toLowerCase() !== suggestion.cmd.toLowerCase()) {
          event.preventDefault()
          applySuggestion(suggestion)
          return
        }
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        const suggestion = suggestionList()[commandIndex()]
        if (suggestion) applySuggestion(suggestion)
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCommandIndex(index => (index + 1) % suggestionList().length)
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

  const applySuggestion = (suggestion: CommandSuggestion) => {
    const args = suggestion.args.trim()
    setDraft(`${suggestion.cmd}${args ? ` ${args}` : ''} `)
    setCommandIndex(0)
    textarea?.focus()
  }

  return (
    <div
      class={`input-bar input-variant-${inputVariant()}${inputVariant() === 'cli' ? ' cli-mode' : ''} cli-overflow-${appearance().cliOverflowMode}${emptyState() ? ' input-empty' : ''}`}
      data-expanded="false"
    >
      {/* Empty state is intentionally quiet: the control-center itself already
          communicates the affordance, so keyboard-hint chrome would make the
          centered composer look like a second instruction panel. */}
      <Show when={inputVariant() !== 'cli' && !emptyState()}>
        <div class="input-composer-meta" aria-hidden="true">
          <span class="input-composer-kind"><span class="input-composer-glyph">{inputVariant() === 'command' ? '⌘' : '✦'}</span>{inputVariant() === 'command' ? '命令与消息' : '新消息'}</span>
          <span class="input-composer-shortcut">↵ Enter 发送 · Shift+Enter 换行</span>
        </div>
      </Show>
      <Show when={sendError()}>{error => <div class="input-error" role="alert">{error()}</div>}</Show>
      <Show when={attachments().length > 0}>
        <div class="attached-files" aria-label="附件">
          <For each={attachments()}>{item => (
            <button
              type="button"
              class="attached-chip"
              onClick={() => setAttachments(previous => previous.filter(current => current.id !== item.id))}
              aria-label={`移除附件 ${item.name || item.path}`}
            >
              {item.name || item.path} ×
            </button>
          )}</For>
        </div>
      </Show>
      <Show when={!emptyState() && suggestionList().length > 0}>
        <div class="command-palette" role="listbox" aria-label="命令建议">
          <For each={suggestionList()}>{(suggestion, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index() === commandIndex()}
              class={`cmd-item${index() === commandIndex() ? ' active' : ''}`}
              onClick={() => applySuggestion(suggestion)}
            >
              <span class="cmd-name">{suggestion.cmd}{suggestion.args}</span>
              <span class="cmd-info">{suggestion.info}</span>
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
        <Show when={(inputVariant() !== 'cli' || Boolean(emptyState())) && !props.externalAttach}>
          <button type="button" class="input-btn attach" disabled={isDisabled()} onClick={() => void attach()} aria-label="添加附件">＋</button>
        </Show>
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
            }}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composing = true }}
            onCompositionEnd={() => { composing = false }}
            placeholder={prediction() && !emptyState() ? '' : (emptyState() ? '描述你想让 Agent 完成什么…' : placeholder())}
            rows={1}
            disabled={isDisabled()}
          />
        </div>
        <Show when={inputVariant() !== 'cli' && inlineSubmit()}>
          <button
            type="button"
            disabled={isDisabled()}
            class={`input-btn ${runtime().generating ? 'stop' : 'send'}`}
            onClick={() => void (runtime().generating ? cancel() : send())}
            aria-label={runtime().generating ? '停止生成' : '发送消息'}
          >
            {runtime().generating ? '■' : '↑'}
          </button>
        </Show>
      </div>
      <Show when={emptyState()?.after}>{content => <div class="input-empty-after">{content()}</div>}</Show>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={event => {
          const files = event.currentTarget.files
          if (files) setAttachments(items => [...items, ...Array.from(files).map(file => ({
            id: `${file.name}:${file.size}:${file.lastModified}`,
            name: file.name,
            path: (file as File & { path?: string }).path || file.name,
            mediaType: file.type || undefined,
          }))])
          event.currentTarget.value = ''
        }}
      />
    </div>
  )
}

function sessionCommandSuggestions(commands: readonly SessionCommand[]): readonly CommandSuggestion[] {
  return commands
    .filter(command => command.availability !== false && command.availability !== 'unavailable')
    .map(command => ({
      cmd: command.name.startsWith('/') ? command.name : `/${command.name}`,
      args: command.inputHint ?? '',
      info: command.description ?? command.capability ?? '会话命令',
    }))
}

function sameAttachments(left: readonly WorkbenchAttachment[], right: readonly WorkbenchAttachment[]): boolean {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id && item.path === right[index]?.path)
}
