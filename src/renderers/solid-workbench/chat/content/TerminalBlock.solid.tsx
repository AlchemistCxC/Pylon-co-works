import { For, Show, createEffect, createMemo } from 'solid-js'
import { stripAnsiControlSequences } from '../../../../domains/rendererContent/textContentContracts.ts'
import type { ContentPart, UnknownContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
import type { RenderAppearanceSnapshot } from '../../../../contracts/messageRenderer.ts'
import type { RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import type { WorkbenchActivityNode } from '../../../../domains/workbench/workbenchProjector.ts'

/**
 * C07：终端/日志卡（Solid）。
 *
 * 卡面规则：
 * - stdout/stderr 分列呈现（stderr 视觉区分），ANSI 复用 C00 sanitizer（纯文本化）；
 * - exit / killed / timeout / non-zero 分开显示；迟到 chunk 标记呈现；
 * - truncation 显示 captured/omitted；copy 经注入回调；
 * - secret-like env 已在 normalizer 脱敏，组件不接触 raw。
 */

export interface TerminalActions {
  copy?: (text: string) => void
}

/** C07：外观 token 数值兜底（与 SearchResults 同构——非有限数值回退 kind default）。 */
function boundedNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function SolidTerminalBlock(props: { part: ContentPart; actions?: TerminalActions; appearance?: RenderAppearanceSnapshot }) {
  let body: HTMLDivElement | undefined
  const parsed = createMemo(() => props.part as unknown as {
    kind: string
    command?: string
    processId?: string
    sessionId?: string
    streams?: readonly { stream: string; text: string; ordinal?: number; lateAfterTerminal?: boolean }[]
    exitCode?: number
    terminatedBy?: string
    status?: string
    durationMs?: number
    truncation?: { capturedLines?: number; omittedLines?: number; capturedBytes?: number; omittedBytes?: number }
  })

  const streams = () => parsed().streams ?? []
  const retainedLines = () => typeof props.appearance?.retainedLines === 'number' && Number.isFinite(props.appearance.retainedLines)
    ? Math.max(1, Math.floor(props.appearance.retainedLines))
    : 2000
  const regularStreams = () => streams().filter(entry => entry.lateAfterTerminal !== true).slice(-retainedLines())
  const lateStreams = () => streams().filter(entry => entry.lateAfterTerminal === true)
  const showIdentity = () => props.appearance?.showIdentity !== false
  const showCopy = () => props.appearance?.showCopy !== false
  const showTimestamps = () => props.appearance?.timestamps === true
  const wrap = () => props.appearance?.wrap === 'soft' ? 'soft' : 'none'
  const maxHeight = () => typeof props.appearance?.maxHeight === 'number' && Number.isFinite(props.appearance.maxHeight)
    ? Math.max(80, props.appearance.maxHeight)
    : 480
  const exitLabel = () => {
    if (parsed().terminatedBy === 'timeout') return '超时终止'
    if (parsed().terminatedBy === 'killed') return '已终止 (killed)'
    if (parsed().exitCode !== undefined && parsed().exitCode !== 0) return `exit ${parsed().exitCode}`
    if (parsed().exitCode === 0) return 'exit 0'
    return undefined
  }
  const statusTone = () => {
    if (parsed().terminatedBy === 'timeout' || parsed().terminatedBy === 'killed') return 'abnormal'
    if ((parsed().exitCode ?? 0) !== 0) return 'failed'
    if (parsed().status === 'completed') return 'completed'
    return 'running'
  }

  const plainText = () => streams()
    .map(entry => `${entry.stream === 'stderr' ? '[err] ' : ''}${stripAnsiControlSequences(entry.text).map(span => span.text).join('')}`)
    .join('\n')

  createEffect(() => {
    const observedStreams = streams()
    if (props.appearance?.followTail === false || !body) return
    queueMicrotask(() => {
      if (props.appearance?.followTail !== false && body && observedStreams === streams()) body.scrollTop = body.scrollHeight
    })
  })

  return (
    <div class="term-terminal-card" data-part-kind={props.part.kind} data-status-tone={statusTone()}
      data-density={props.appearance?.density === 'compact' ? 'compact' : 'comfortable'}
      data-reduced-motion={props.appearance?.reducedMotion === true ? 'true' : 'false'}>
      <Show when={Boolean(parsed().command || showIdentity() && (parsed().processId || parsed().sessionId) || exitLabel() || showCopy())}>
          <div class="term-terminal-head">
            <Show when={parsed().command}>{command => <span class="term-terminal-command">{command()}</span>}</Show>
            <Show when={showIdentity() && (parsed().processId || parsed().sessionId)}>
              <span class="term-terminal-identity">
                {[parsed().processId, parsed().sessionId].filter(Boolean).join(' · ')}
              </span>
            </Show>
            <Show when={exitLabel()}>
              {label => <span class="term-terminal-exit" data-tone={statusTone()}>{label()}</span>}
            </Show>
            <Show when={showCopy()}>
              <button
                class="term-file-action"
                type="button"
                disabled={props.actions?.copy === undefined}
                title="复制输出"
                onClick={() => props.actions?.copy?.(plainText())}
              >
                复制
              </button>
            </Show>
          </div>
      </Show>
      <div ref={body} class="term-terminal-body" role="log" aria-label="终端输出"
        data-wrap={wrap()} data-follow-tail={props.appearance?.followTail === false ? 'false' : 'true'}
        style={{
          'max-height': `${maxHeight()}px`,
          overflow: 'auto',
          background: typeof props.appearance?.background === 'string' ? props.appearance.background : 'transparent',
          'white-space': wrap() === 'soft' ? 'pre-wrap' : 'pre',
          'font-family': props.appearance?.fontFamily === 'inherit'
            ? 'inherit'
            : 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          'font-size': `${boundedNumber(props.appearance?.fontSize, 13)}px`,
          'line-height': String(boundedNumber(props.appearance?.lineHeight, 1.5)),
        }}>
        <For each={regularStreams()}>
          {entry => (
            <div class={`term-terminal-line term-stream-${entry.stream === 'stderr' ? 'stderr' : 'stdout'}`}
              style={{ color: entry.stream === 'stderr'
                ? typeof props.appearance?.stderrColor === 'string' ? props.appearance.stderrColor : 'var(--danger, #e5484d)'
                : typeof props.appearance?.stdoutColor === 'string' ? props.appearance.stdoutColor : 'var(--text)' }}>
              <span class="term-stream-tag" aria-hidden="true">{entry.stream === 'stderr' ? 'err' : 'out'}</span>
              <Show when={showTimestamps() && 'timestamp' in entry && typeof entry.timestamp === 'string'}>
                <time class="term-stream-time">{String('timestamp' in entry ? entry.timestamp : '')}</time>
              </Show>
              {/* ANSI 经 C00 sanitizer 纯文本化——不注入 HTML */}
              <span class="term-stream-text">{stripAnsiControlSequences(entry.text).map(span => span.text).join('')}</span>
            </div>
          )}
        </For>
        <Show when={(parsed().truncation?.omittedLines ?? 0) > 0 || (parsed().truncation?.omittedBytes ?? 0) > 0}>
          <div class="term-terminal-truncation" role="status">
            输出已截断：保留 {parsed().truncation?.capturedLines ?? streams().length} 行
            {parsed().truncation?.omittedLines !== undefined && `，省略 ${parsed().truncation?.omittedLines} 行`}
            {parsed().truncation?.omittedBytes !== undefined && `（${parsed().truncation?.omittedBytes} bytes）`}
          </div>
        </Show>
        <For each={lateStreams()}>
          {entry => (
            <div class="term-terminal-late" data-late="true">
              迟到输出：{stripAnsiControlSequences(entry.text).map(span => span.text).join('')}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

export function SolidLogBlock(props: { part: ContentPart; appearance?: RenderAppearanceSnapshot }) {
  const parsed = createMemo(() => props.part as unknown as {
    source?: string
    entries?: readonly { level: string; originalLevel?: string; text: string; timestamp?: string; timestampConfidence?: string }[]
    truncation?: { capturedLines?: number; omittedLines?: number; capturedBytes?: number; omittedBytes?: number }
  })
  const allowedLevels = () => Array.isArray(props.appearance?.logLevels)
    ? new Set(props.appearance.logLevels.filter((value): value is string => typeof value === 'string'))
    : new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'])
  const retainedLines = () => typeof props.appearance?.retainedLines === 'number' && Number.isFinite(props.appearance.retainedLines)
    ? Math.max(1, Math.floor(props.appearance.retainedLines))
    : 2000
  const entries = () => (parsed().entries ?? []).filter(entry => allowedLevels().has(entry.level)).slice(-retainedLines())
  const maxHeight = () => typeof props.appearance?.maxHeight === 'number' && Number.isFinite(props.appearance.maxHeight)
    ? Math.max(80, props.appearance.maxHeight)
    : 480
  return (
    <div class="term-log-card" data-part-kind={props.part.kind}
      data-density={props.appearance?.density === 'compact' ? 'compact' : 'comfortable'}>
      <Show when={props.appearance?.showIdentity !== false && parsed().source}>
        {source => <span class="term-file-meta-line">{source()}</span>}
      </Show>
      <div class="term-log-entries" role="log" aria-label="日志输出"
        data-wrap={props.appearance?.wrap === 'soft' ? 'soft' : 'none'}
        style={{
          'max-height': `${maxHeight()}px`,
          overflow: 'auto',
          background: typeof props.appearance?.background === 'string' ? props.appearance.background : 'transparent',
          'white-space': props.appearance?.wrap === 'soft' ? 'pre-wrap' : 'pre',
          'font-size': `${boundedNumber(props.appearance?.fontSize, 13)}px`,
          'line-height': String(boundedNumber(props.appearance?.lineHeight, 1.5)),
        }}>
        <For each={entries()}>
          {entry => (
            <div class={`term-log-entry term-log-${entry.level}`} style={{
              color: entry.level === 'error' || entry.level === 'fatal' || entry.level === 'warn'
                ? typeof props.appearance?.stderrColor === 'string' ? props.appearance.stderrColor : 'var(--danger, #e5484d)'
                : typeof props.appearance?.stdoutColor === 'string' ? props.appearance.stdoutColor : 'var(--text)',
            }}>
              <span class="term-log-level">{entry.originalLevel ?? entry.level}</span>
              <Show when={props.appearance?.timestamps === true && entry.timestamp}>
                {timestamp => <time class="term-stream-time">{timestamp()}</time>}
              </Show>
              <span class="term-stream-text">{entry.text}</span>
              <Show when={entry.timestampConfidence === 'synthetic'}>
                <span class="term-file-meta-line">时间戳为合成</span>
              </Show>
            </div>
          )}
        </For>
        <Show when={parsed().truncation}>{truncation => <div class="term-terminal-truncation term-log-truncation" role="status">
          日志已截断
          {truncation().capturedLines !== undefined && `：保留 ${truncation().capturedLines} 行`}
          {truncation().omittedLines !== undefined && `，省略 ${truncation().omittedLines} 行`}
          {truncation().omittedBytes !== undefined && `（${truncation().omittedBytes} bytes）`}
        </div>}</Show>
      </div>
    </div>
  )
}

export function SolidProcessActivity(props: {
  activity: WorkbenchActivityNode
  appearance?: RenderAppearanceSnapshot
  commands?: RenderCommandPort
}) {
  const parts = () => Array.isArray(props.activity.parts)
    ? props.activity.parts.filter((part): part is ContentPart => typeof part === 'object' && part !== null
      && !Array.isArray(part) && typeof (part as Record<string, unknown>).kind === 'string')
    : []
  const progress = () => {
    if (props.activity.progress === undefined) return undefined
    try { return JSON.stringify(props.activity.progress) } catch { return '[unavailable]' }
  }
  const copy = props.commands?.canExecute?.('clipboard.write') === true
    ? (text: string) => { void props.commands?.execute({ type: 'clipboard.write', payload: { text } }) }
    : undefined
  return <section class="term-process-activity" role="status"
    aria-label={`进程：${props.activity.title ?? props.activity.id}，${props.activity.status}`}
    data-status={props.activity.status} data-density={props.appearance?.density === 'compact' ? 'compact' : 'comfortable'}
    data-reduced-motion={props.appearance?.reducedMotion === true ? 'true' : 'false'}>
    <header class="term-process-head">
      <strong>{props.activity.title ?? '后台进程'}</strong>
      <span>{props.activity.status}</span>
      <Show when={props.appearance?.showIdentity !== false && (props.activity.processId || props.activity.sessionId)}>
        <small>{[props.activity.processId, props.activity.sessionId].filter(Boolean).join(' · ')}</small>
      </Show>
    </header>
    <Show when={progress()}>{value => <pre class="term-process-progress">{value()}</pre>}</Show>
    <For each={parts()}>{part => part.kind === 'terminal'
      ? <SolidTerminalBlock part={part} appearance={props.appearance} actions={{ copy }} />
      : part.kind === 'log'
        ? <SolidLogBlock part={part} appearance={props.appearance} />
        : part.kind === 'unknown'
          ? <SolidUnknownProcessContent part={part} />
          : <pre class="solid-content-unknown" data-content-kind={part.kind}>Unsupported process content: {part.kind}</pre>}
    </For>
    <Show when={props.activity.error}>{error => <div role="alert" class="term-process-error">{error().userSummary}</div>}</Show>
    <Show when={props.activity.reason}><small>{props.activity.reason}</small></Show>
    <Show when={props.activity.provenance?.synthetic}>
      {synthetic => <small class="term-process-provenance">合成生命周期：{synthetic().reason}</small>}
    </Show>
  </section>
}

function SolidUnknownProcessContent(props: { part: UnknownContentPart }) {
  const raw = () => {
    try { return JSON.stringify(props.part.raw, null, 2) } catch { return '[unavailable]' }
  }
  return <section class="solid-content-unknown" data-content-kind="content.unknown"
    aria-label={`未知进程内容：${props.part.originalType}`}>
    <strong>未知内容：{props.part.originalType}</strong>
    <span>{props.part.summary}</span>
    <details><summary>Raw 审计信息</summary><pre>{raw()}</pre></details>
    <Show when={props.part.truncation}>{truncation => <small>
      Raw 已截断，省略 {truncation().omittedBytes} bytes
    </small>}</Show>
  </section>
}
