import type { ConfigOption } from '../chat/acpTypes'

export interface FullConfigOptionEventState {
  source: string
  kind: 'full'
  configOptions: ConfigOption[]
}

export interface SingleConfigOptionEventState {
  source: string
  kind: 'single'
  configOption: ConfigOption
}

export type ConfigOptionEventState = FullConfigOptionEventState | SingleConfigOptionEventState

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isConfigOption(value: unknown): value is ConfigOption {
  return isRecord(value)
    && (nonEmptyString(value.id) || nonEmptyString(value.key) || nonEmptyString(value.name))
}

function hasSingleValue(value: UnknownRecord): boolean {
  return Object.prototype.hasOwnProperty.call(value, 'currentValue')
    || Object.prototype.hasOwnProperty.call(value, 'value')
}

/**
 * Normalizes the frontend boundary only; it deliberately does not subscribe to
 * or dispatch any real command/event listener.
 *
 * A non-empty configOptions array is authoritative. A single option is kept as
 * an explicitly tagged compatibility shape and is never promoted to a list.
 */
export function normalizeConfigOptionUpdatePayload(payload: unknown): ConfigOptionEventState | null {
  if (!isRecord(payload) || !nonEmptyString(payload.source)) return null

  const source = payload.source.trim()
  const update = isRecord(payload.update) ? payload.update : payload
  const eventName = update.sessionUpdate ?? update.event ?? payload.sessionUpdate ?? payload.event
  if (eventName !== 'config_option_update') return null

  const rawOptions = update.configOptions ?? payload.configOptions
  if (Array.isArray(rawOptions)) {
    if (rawOptions.length === 0 || !rawOptions.every(isConfigOption)) return null
    return { source, kind: 'full', configOptions: rawOptions as ConfigOption[] }
  }

  const rawSingle: UnknownRecord = {}
  for (const key of ['id', 'key', 'name', 'type', 'currentValue', 'value', 'current', 'selected', 'options', 'choices', 'values', 'available']) {
    if (Object.prototype.hasOwnProperty.call(update, key)) rawSingle[key] = update[key]
  }
  if (Object.keys(rawSingle).length === 0 && update !== payload) {
    for (const key of ['id', 'key', 'name', 'type', 'currentValue', 'value', 'current', 'selected', 'options', 'choices', 'values', 'available']) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) rawSingle[key] = payload[key]
    }
  }

  if (!(nonEmptyString(rawSingle.id) || nonEmptyString(rawSingle.key)) || !hasSingleValue(rawSingle)) return null
  return { source, kind: 'single', configOption: rawSingle as ConfigOption }
}
