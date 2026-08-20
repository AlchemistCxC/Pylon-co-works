import { ErrorBoundary, For, Show, createSignal, onCleanup } from 'solid-js'
import type { RenderMessage } from '../../../components/chat/messageTypes.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../domains/workbench/appearance.ts'
import { MarkdownContent } from './MarkdownContent.solid.tsx'
import { SolidCollapsibleRegion } from './CollapsibleRegion.solid.tsx'

export interface SolidMessageRowProps {
  renderMessage: RenderMessage
  appearance: Pick<WorkbenchAppearanceSnapshot,
    'userName' | 'userPrefix' | 'userColor' | 'assistantDot' | 'assistantDotGlyph' | 'assistantDotImage'>
  highlighted?: boolean
  resolveUserName?: (sender: string) => string | undefined
  now?: () => number
  rowRef?: (node: HTMLDivElement | null) => void
}

export function SolidMessageRow(props: SolidMessageRowProps) {
  const message = () => props.renderMessage.message
  onCleanup(() => props.rowRef?.(null))
  return (
    <ErrorBoundary fallback={error => (
      <div class="term-row term-row-error" role="alert">
        消息渲染失败：{error instanceof Error ? error.message : String(error)}
      </div>
    )}>
      <div
        ref={node => props.rowRef?.(node)}
        class={`term-row term-row-${message().role}${props.highlighted ? ' term-row-search-active' : ''}`}
        data-render-type={props.renderMessage.type}
        data-pylon-component="message"
        data-message-role={message().role}
      >
        <Show when={props.renderMessage.type === 'user'}>
          <UserLine
            sender={message().sender}
            content={message().content}
            appearance={props.appearance}
            resolveUserName={props.resolveUserName}
          />
        </Show>
        <Show when={props.renderMessage.type === 'assistant'}>
          <AssistantContent text={message().content} appearance={props.appearance} />
        </Show>
        <Show when={props.renderMessage.type === 'reasoning'}>
          <ReasoningBlock
            text={message().content}
            running={message().running === true}
            startedAt={message().thoughtStartedAt}
            durationMs={message().thoughtDurationMs}
            now={props.now}
          />
        </Show>
        <Show when={props.renderMessage.type === 'error' || props.renderMessage.type === 'system'}>
          <div class="term-row-error" role="alert">{message().content || '系统消息'}</div>
        </Show>
      </div>
    </ErrorBoundary>
  )
}

export function AssistantContent(props: {
  text: string
  appearance: Pick<WorkbenchAppearanceSnapshot, 'assistantDot' | 'assistantDotGlyph' | 'assistantDotImage'>
  streaming?: boolean
}) {
  const [copied, setCopied] = createSignal(false)
  let copiedTimer: number | undefined
  onCleanup(() => {
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
  })

  const copy = () => {
    void navigator.clipboard?.writeText(props.text).catch(() => {})
    setCopied(true)
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div class={`term-assistant${props.appearance.assistantDot ? ' has-dot' : ''}`}>
      <Show when={props.appearance.assistantDot}>
        <Show
          when={props.appearance.assistantDotImage}
          fallback={<span class="term-assistant-dot" aria-hidden="true">{props.appearance.assistantDotGlyph || '●'}</span>}
        >
          {src => <img class="term-assistant-dot-img" src={src()} alt="" aria-hidden="true" />}
        </Show>
      </Show>
      <button class="copy-btn" type="button" onClick={copy} aria-label="复制消息">{copied() ? '✓' : '⎘'}</button>
      <div class="term-assistant-body">
        <MarkdownContent text={props.text} streaming={props.streaming} />
      </div>
    </div>
  )
}

function UserLine(props: {
  sender: string
  content: string
  appearance: Pick<WorkbenchAppearanceSnapshot, 'userName' | 'userPrefix' | 'userColor'>
  resolveUserName?: (sender: string) => string | undefined
}) {
  const name = () => props.appearance.userName
    || props.resolveUserName?.(props.sender)
    || props.sender.replace(/^.*:/, '')
  const colorStyle = () => props.appearance.userColor ? { color: props.appearance.userColor } : undefined

  return (
    <div class="term-user">
      <span class="term-user-prefix" style={colorStyle()}>{props.appearance.userPrefix || '❯'}</span>
      <span class="term-user-name" style={colorStyle()}>{name()}</span>
      <div class="term-user-content"><MarkdownContent text={props.content} inline /></div>
    </div>
  )
}

export function ReasoningBlock(props: {
  text: string
  running: boolean
  startedAt?: number
  durationMs?: number
  now?: () => number
}) {
  const [open, setOpen] = createSignal(false)
  const bodyId = `solid-reasoning-${Math.random().toString(36).slice(2)}`
  const label = () => props.running ? 'Thinking…' : `Thought for ${props.text.length} chars`

  return (
    <div class="term-reasoning" data-state={props.running ? 'running' : 'complete'}>
      <button class="term-reasoning-head" type="button" onClick={() => setOpen(value => !value)} aria-expanded={open()} aria-controls={bodyId}>
        <span class="term-reasoning-label">{label()}</span>
        <span class="term-reasoning-toggle" aria-hidden="true">{open() ? '−' : '+'}</span>
      </button>
      <SolidCollapsibleRegion open={open()} id={bodyId}>
        <div class="term-reasoning-body">
          <For each={props.text.split('\n')}>{line => <div class="term-reasoning-line">{line || '\u00a0'}</div>}</For>
        </div>
      </SolidCollapsibleRegion>
    </div>
  )
}
