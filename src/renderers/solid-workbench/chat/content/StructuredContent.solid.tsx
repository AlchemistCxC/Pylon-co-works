import { For, Show, Switch, Match, createMemo, type JSX } from 'solid-js'
import type { RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import { parseContentPart, type ContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
import { ToolObjectInspector } from '../tool/ToolObjectInspector.solid.tsx'
import { classifyResourceTarget, resourceRange } from '../tool/resourceTarget.ts'

export type StructuredContentKind = 'content.location' | 'content.progress' | 'content.list' | 'content.key-value' | 'content.json' | 'content.tool-use' | 'content.tool-result'

const STRUCTURED_CONTENT_KINDS: ReadonlySet<string> = new Set([
  'content.location', 'content.progress', 'content.list', 'content.key-value', 'content.json', 'content.tool-use', 'content.tool-result',
])

export function isStructuredContentKind(value: string): value is StructuredContentKind {
  return STRUCTURED_CONTENT_KINDS.has(value)
}

export function SolidStructuredContent(props: {
  kind: StructuredContentKind
  payload: unknown
  commands?: RenderCommandPort
  renderPart?: (part: ContentPart, index: number) => JSX.Element
}) {
  const record = () => isRecord(props.payload) ? props.payload : {}
  return <section class="solid-structured-content" data-content-kind={props.kind} aria-label={kindLabel(props.kind)}>
    <Switch>
      <Match when={props.kind === 'content.location'}>
        <LocationContent record={record()} commands={props.commands} />
      </Match>
      <Match when={props.kind === 'content.progress'}>
        <ProgressContent record={record()} />
      </Match>
      <Match when={props.kind === 'content.list'}>
        <ListContent record={record()} commands={props.commands} renderPart={props.renderPart} />
      </Match>
      <Match when={props.kind === 'content.tool-use' || props.kind === 'content.tool-result'}>
        <ToolEnvelopeContent kind={props.kind} record={record()} commands={props.commands} renderPart={props.renderPart} />
      </Match>
      <Match when={true}>
        <header class="solid-structured-head"><strong>{kindLabel(props.kind)}</strong></header>
        <ToolObjectInspector value={structuredValue(record())} commands={props.commands} />
      </Match>
    </Switch>
  </section>
}

function LocationContent(props: { record: Record<string, unknown>; commands?: RenderCommandPort }) {
  const target = () => firstStringEntry(props.record, ['path', 'uri', 'url', 'source', 'file'])
  const line = () => firstFinite(props.record, ['line', 'startLine', 'start_line'])
  const column = () => firstFinite(props.record, ['column', 'character'])
  const label = () => [line() !== undefined ? `L${line()}` : undefined, column() !== undefined ? `C${column()}` : undefined].filter(Boolean).join(':')
  return <>
    <header class="solid-structured-head"><strong>位置</strong><Show when={label()}>{value => <span>{value()}</span>}</Show></header>
    <Show when={target()} fallback={<ToolObjectInspector value={props.record} commands={props.commands} />}>
      {entry => <button class="solid-structured-resource" type="button" disabled={!can(props.commands, 'resource.open')}
        onClick={() => open(props.commands, classifyResourceTarget(entry().value, entry().key, resourceRange(line(), column())))}>{entry().value}</button>}
    </Show>
  </>
}

function ProgressContent(props: { record: Record<string, unknown> }) {
  const current = () => firstFinite(props.record, ['completed', 'current', 'done', 'value', 'used'])
  const total = () => firstFinite(props.record, ['total', 'maximum', 'max', 'limit'])
  const explicit = () => firstFinite(props.record, ['percent', 'percentage'])
  const percent = () => explicit() !== undefined
    ? clampPercent(explicit()!)
    : current() !== undefined && total() !== undefined && total()! > 0 ? clampPercent(current()! / total()! * 100) : undefined
  const message = () => firstString(props.record, ['message', 'label', 'status', 'phase', 'detail'])
  return <>
    <header class="solid-structured-head"><strong>{message() ?? '进度'}</strong><Show when={percent() !== undefined}><span>{Math.round(percent()!)}%</span></Show></header>
    <Show when={percent() !== undefined} fallback={<ToolObjectInspector value={props.record} />}>
      <progress class="solid-structured-progress" max="100" value={percent()} aria-label={message() ?? '进度'} />
    </Show>
  </>
}

function ListContent(props: { record: Record<string, unknown>; commands?: RenderCommandPort; renderPart?: (part: ContentPart, index: number) => JSX.Element }) {
  const items = () => firstArray(props.record, ['items', 'values', 'entries', 'results']) ?? []
  const title = () => firstString(props.record, ['title', 'label', 'summary']) ?? '列表'
  return <>
    <header class="solid-structured-head"><strong>{title()}</strong><span>{items().length} 项</span></header>
    <ol class="solid-structured-list">
      <For each={items()}>{(item, index) => <li>
        <Show when={contentPart(item)} fallback={<ToolObjectInspector value={item} commands={props.commands} />}>
          {part => props.renderPart ? props.renderPart(part(), index()) : <ToolObjectInspector value={part()} commands={props.commands} />}
        </Show>
      </li>}</For>
    </ol>
  </>
}

function ToolEnvelopeContent(props: { kind: StructuredContentKind; record: Record<string, unknown>; commands?: RenderCommandPort; renderPart?: (part: ContentPart, index: number) => JSX.Element }) {
  const name = () => firstString(props.record, ['name', 'tool', 'toolName', 'title'])
  const status = () => firstString(props.record, ['status', 'state', 'outcome'])
  const duration = () => firstFinite(props.record, ['durationMs', 'latencyMs', 'elapsedMs'])
  const input = () => firstValue(props.record, ['input', 'arguments', 'params', 'parameters'])
  const error = () => firstValue(props.record, ['error', 'failure'])
  const output = () => firstValue(props.record, ['output', 'result', 'value'])
  const values = createMemo(() => firstArray(props.record, ['parts', 'content']) ?? [])
  const omitted = () => omitKeys(props.record, [
    'kind', 'name', 'tool', 'toolName', 'title', 'status', 'state', 'outcome',
    'durationMs', 'latencyMs', 'elapsedMs', 'input', 'arguments', 'params', 'parameters',
    'error', 'failure', 'output', 'result', 'value', 'parts', 'content',
  ])
  return <>
    <header class="solid-structured-head">
      <strong>{props.kind === 'content.tool-use' ? '工具请求' : '工具结果'}</strong>
      <div class="solid-structured-meta">
        <Show when={name()}>{value => <span>{value()}</span>}</Show>
        <Show when={status()}>{value => <span data-status={value()}>{statusLabel(value())}</span>}</Show>
        <Show when={duration() !== undefined}><span>{formatDuration(duration()!)}</span></Show>
      </div>
    </header>
    <Show when={input() !== undefined}>
      <section class="solid-structured-section" aria-label="工具参数">
        <strong>参数</strong>
        <ToolObjectInspector value={input()} commands={props.commands} />
      </section>
    </Show>
    <Show when={error() !== undefined}>
      <section class="solid-structured-section solid-structured-error" role="alert">
        <strong>错误</strong>
        <ToolObjectInspector value={error()} commands={props.commands} />
      </section>
    </Show>
    <Show when={Object.keys(omitted()).length > 0}>
      <section class="solid-structured-section" aria-label="工具元数据">
        <strong>元数据</strong>
        <ToolObjectInspector value={omitted()} commands={props.commands} />
      </section>
    </Show>
    <Show when={values().length > 0}>
      <div class="solid-structured-parts">
        <For each={values()}>{(value, index) => <Show when={contentPart(value)}
          fallback={<ToolObjectInspector value={value} commands={props.commands} />}>
          {part => props.renderPart ? props.renderPart(part(), index()) : <ToolObjectInspector value={part()} commands={props.commands} />}
        </Show>}</For>
      </div>
    </Show>
    <Show when={output() !== undefined}>
      <section class="solid-structured-section" aria-label="工具输出">
        <strong>输出</strong>
        <ToolObjectInspector value={output()} commands={props.commands} />
      </section>
    </Show>
  </>
}

function contentPart(value: unknown): ContentPart | undefined {
  const parsed = parseContentPart(value)
  return parsed.ok ? parsed.value : undefined
}

function structuredValue(record: Record<string, unknown>): unknown {
  for (const key of ['value', 'data', 'entries', 'fields', 'items']) {
    if (record[key] !== undefined) return record[key]
  }
  return omitKeys(record, ['kind'])
}

function kindLabel(kind: StructuredContentKind): string {
  if (kind === 'content.location') return '位置'
  if (kind === 'content.progress') return '进度'
  if (kind === 'content.list') return '列表'
  if (kind === 'content.key-value') return '键值数据'
  if (kind === 'content.json') return '结构化数据'
  if (kind === 'content.tool-use') return '工具请求'
  return '工具结果'
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === 'string' && String(record[key]).trim()) return String(record[key])
  return undefined
}

function firstStringEntry(record: Record<string, unknown>, keys: readonly string[]): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return { key, value }
  }
  return undefined
}

function firstFinite(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) if (typeof record[key] === 'number' && Number.isFinite(record[key])) return record[key] as number
  return undefined
}

function firstArray(record: Record<string, unknown>, keys: readonly string[]): readonly unknown[] | undefined {
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as readonly unknown[]
  return undefined
}

function firstValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key]
  return undefined
}

function omitKeys(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const omitted = new Set(keys)
  return Object.fromEntries(Object.entries(record).filter(([key]) => !omitted.has(key)))
}

function clampPercent(value: number): number { return Math.max(0, Math.min(100, value)) }
function formatDuration(value: number): string { return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s` }
function statusLabel(value: string): string {
  if (value === 'completed' || value === 'success' || value === 'succeeded') return '已完成'
  if (value === 'running' || value === 'in_progress' || value === 'pending') return '进行中'
  if (value === 'failed' || value === 'error') return '失败'
  if (value === 'cancelled' || value === 'canceled') return '已取消'
  return value
}
function can(commands: RenderCommandPort | undefined, type: string): boolean { return commands?.canExecute?.(type) === true }
function open(commands: RenderCommandPort | undefined, payload: ReturnType<typeof classifyResourceTarget>): void {
  if (!can(commands, 'resource.open')) return
  void commands?.execute({ type: 'resource.open', payload })
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
