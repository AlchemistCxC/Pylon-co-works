import { For, Show, createMemo } from 'solid-js'
import { stripAnsiControlSequences } from '../../../../domains/rendererContent/textContentContracts.ts'
import type { ContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'

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

export function SolidTerminalBlock(props: { part: ContentPart; actions?: TerminalActions }) {
  const parsed = createMemo(() => props.part as unknown as {
    kind: string
    command?: string
    streams?: readonly { stream: string; text: string; ordinal?: number; lateAfterTerminal?: boolean }[]
    exitCode?: number
    terminatedBy?: string
    status?: string
    durationMs?: number
    truncation?: { capturedLines?: number; omittedLines?: number; omittedBytes?: number }
  })

  const streams = () => parsed().streams ?? []
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

  return (
    <div class="term-terminal-card" data-part-kind={props.part.kind} data-status-tone={statusTone()}>
      <Show when={parsed().command}>
        {command => (
          <div class="term-terminal-head">
            <span class="term-terminal-command">{command()}</span>
            <Show when={exitLabel()}>
              {label => <span class="term-terminal-exit" data-tone={statusTone()}>{label()}</span>}
            </Show>
            <button
              class="term-file-action"
              type="button"
              disabled={props.actions?.copy === undefined}
              title="复制输出"
              onClick={() => props.actions?.copy?.(plainText())}
            >
              复制
            </button>
          </div>
        )}
      </Show>
      <div class="term-terminal-body" role="log" aria-label="终端输出">
        <For each={streams()}>
          {entry => (
            <div class={`term-terminal-line term-stream-${entry.stream === 'stderr' ? 'stderr' : 'stdout'}`}>
              <span class="term-stream-tag" aria-hidden="true">{entry.stream === 'stderr' ? 'err' : 'out'}</span>
              {/* ANSI 经 C00 sanitizer 纯文本化——不注入 HTML */}
              <span class="term-stream-text">{stripAnsiControlSequences(entry.text).map(span => span.text).join('')}</span>
            </div>
          )}
        </For>
        <Show when={(parsed().truncation?.omittedLines ?? 0) > 0}>
          <div class="term-terminal-truncation">
            输出已截断：保留 {parsed().truncation?.capturedLines ?? streams().length} 行，省略 {parsed().truncation?.omittedLines} 行
          </div>
        </Show>
        <For each={streams().filter(entry => entry.lateAfterTerminal === true)}>
          {entry => (
            <div class="term-terminal-late" data-late="true">
              迟到输出：{entry.text}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

export function SolidLogBlock(props: { part: ContentPart }) {
  const parsed = createMemo(() => props.part as unknown as {
    source?: string
    entries?: readonly { level: string; text: string; timestampConfidence?: string }[]
  })
  return (
    <div class="term-log-card" data-part-kind={props.part.kind}>
      <Show when={parsed().source}>
        {source => <span class="term-file-meta-line">{source()}</span>}
      </Show>
      <div class="term-log-entries" role="log">
        <For each={parsed().entries ?? []}>
          {entry => (
            <div class={`term-log-entry term-log-${entry.level}`}>
              <span class="term-log-level">{entry.level}</span>
              <span class="term-stream-text">{entry.text}</span>
              <Show when={entry.timestampConfidence === 'synthetic'}>
                <span class="term-file-meta-line">时间戳为合成</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
