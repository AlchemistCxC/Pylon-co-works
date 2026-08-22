import { ErrorBoundary, Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js'
import type { RenderMessage } from '../../../components/chat/messageTypes.ts'
import { formatThoughtDuration } from '../../../domains/rendererContent/reasoningPresentation.ts'
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
  /** Production Workbench may route canonical content parts through Suite-local Slots. */
  semanticContent?: JSX.Element
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
            semanticContent={props.semanticContent}
          />
        </Show>
        <Show when={props.renderMessage.type === 'assistant'}>
          <AssistantContent text={message().content} appearance={props.appearance} semanticContent={props.semanticContent} />
        </Show>
        <Show when={props.renderMessage.type === 'reasoning'}>
          <Show when={props.semanticContent !== undefined} fallback={
            <ReasoningBlock
              text={message().content}
              running={message().running === true}
              startedAt={message().thoughtStartedAt}
              durationMs={message().thoughtDurationMs}
              now={props.now}
              redacted={message().redacted === true}
              redactedReason={message().redactedReason}
            />
          }>{props.semanticContent}</Show>
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
  semanticContent?: JSX.Element
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
        <Show when={props.semanticContent !== undefined} fallback={<MarkdownContent text={props.text} streaming={props.streaming} />}>
          {props.semanticContent}
        </Show>
      </div>
    </div>
  )
}

function UserLine(props: {
  sender: string
  content: string
  appearance: Pick<WorkbenchAppearanceSnapshot, 'userName' | 'userPrefix' | 'userColor'>
  resolveUserName?: (sender: string) => string | undefined
  semanticContent?: JSX.Element
}) {
  const name = () => props.appearance.userName
    || props.resolveUserName?.(props.sender)
    || props.sender.replace(/^.*:/, '')
  const colorStyle = () => props.appearance.userColor ? { color: props.appearance.userColor } : undefined

  return (
    <div class="term-user">
      <span class="term-user-prefix" style={colorStyle()}>{props.appearance.userPrefix || '❯'}</span>
      <span class="term-user-name" style={colorStyle()}>{name()}</span>
      <div class="term-user-content">
        <Show when={props.semanticContent !== undefined} fallback={<MarkdownContent text={props.content} inline />}>
          {props.semanticContent}
        </Show>
      </div>
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
  foreground?: string
  background?: string
  borderColor?: string
  fontSize?: number
  lineHeight?: number
  defaultCollapsed?: boolean
  maxHeight?: number
  runningAnimation?: 'pulse' | 'shimmer' | 'none'
  showDuration?: boolean
  reducedMotion?: boolean
}) {
  const collapsedByDefault = () => props.defaultCollapsed !== false
  const [open, setOpen] = createSignal(props.running || !collapsedByDefault())
  const bodyId = `solid-reasoning-${Math.random().toString(36).slice(2)}`
  let previousRunning = props.running
  let previousDefaultCollapsed = collapsedByDefault()
  createEffect(() => {
    const running = props.running
    const defaultCollapsed = collapsedByDefault()
    if ((previousRunning && !running) || (!running && defaultCollapsed !== previousDefaultCollapsed)) {
      setOpen(!defaultCollapsed)
    }
    previousRunning = running
    previousDefaultCollapsed = defaultCollapsed
  })
  // C01 四态：running / complete(duration) / redacted(reason) / missing(无内容且非 running)
  const label = () => {
    if (props.redacted) return '推理已被隐藏'
    if (props.running) return '正在思考…'
    if (props.showDuration !== false && props.durationMs !== undefined) return formatThoughtDuration(props.durationMs)
    if (props.text.trim()) return '思考过程'
    return '暂无思考内容'
  }
  const state = () => props.redacted ? 'redacted' : props.running ? 'running' : props.text.trim() ? 'complete' : 'missing'
  const runningAnimation = () => props.reducedMotion || props.runningAnimation === 'none'
    ? 'none'
    : props.runningAnimation === 'shimmer' ? 'shimmer' : 'pulse'
  const rootStyle = () => ({
    '--reasoning-foreground': props.foreground ?? 'var(--text-dim)',
    color: props.foreground ?? 'var(--text-dim)',
    'background-color': props.background ?? 'transparent',
    'font-size': `${props.fontSize ?? 13}px`,
    'line-height': String(props.lineHeight ?? 1.6),
  })
  const bodyStyle = () => ({
    'max-height': `${props.maxHeight ?? 320}px`,
    'border-color': props.borderColor ?? 'color-mix(in srgb, var(--border) 72%, transparent)',
  })

  return (
    <div
      class="term-reasoning"
      data-state={state()}
      data-running-animation={runningAnimation()}
      style={rootStyle()}
    >
      <Show when={state() !== 'redacted' && state() !== 'missing'} fallback={
        // redacted/missing：无 body 可展开，原因作为可见说明文本
        <div class="term-reasoning-head term-reasoning-static">
          <span class="term-reasoning-label" aria-live={props.running ? 'polite' : undefined}>{label()}</span>
          <Show when={props.redacted && props.redactedReason}>
            {reason => <span class="term-reasoning-reason">{reason()}</span>}
          </Show>
        </div>
      }>
        <button class="term-reasoning-head" type="button" onClick={() => setOpen(value => !value)} aria-expanded={open()} aria-controls={bodyId}>
          <span class="term-reasoning-label" aria-live={props.running ? 'polite' : undefined}>{label()}</span>
          <span class="term-reasoning-toggle" aria-hidden="true">{open() ? '−' : '+'}</span>
        </button>
        <SolidCollapsibleRegion open={open()} id={bodyId}>
          {/* C01 步骤4：正文复用 C00 markdown 管线，不建第二套渲染 */}
          <div class="term-reasoning-body" style={bodyStyle()}>
            <MarkdownContent text={props.text} />
          </div>
        </SolidCollapsibleRegion>
      </Show>
    </div>
  )
}
