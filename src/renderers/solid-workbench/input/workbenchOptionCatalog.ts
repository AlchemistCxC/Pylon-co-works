import type { SessionConfigOption } from '../../../domains/workbench/session/sessionSurface.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'

/**
 * Provider-neutral option entry used by the control-center selectors.
 *
 * ACP providers do not agree on the shape of a choice (some use `id`, some
 * use `value`, and a few return a nested `valueId`).  Keep the wire value and
 * the human label separate so the UI can be friendly without ever sending a
 * translated label back to an agent.
 */
export interface WorkbenchOptionEntry {
  readonly id: string
  readonly label: string
}

export type WorkbenchOptionKind = 'model' | 'mode' | 'reasoning'

export const DEFAULT_MODEL_OPTIONS: readonly WorkbenchOptionEntry[] = Object.freeze([
  { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
])

/** Broad fallback catalogue. A provider's advertised modes always win. */
export const DEFAULT_MODE_OPTIONS: readonly WorkbenchOptionEntry[] = Object.freeze([
  { id: 'default', label: '默认' },
  { id: 'auto', label: '全自动' },
  { id: 'accept_edits', label: '接受编辑' },
  { id: 'dont_ask', label: '不再询问' },
  { id: 'edit', label: '编辑模式' },
  { id: 'bypass', label: '绕过确认' },
])

export const DEFAULT_REASONING_OPTIONS: readonly WorkbenchOptionEntry[] = Object.freeze([
  { id: 'none', label: '关闭' },
  { id: 'minimal', label: 'minimal' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
  { id: 'ultra', label: 'ultra' },
])

const MODE_LABELS: Readonly<Record<string, string>> = {
  default: '默认',
  auto: '全自动',
  accept_edit: '接受编辑',
  accept_edits: '接受编辑',
  dont_ask: '不再询问',
  edit: '编辑模式',
  bypass: '绕过确认',
  plan: '计划模式',
  ask: '询问确认',
}

const REASONING_LABELS: Readonly<Record<string, string>> = {
  off: '关闭',
  none: '关闭',
  disabled: '关闭',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
  fast: '快速',
  balanced: '平衡',
  deep: '深入',
}

const MODEL_KEYS = new Set(['model', 'modelid', 'model_id', 'llm', 'llmmodel', 'modelname'])
const MODE_KEYS = new Set(['mode', 'modeid', 'mode_id', 'permissionmode', 'approvalmode'])

function normalizedKey(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_-]/g, '')
    : ''
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nestedValue(value: unknown): string | undefined {
  const direct = stringValue(value)
  if (direct) return direct
  const record = recordValue(value)
  if (!record) return undefined
  for (const key of ['value', 'valueId', 'id', 'key', 'name']) {
    const candidate = nestedValue(record[key])
    if (candidate) return candidate
  }
  return undefined
}

function choiceEntry(value: unknown): WorkbenchOptionEntry | undefined {
  const direct = stringValue(value)
  if (direct) return { id: direct, label: direct }
  const record = recordValue(value)
  if (!record) return undefined
  const id = nestedValue(record.id)
    ?? nestedValue(record.valueId)
    ?? nestedValue(record.value)
    ?? nestedValue(record.key)
    ?? nestedValue(record.name)
    ?? nestedValue(record.label)
  if (!id) return undefined
  const label = stringValue(record.label)
    ?? stringValue(record.name)
    ?? stringValue(record.title)
    ?? id
  return { id, label }
}

function choicesFromUnknown(value: unknown, depth = 0): WorkbenchOptionEntry[] {
  if (depth > 3 || value === undefined || value === null) return []
  if (Array.isArray(value)) return value.flatMap(item => {
    const entry = choiceEntry(item)
    return entry ? [entry] : []
  })
  const record = recordValue(value)
  if (!record) return []
  for (const key of ['options', 'choices', 'values', 'available', 'enum', 'items']) {
    if (record[key] !== undefined) {
      const entries = choicesFromUnknown(record[key], depth + 1)
      if (entries.length > 0) return entries
    }
  }
  // A JSON-schema enum is occasionally returned as a map keyed by value.
  const mapEntries = Object.entries(record)
    .map(([key, item]) => {
      const label = stringValue(item)
      return label ? { id: key, label } : undefined
    })
    .filter((item): item is WorkbenchOptionEntry => item !== undefined)
  return mapEntries
}

function optionIdentity(option: SessionConfigOption): string {
  const raw = option.raw ?? {}
  // Normalization assigns `unknown-option-N` when a provider omitted id/key.
  // Do not let that synthetic id hide a meaningful raw name/category.
  const candidates = [option.id, raw.id, raw.key, raw.name, raw.category, option.label]
  const candidate = candidates.find(value => {
    const text = stringValue(value)
    return Boolean(text && !/^unknown-option-\d+$/i.test(text))
  })
  return normalizedKey(candidate)
}

function optionKind(option: SessionConfigOption): WorkbenchOptionKind | undefined {
  const id = optionIdentity(option)
  const raw = option.raw ?? {}
  const label = normalizedKey(option.label)
  const rawText = Object.entries(raw)
    .filter(([key]) => ['id', 'key', 'name', 'label', 'category', 'title', 'description'].includes(key.toLowerCase()))
    .map(([, value]) => stringValue(value) ?? '')
    .join(' ')
  const combined = `${id} ${label} ${normalizedKey(rawText)}`
  if (MODEL_KEYS.has(id) || /(?:model|llm|模型)/i.test(combined)) return 'model'
  if (MODE_KEYS.has(id) || /(?:mode|permission|approval|权限模式|模式|权限)/i.test(combined)) return 'mode'
  if (/(reason|think|thinking|effort|推理|思考)/i.test(combined)) return 'reasoning'
  return undefined
}

function optionChoices(option: SessionConfigOption): WorkbenchOptionEntry[] {
  const fromSchema = choicesFromUnknown(option.schema)
  if (fromSchema.length > 0) return fromSchema
  return choicesFromUnknown(option.raw)
}

function optionCurrentValue(option: SessionConfigOption): string | undefined {
  return nestedValue(option.value)
    ?? nestedValue(option.raw?.currentValue)
    ?? nestedValue(option.raw?.current)
    ?? nestedValue(option.raw?.selected)
}

function mergeEntries(
  sources: readonly (readonly WorkbenchOptionEntry[])[],
  current?: string,
): readonly WorkbenchOptionEntry[] {
  const result: WorkbenchOptionEntry[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    for (const item of source) {
      const id = item.id.trim()
      if (!id) continue
      const key = id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      result.push(Object.freeze({ id, label: item.label.trim() || id }))
    }
  }
  if (current?.trim() && !seen.has(current.trim().toLowerCase())) {
    result.unshift(Object.freeze({ id: current.trim(), label: current.trim() }))
  }
  return Object.freeze(result)
}

function stringsToEntries(values: readonly string[], labels?: Readonly<Record<string, string>>): readonly WorkbenchOptionEntry[] {
  return values
    .map(value => value.trim())
    .filter(Boolean)
    .map(id => ({ id, label: labels?.[id] ?? id }))
}

export function resolveDocumentOptionEntries(
  options: readonly SessionConfigOption[] | undefined,
  kind: WorkbenchOptionKind,
): readonly WorkbenchOptionEntry[] {
  if (!options) return Object.freeze([])
  return options
    .filter(option => optionKind(option) === kind)
    .flatMap(option => {
      const choices = optionChoices(option)
      const current = optionCurrentValue(option)
      return choices.length > 0 ? choices : current ? [{ id: current, label: current }] : []
    })
}

function documentOptions(snapshot: WorkbenchRuntimeSnapshot, kind: WorkbenchOptionKind): readonly WorkbenchOptionEntry[] {
  return resolveDocumentOptionEntries(snapshot.document?.session.options, kind)
}

/** Read the provider-selected value from the normalized Workbench document. */
export function resolveDocumentOptionValue(
  options: readonly SessionConfigOption[] | undefined,
  kind: WorkbenchOptionKind,
): string | undefined {
  if (!options) return undefined
  const option = options.find(candidate => optionKind(candidate) === kind)
  return option ? optionCurrentValue(option) : undefined
}

function preferAdvertised(
  advertised: readonly WorkbenchOptionEntry[],
  fallback: readonly WorkbenchOptionEntry[],
): readonly WorkbenchOptionEntry[] {
  return advertised.length > 0 ? advertised : fallback
}

export function resolveModelOptionEntries(snapshot: WorkbenchRuntimeSnapshot, draft?: string): readonly WorkbenchOptionEntry[] {
  const advertised = mergeEntries([
    stringsToEntries(snapshot.availableModels),
    documentOptions(snapshot, 'model'),
  ])
  return mergeEntries([
    preferAdvertised(advertised, DEFAULT_MODEL_OPTIONS),
  ], draft || snapshot.activeModel)
}

export function resolveModeOptionEntries(snapshot: WorkbenchRuntimeSnapshot, draft?: string): readonly WorkbenchOptionEntry[] {
  const advertised = mergeEntries([
    stringsToEntries(snapshot.availableModes, MODE_LABELS),
    documentOptions(snapshot, 'mode'),
  ])
  return mergeEntries([
    preferAdvertised(advertised, DEFAULT_MODE_OPTIONS),
  ], draft || snapshot.activeMode)
}

export function resolveReasoningOptionEntries(snapshot: WorkbenchRuntimeSnapshot, current?: string): readonly WorkbenchOptionEntry[] {
  const advertised = documentOptions(snapshot, 'reasoning')
  return mergeEntries([
    preferAdvertised(advertised, DEFAULT_REASONING_OPTIONS),
  ], current)
}

export function optionLabel(kind: WorkbenchOptionKind, id: string, fallback?: string): string {
  const value = id.trim()
  if (!value) return fallback ?? ''
  if (kind === 'mode') return MODE_LABELS[value.toLowerCase()] ?? fallback ?? value
  if (kind === 'reasoning') return REASONING_LABELS[value.toLowerCase()] ?? fallback ?? value
  return fallback ?? value
}

export function isReasoningOption(option: SessionConfigOption): boolean {
  return optionKind(option) === 'reasoning'
}

/**
 * Session-start model/mode/reasoning options are rendered by the control
 * center.  Keeping them out of the chat document surface prevents the ACP
 * negotiation response from becoming a second, persistent "配置 / 保存 /
 * select" form below the conversation while preserving the normalized option
 * facts for selectors and command validation.
 */
export function isControlCenterConfigOption(option: SessionConfigOption): boolean {
  const kind = optionKind(option)
  return kind === 'model' || kind === 'mode' || kind === 'reasoning'
}
