import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
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

export interface QueuedWorkbenchMessage {
  id: number
  text: string
  editing: boolean
}

export interface SolidInputBarProps {
  externalSend?: boolean
  externalAttach?: boolean
}

export function SolidInputBar(props: SolidInputBarProps) {
  const workbench = useSolidWorkbench()
  const sessionId = () => workbench.input().sessionId
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const [draft, setDraft] = createSessionUiSignal(workbench.sessionUi, sessionId, 'draft', '')
  const [queue, setQueue] = createSessionUiSignal<QueuedWorkbenchMessage[]>(workbench.sessionUi, sessionId, 'queued-messages', [])
  const [history, setHistory] = createSessionUiSignal<string[]>(workbench.sessionUi, sessionId, 'input-history', [])
  const [historyIndex, setHistoryIndex] = createSessionUiSignal(workbench.sessionUi, sessionId, 'input-history-index', -1)
  const [attachments, setAttachments] = createSignal<readonly WorkbenchAttachment[]>([])
  const [sendError, setSendError] = createSignal('')
  const [commandIndex, setCommandIndex] = createSignal(0)
  let textarea: HTMLTextAreaElement | undefined
  let composing = false
  let historyDraft = ''
  let nextQueueId = 1

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
  const inputVariant = () => appearance().inputVariant || (appearance().inputMode === 'cli' ? 'cli' : 'composer')
  const externalSubmit = () => appearance().inputSubmitButtonMode === 'external'
  const inlineSubmit = () => appearance().inputSubmitButtonMode !== 'hidden' && !externalSubmit() && !props.externalSend
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
    window.addEventListener('pylon:solid-input-send', sendFromWidget)
    window.addEventListener('pylon:solid-input-attach', attachFromWidget)
    onCleanup(() => {
      unsubscribeCommands()
      window.removeEventListener('pylon:solid-input-send', sendFromWidget)
      window.removeEventListener('pylon:solid-input-attach', attachFromWidget)
    })
  })

  const recordHistory = (text: string) => {
    const next = [...history().filter(item => item !== text), text].slice(-50)
    setHistory(next)
    setHistoryIndex(-1)
    historyDraft = ''
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

  const sendText = async (text: string): Promise<boolean> => {
    const id = sessionId()
    const normalized = text.trim()
    if (!id || !normalized) return false
    try {
      const handled = normalized.startsWith('/') && suggestionList().length > 0
        ? await runSlashCommand(normalized)
        : false
      if (!handled) {
        const result = await workbench.commands.send(id, {
          text: normalized,
          attachments: attachments(),
        })
        if (result.status === 'rejected') throw new Error(result.error || '发送失败')
      }
      recordHistory(normalized)
      setDraft('')
      setAttachments([])
      setSendError('')
      setCommandIndex(0)
      return true
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  const enqueue = (text: string) => {
    const normalized = text.trim()
    if (!normalized) return
    setQueue(previous => [...previous, { id: nextQueueId++, text: normalized, editing: false }])
    setDraft('')
    setAttachments([])
    setSendError('')
  }

  const send = async () => {
    if (runtime().generating) {
      enqueue(draft())
      return
    }
    await sendText(draft())
  }

  const cancel = async () => {
    const id = sessionId()
    if (!id) return
    const result = await workbench.commands.cancel(id)
    if (result.status === 'rejected') setSendError(result.error || '取消失败')
  }

  const attach = async () => {
    const id = sessionId()
    if (!id) return
    try {
      const selected = await workbench.commands.attach(id)
      setAttachments(previous => {
        const seen = new Set(previous.map(item => item.path))
        const additions = selected.filter(item => {
          if (seen.has(item.path)) return false
          seen.add(item.path)
          return true
        })
        return [...previous, ...additions]
      })
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
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
      if (event.key === 'Tab' || event.key === 'ArrowDown') {
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
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      browseHistory(event.key === 'ArrowUp' ? 'up' : 'down')
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
    setDraft(`${suggestion.cmd}${suggestion.args} `)
    setCommandIndex(0)
    textarea?.focus()
  }

  return (
    <div
      class={`input-bar input-variant-${inputVariant()}${inputVariant() === 'cli' ? ' cli-mode' : ''} cli-overflow-${appearance().cliOverflowMode}`}
      data-expanded="false"
    >
      <Show when={inputVariant() !== 'cli'}>
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
      <Show when={suggestionList().length > 0}>
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
      <Show when={appearance().inputShowHistoryHint && historyIndex() >= 0 && history().length > 0}>
        <div class="input-history-hint" aria-live="polite">
          历史记录 {historyIndex() + 1}/{history().length} · ↑/↓ 浏览 · Esc 返回草稿
        </div>
      </Show>
      <Show when={queue().length > 0}>
        <div class="queued-message-list" aria-label="待发送消息">
          <div class="queued-message-title">待发送 · {queue().length}</div>
          <For each={queue()}>{item => (
            <div class="queued-message" data-queue-id={item.id}>
              <Show when={item.editing} fallback={<span class="queued-message-text">{item.text}</span>}>
                <textarea
                  class="queued-message-editor"
                  value={item.text}
                  onInput={event => setQueue(previous => previous.map(current => current.id === item.id
                    ? { ...current, text: event.currentTarget.value }
                    : current))}
                  aria-label="编辑待发送消息"
                />
              </Show>
              <div class="queued-message-actions">
                <button type="button" onClick={() => setQueue(previous => previous.map(current => current.id === item.id ? { ...current, editing: !current.editing } : current))} aria-label="编辑待发送消息">编辑</button>
                <button type="button" disabled={runtime().generating || !item.text.trim()} onClick={() => void sendText(item.text).then(sent => {
                  if (sent) setQueue(previous => previous.filter(current => current.id !== item.id))
                })} aria-label="发送待发送消息">发送</button>
                <button type="button" onClick={() => setQueue(previous => previous.filter(current => current.id !== item.id))} aria-label="取消待发送消息">取消</button>
              </div>
            </div>
          )}</For>
          <button type="button" class="queued-message-clear" onClick={() => setQueue([])}>清空队列</button>
        </div>
      </Show>
      <div class="input-row">
        <Show when={inputVariant() === 'cli'}><span class="cli-prefix">❯</span></Show>
        <Show when={inputVariant() !== 'cli' && !props.externalAttach}>
          <button type="button" class="input-btn attach" onClick={() => void attach()} aria-label="添加附件">＋</button>
        </Show>
        <textarea
          ref={textarea}
          class="input-textarea"
          value={draft()}
          onInput={event => {
            setDraft(event.currentTarget.value)
            setCommandIndex(0)
            if (historyIndex() >= 0) setHistoryIndex(-1)
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing = true }}
          onCompositionEnd={() => { composing = false }}
          placeholder={placeholder()}
          rows={1}
        />
        <Show when={inputVariant() !== 'cli' && inlineSubmit()}>
          <button
            type="button"
            class={`input-btn ${runtime().generating ? 'stop' : 'send'}`}
            onClick={() => void (runtime().generating ? cancel() : send())}
            aria-label={runtime().generating ? '停止生成' : '发送消息'}
          >
            {runtime().generating ? '■' : '↑'}
          </button>
        </Show>
      </div>
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
