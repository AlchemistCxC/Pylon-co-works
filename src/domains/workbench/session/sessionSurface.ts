import type { JsonValue } from '../events/workbenchEventSchema.ts'

export interface UsageSnapshot {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly reasoningTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly totalTokens?: number
  readonly contextUsed?: number
  readonly contextLimit?: number
  readonly contextPercent?: number
  readonly calls?: number
  readonly costUsd?: number
  readonly currency?: string
  readonly budget?: BudgetSnapshot
  readonly raw?: Readonly<Record<string, JsonValue>>
}

export interface BudgetSnapshot {
  readonly used?: number
  readonly limit?: number
  readonly remaining?: number
  readonly type?: string
  readonly resetAt?: string
  readonly threshold?: string
  readonly percent?: number
  readonly exhausted?: boolean
}

export interface SessionCommand {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly inputHint?: string
  readonly availability?: boolean | string
  readonly capability?: string
  readonly raw?: Readonly<Record<string, JsonValue>>
}

export interface SessionConfigOption {
  readonly id: string
  readonly label: string
  readonly value?: JsonValue
  readonly valueType?: string
  readonly editable?: boolean
  readonly schema?: JsonValue
  readonly version?: number
  readonly capability?: string
  readonly raw?: Readonly<Record<string, JsonValue>>
}

export interface AssistSnapshot {
  readonly prediction?: { readonly placeholder?: string; readonly actions: readonly JsonValue[] }
  readonly files: readonly string[]
  readonly queuedCommand?: string
}

export const EMPTY_ASSIST_SNAPSHOT: AssistSnapshot = Object.freeze({ files: Object.freeze([]) })

const USAGE_NUMERIC_FIELDS = new Set([
  'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'totalTokens', 'contextUsed', 'contextLimit', 'contextPercent', 'calls', 'costUsd',
])

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalRaw(value: Record<string, JsonValue>): Readonly<Record<string, JsonValue>> | undefined {
  return Object.keys(value).length > 0 ? Object.freeze(value) : undefined
}

export function normalizeUsageSnapshot(value: unknown, previous?: UsageSnapshot): {
  readonly value: UsageSnapshot
  readonly invalidFields: readonly string[]
} {
  if (!isRecord(value)) return { value: previous ?? Object.freeze({}), invalidFields: ['usage'] }
  const next: Record<string, unknown> = { ...(previous ?? {}) }
  const raw: Record<string, JsonValue> = { ...(previous?.raw ?? {}) }
  const invalidFields: string[] = []
  for (const [key, field] of Object.entries(value)) {
    if (USAGE_NUMERIC_FIELDS.has(key)) {
      if (typeof field === 'number' && Number.isFinite(field) && field >= 0) next[key] = field
      else { raw[key] = field; invalidFields.push(key) }
      continue
    }
    if (key === 'currency') {
      if (typeof field === 'string' && field.trim()) next.currency = field
      else { raw[key] = field; invalidFields.push(key) }
      continue
    }
    raw[key] = field
  }
  const contextUsed = typeof next.contextUsed === 'number' ? next.contextUsed : undefined
  const contextLimit = typeof next.contextLimit === 'number' ? next.contextLimit : undefined
  const contextCounterChanged = 'contextUsed' in value || 'contextLimit' in value
  const explicitPercent = typeof value.contextPercent === 'number'
    && Number.isFinite(value.contextPercent) && value.contextPercent >= 0
  if (contextUsed !== undefined && contextLimit !== undefined && contextLimit > 0
    && (!explicitPercent && (contextCounterChanged || next.contextPercent === undefined))) {
    next.contextPercent = Math.min(100, contextUsed / contextLimit * 100)
  } else if (contextCounterChanged && !explicitPercent) {
    delete next.contextPercent
  }
  const retained = optionalRaw(raw)
  if (retained) next.raw = retained
  else delete next.raw
  return { value: Object.freeze(next) as UsageSnapshot, invalidFields: Object.freeze(invalidFields) }
}

export function normalizeBudgetSnapshot(input: {
  readonly used?: number; readonly limit?: number; readonly remaining?: number
  readonly budgetType?: string; readonly resetAt?: string; readonly threshold?: string
  readonly percent?: number; readonly exhausted?: boolean
}, previous?: BudgetSnapshot): BudgetSnapshot {
  const used = finiteNonNegative(input.used) ?? previous?.used
  const limit = finiteNonNegative(input.limit) ?? previous?.limit
  const remaining = finiteNonNegative(input.remaining) ?? (used !== undefined && limit !== undefined ? Math.max(0, limit - used) : previous?.remaining)
  const percent = finiteNonNegative(input.percent) ?? (used !== undefined && limit !== undefined && limit > 0 ? used / limit * 100 : previous?.percent)
  return Object.freeze({
    ...(used !== undefined ? { used } : {}), ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}), ...(input.budgetType ?? previous?.type ? { type: input.budgetType ?? previous?.type } : {}),
    ...(input.resetAt ?? previous?.resetAt ? { resetAt: input.resetAt ?? previous?.resetAt } : {}),
    ...(input.threshold ?? previous?.threshold ? { threshold: input.threshold ?? previous?.threshold } : {}),
    ...(percent !== undefined ? { percent } : {}),
    ...(typeof input.exhausted === 'boolean' ? { exhausted: input.exhausted }
      : used !== undefined && limit !== undefined ? { exhausted: used >= limit }
        : previous?.exhausted !== undefined ? { exhausted: previous.exhausted } : {}),
  })
}

export function normalizeSessionCommands(values: readonly JsonValue[]): readonly SessionCommand[] {
  return Object.freeze(values.map((value, index) => {
    if (!isRecord(value)) return Object.freeze({ id: `unknown-command-${index}`, name: `unknown-command-${index}`, raw: { value } })
    const id = stringField(value.id) ?? stringField(value.name) ?? `unknown-command-${index}`
    const name = stringField(value.name) ?? id
    const raw = withoutKeys(value, ['id', 'name', 'description', 'inputHint', 'availability', 'capability'])
    const retained = optionalRaw(raw)
    return Object.freeze({ id, name,
      ...(stringField(value.description) ? { description: stringField(value.description) } : {}),
      ...(stringField(value.inputHint) ? { inputHint: stringField(value.inputHint) } : {}),
      ...((typeof value.availability === 'boolean' || typeof value.availability === 'string') ? { availability: value.availability } : {}),
      ...(stringField(value.capability) ? { capability: stringField(value.capability) } : {}),
      ...(retained ? { raw: retained } : {}),
    })
  }))
}

export function normalizeSessionConfigOptions(values: readonly JsonValue[]): readonly SessionConfigOption[] {
  return Object.freeze(values.map((value, index) => {
    if (!isRecord(value)) return Object.freeze({ id: `unknown-option-${index}`, label: `unknown-option-${index}`, raw: { value } })
    const id = stringField(value.id) ?? `unknown-option-${index}`
    const label = stringField(value.label) ?? id
    const valueType = stringField(value.valueType)
    const optionValue = 'value' in value ? value.value : undefined
    const schema = 'schema' in value ? value.schema : undefined
    const writable = isWritableConfigOption(valueType, optionValue, schema)
    const raw = {
      ...(isRecord(value.raw) ? value.raw : {}),
      ...(!writable && 'value' in value ? { value: value.value, ...(valueType ? { valueType } : {}) } : {}),
      ...withoutKeys(value, ['id', 'label', 'value', 'valueType', 'editable', 'schema', 'version', 'capability', 'raw']),
    }
    const retained = optionalRaw(raw)
    const version = finiteNonNegative(value.version)
    return Object.freeze({ id, label,
      ...('value' in value ? { value: value.value } : {}), ...(valueType ? { valueType } : {}),
      ...(typeof value.editable === 'boolean' ? { editable: value.editable && writable } : {}), ...('schema' in value ? { schema: value.schema } : {}),
      ...(version !== undefined ? { version } : {}), ...(stringField(value.capability) ? { capability: stringField(value.capability) } : {}),
      ...(retained ? { raw: retained } : {}),
    })
  }))
}

function isWritableConfigOption(valueType: string | undefined, value: JsonValue | undefined, schema: JsonValue | undefined): boolean {
  if (valueType === 'boolean') return typeof value === 'boolean'
  if (valueType !== 'select' || typeof value !== 'string' || !isRecord(schema)) return false
  return Array.isArray(schema.options) && schema.options.length > 0
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function withoutKeys(value: Record<string, JsonValue>, keys: readonly string[]): Record<string, JsonValue> {
  const omitted = new Set(keys)
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)))
}
