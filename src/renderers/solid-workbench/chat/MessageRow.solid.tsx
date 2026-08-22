import { ErrorBoundary, Show, createSignal, onCleanup } from 'solid-js'
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
            redacted={message().redacted === true}
            redactedReason={message().redactedReason}
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
  /** C01：provider 隐去推理——显示安全占位与原因，正文不可见。 */
  redacted?: boolean
  redactedReason?: string
}) {
  const [open, setOpen] = createSignal(false)
  const bodyId = `solid-reasoning-${Math.random().toString(36).slice(2)}`
  // C01 四态：running / complete(duration) / redacted(reason) / missing(无内容且非 running)
  const label = () => {
    if (props.redacted) return '推理已被隐藏'
    if (props.running) return '正在思考…'
    if (props.durationMs !== undefined) return formatThoughtDuration(props.durationMs)
    if (props.text.trim()) return '思考过程'
    return '暂无思考内容'
  }
  const state = () => props.redacted ? 'redacted' : props.running ? 'running' : props.text.trim() ? 'complete' : 'missing'

  return (
    <div class="term-reasoning" data-state={state()}>
      <Show when={state() !== 'redacted' && state() !== 'missing'} fallback={
        // redacted/missing：无 body 可展开，原因作为可见说明文本
        <div class="term-reasoning-head term-reasoning-static">
          <span class="term-reasoning-label">{label()}</span>
          <Show when={props.redacted && props.redactedReason}>
            {reason => <span class="term-reasoning-reason">{reason()}</span>}
          </Show>
        </div>
      }>
        <button class="term-reasoning-head" type="button" onClick={() => setOpen(value => !value)} aria-expanded={open()} aria-controls={bodyId}>
          <span class="term-reasoning-label">{label()}</span>
          <span class="term-reasoning-toggle" aria-hidden="true">{open() ? '−' : '+'}</span>
        </button>
        <SolidCollapsibleRegion open={open()} id={bodyId}>
          {/* C01 步骤4：正文复用 C00 markdown 管线，不建第二套渲染 */}
          <div class="term-reasoning-body">
            <MarkdownContent text={props.text} />
          </div>
        </SolidCollapsibleRegion>
      </Show>
    </div>
  )
}

/** C01：时长格式化——秒内一位小数，分钟以上进位。 */
function formatThoughtDuration(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < 60_000) return `Thought for ${(clamped / 1000).toFixed(1).replace(/\.0$/, '')}s`
  const minutes = Math.floor(clamped / 60_000)
  const seconds = Math.round((clamped % 60_000) / 1000)
  return `Thought for ${minutes}m ${seconds}s`
}
