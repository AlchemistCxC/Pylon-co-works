import { For, Show, createSignal } from 'solid-js'
import type { RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import { classifyResourceTarget, isUriLike } from './resourceTarget.ts'

const LONG_STRING_LENGTH = 220

export function ToolObjectInspector(props: {
  value: unknown
  commands?: RenderCommandPort
  path?: readonly (string | number)[]
  depth?: number
}) {
  const path = () => props.path ?? []
  const depth = () => props.depth ?? 0
  const entries = () => objectEntryNames(props.value)

  return <div class="tool-object-inspector" data-value-type={valueType(props.value)}>
    <Show when={entries()} fallback={<ToolPrimitive value={props.value} path={path()} commands={props.commands} />}>
      {items => <div class="tool-object-children">
        <For each={items()}>{name => <ToolObjectEntry
          name={name}
          value={objectEntryValue(props.value, name)}
          path={[...path(), name]}
          depth={depth()}
          commands={props.commands}
        />}</For>
      </div>}
    </Show>
  </div>
}

function ToolObjectEntry(props: {
  name: string | number
  value: unknown
  path: readonly (string | number)[]
  depth: number
  commands?: RenderCommandPort
}) {
  const [branchOpen, setBranchOpen] = createSignal(props.depth < 1)
  const entries = () => objectEntries(props.value)
  const label = () => String(props.name)
  const copyPath = () => copy(props.commands, formatObjectPath(props.path))

  return <div class="tool-object-entry" data-value-type={valueType(props.value)}>
    <Show when={entries()} fallback={<div class="tool-object-row">
      <span class="tool-object-key">{label()}</span><span class="tool-object-separator">:</span>
      <ToolPrimitive value={props.value} path={props.path} commands={props.commands} />
    </div>}>
      {items => <details class="tool-object-branch" open={branchOpen()}
        onToggle={event => setBranchOpen(event.currentTarget.open)}>
        <summary>
          <span class="tool-object-key">{label()}</span>
          <span class="tool-object-count">{Array.isArray(props.value) ? `[${items().length}]` : `{${items().length}}`}</span>
          <Show when={can(props.commands, 'clipboard.write')}>
            <button class="tool-object-action" type="button" title="复制字段路径"
              onClick={event => { event.preventDefault(); event.stopPropagation(); copyPath() }}>复制路径</button>
          </Show>
        </summary>
        <Show when={branchOpen()}>
          <ToolObjectInspector value={props.value} path={props.path} depth={props.depth + 1} commands={props.commands} />
        </Show>
      </details>}
    </Show>
  </div>
}

function ToolPrimitive(props: {
  value: unknown
  path: readonly (string | number)[]
  commands?: RenderCommandPort
}) {
  const [expanded, setExpanded] = createSignal(false)
  const text = () => primitiveText(props.value)
  const long = () => typeof props.value === 'string' && props.value.length > LONG_STRING_LENGTH
  const visible = () => long() && !expanded() ? `${text().slice(0, LONG_STRING_LENGTH)}…` : text()
  const resource = () => typeof props.value === 'string' ? resourceTarget(props.value, props.path) : undefined
  const openableResource = () => can(props.commands, 'resource.open') ? resource() : undefined

  return <span class="tool-object-value-wrap">
    <Show when={openableResource()} fallback={<span class="tool-object-value" data-primitive-type={valueType(props.value)}>{visible()}</span>}>
      {target => <button class="tool-object-resource" type="button"
        title="打开资源"
        onClick={() => open(props.commands, target())}>{visible()}</button>}
    </Show>
    <Show when={long()}>
      <button class="tool-object-action" type="button" onClick={() => setExpanded(value => !value)}>
        {expanded() ? '收起' : '展开'}
      </button>
    </Show>
    <Show when={props.path.length > 0 && can(props.commands, 'clipboard.write')}>
      <span class="tool-object-actions">
        <button class="tool-object-action" type="button" title="复制值"
          onClick={() => copy(props.commands, copyText(props.value))}>复制</button>
        <button class="tool-object-action" type="button" title="复制字段路径"
          onClick={() => copy(props.commands, formatObjectPath(props.path))}>路径</button>
      </span>
    </Show>
  </span>
}

function objectEntries(value: unknown): readonly { name: string | number; value: unknown }[] | undefined {
  if (Array.isArray(value)) return value.map((item, index) => ({ name: index, value: item }))
  if (!isRecord(value)) return undefined
  return Object.entries(value).map(([name, child]) => ({ name, value: child }))
}

function objectEntryNames(value: unknown): readonly (string | number)[] | undefined {
  if (Array.isArray(value)) return value.map((_, index) => index)
  if (!isRecord(value)) return undefined
  return Object.keys(value)
}

function objectEntryValue(value: unknown, name: string | number): unknown {
  if (Array.isArray(value) && typeof name === 'number') return value[name]
  return isRecord(value) ? value[String(name)] : undefined
}

function primitiveText(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value || '""'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  try { return JSON.stringify(value) }
  catch { return '[unavailable]' }
}

function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function resourceTarget(value: string, path: readonly (string | number)[]): { path: string } | { uri: string } | undefined {
  const trimmed = value.trim()
  const key = String(path.at(-1) ?? '').toLowerCase()
  const resourceKey = /(^|_)(path|file|filename|directory|cwd|root|location|uri|url|href|resource_uri)$/.test(key)
  const looksLikePath = /^(?:[a-z]:[\\/]|\\\\|\/|\.\.?[\\/])/.test(trimmed)
  return resourceKey || looksLikePath || isUriLike(trimmed) ? classifyResourceTarget(trimmed, key) : undefined
}

function formatObjectPath(path: readonly (string | number)[]): string {
  return path.reduce<string>((current, part) => typeof part === 'number'
    ? `${current}[${part}]`
    : current ? `${current}.${part}` : part, '')
}

function copyText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) }
  catch { return String(value) }
}

function can(commands: RenderCommandPort | undefined, type: string): boolean {
  return commands?.canExecute?.(type) === true
}

function copy(commands: RenderCommandPort | undefined, text: string): void {
  if (!can(commands, 'clipboard.write')) return
  void commands?.execute({ type: 'clipboard.write', payload: { text } })
}

function open(commands: RenderCommandPort | undefined, target: { path: string } | { uri: string }): void {
  if (!can(commands, 'resource.open')) return
  void commands?.execute({ type: 'resource.open', payload: target })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
