/**
 * Session response projection: ACP model/mode metadata -> Workbench envelope.
 * No stores, IPC, subscriptions or session lifecycle state. The caller owns
 * ordering and deduplication; persisted field names and provenance stay intact.
 */
import { createWorkbenchEnvelope, type JsonValue, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'
import { extractChoiceId, extractChoiceLabel, extractConfigOptionId, extractModeConfig, extractModelConfig, type SessionResponseObject } from '../../infrastructure/acp/chatContracts.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseChoice(value: unknown, kind?: 'model' | 'mode'): { id: string; label: string } | undefined {
  const id = extractChoiceId(value, kind)
  if (!id) return undefined
  return { id, label: extractChoiceLabel(value, id) ?? id }
}

function toJsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 8) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const items = value.map(item => toJsonValue(item, depth + 1)).filter((item): item is JsonValue => item !== undefined)
    return items
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const json = toJsonValue(item, depth + 1)
      if (json !== undefined) result[key] = json
    }
    return result
  }
  return undefined
}

function responseChoiceList(value: unknown): readonly { id: string; label: string }[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const choices: Array<{ id: string; label: string }> = []
  for (const item of value) {
    const choice = responseChoice(item)
    if (!choice || seen.has(choice.id.toLowerCase())) continue
    seen.add(choice.id.toLowerCase())
    choices.push(choice)
  }
  return choices
}

function syntheticSessionOption(
  kind: 'model' | 'mode',
  response: SessionResponseObject,
): Record<string, JsonValue> | undefined {
  const selectionState = kind === 'model' ? response.models : response.modes
  if (!selectionState) return undefined
  // Keep the discriminant on the original response instead of indexing the
  // `SessionModels | SessionModes` union through a conditional state variable;
  // this also makes the two wire shapes explicit for future schema additions.
  const rawChoices = kind === 'model'
    ? response.models?.availableModels ?? response.models?.available_models
    : response.modes?.availableModes ?? response.modes?.available_modes
  const choices = responseChoiceList(rawChoices)
  const current = kind === 'model'
    ? extractModelConfig(response.configOptions, response).model
    : extractModeConfig(response).mode
  if (!current && choices.length === 0) return undefined
  const schema: Record<string, JsonValue> = {
    options: choices.map(choice => ({ id: choice.id, label: choice.label })),
  }
  return {
    id: kind,
    label: kind === 'model' ? '模型' : '模式',
    valueType: 'select',
    editable: true,
    ...(current ? { value: current } : {}),
    schema,
  }
}

function optionId(value: unknown): string | undefined {
  return extractConfigOptionId(value)
}

function mergeSessionResponseOptions(response: SessionResponseObject): readonly JsonValue[] {
  const options: JsonValue[] = (Array.isArray(response.configOptions)
    ? response.configOptions
    : Array.isArray(response.config_options) ? response.config_options : [])
    .map(item => toJsonValue(item))
    .filter((item): item is JsonValue => item !== undefined)
  for (const synthetic of [syntheticSessionOption('model', response), syntheticSessionOption('mode', response)]) {
    if (!synthetic) continue
    const syntheticId = String(synthetic.id).toLowerCase()
    const index = options.findIndex(item => optionId(item)?.toLowerCase() === syntheticId)
    if (index < 0) {
      options.push(synthetic)
      continue
    }
    const existing = options[index]
    if (!isRecord(existing)) continue
    const merged: Record<string, JsonValue> = { ...existing }
    // Preserve provider metadata, but ensure the standard models/modes state
    // supplies choices/current value when the provider's config option omitted
    // them.  This gives every renderer one canonical selector surface.
    if (!('value' in merged) && 'value' in synthetic) merged.value = synthetic.value!
    if (!('valueType' in merged) && 'valueType' in synthetic) merged.valueType = synthetic.valueType!
    if (!('schema' in merged) && 'schema' in synthetic) merged.schema = synthetic.schema!
    options[index] = merged
  }
  return Object.freeze(options)
}

export function sessionResponseProjectionKey(response: SessionResponseObject): string {
  try {
    return JSON.stringify({
      models: response.models,
      modes: response.modes,
      configOptions: response.configOptions ?? response.config_options,
    })
  } catch {
    return String(response)
  }
}

function shortHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function createSessionResponseEnvelope(
  sessionId: string,
  provider: string,
  response: SessionResponseObject,
  sequence: number,
): WorkbenchEventEnvelope {
  const model = extractModelConfig(response.configOptions, response).model
  const mode = extractModeConfig(response).mode
  const options = mergeSessionResponseOptions(response)
  const fingerprint = shortHash(sessionResponseProjectionKey(response))
  return createWorkbenchEnvelope({
    eventId: `session-response:${sessionId}:${fingerprint}`,
    sessionId,
    sequence: Math.max(1, sequence),
    recordedAt: new Date().toISOString(),
    source: { provider: provider || 'acp', sourceId: `session-response:${fingerprint}` },
    identity: { runId: `session-response:${fingerprint}` },
    provenance: {
      origin: 'local-observed',
      trust: 'authoritative',
      provider: provider || 'acp',
      orderConfidence: 'observed',
      synthetic: { reason: 'session-new-response' },
    },
    event: {
      type: 'session.started',
      status: 'ready',
      ...(model ? { model } : {}),
      ...(mode ? { mode } : {}),
      ...(options.length > 0 ? { options } : {}),
    },
  })
}

