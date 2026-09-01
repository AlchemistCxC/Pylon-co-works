import type { AgentEventNormalizer, AgentWireEnvelope, NormalizeContext, NormalizeResult } from './agentEventNormalizer.ts'
import type { JsonValue } from '../content/contentPartSchema.ts'
import {
  createDiagnostic,
  createUnknownEvent,
  extractUpdate,
  identityFromUpdate,
  isRecord,
  makeEnvelope,
  normalizeContentBlocks,
  toJsonValue,
  wireKind,
} from './normalizerSupport.ts'
import { resolveToolSemantic } from '../../tool/toolRegistry.ts'
import { resolveToolType } from '../../tool/toolResolution.ts'
import { normalizePlanEntries } from '../plan/goalModel.ts'
import type { WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'
import {
  extractConfigOptionChoices,
  extractConfigOptionId,
  extractConfigOptionValue,
} from '../../../infrastructure/acp/chatContracts.ts'

export const acpNormalizer: AgentEventNormalizer = {
  id: 'acp',
  canNormalize: (_input, context) => !['hermes', 'claude', 'claude-code', 'peri'].includes(context.provider.toLowerCase()),
  normalize: normalizeAcpEvent,
}

export function normalizeAcpEvent(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  const update = extractUpdate(input)
  if (!update) {
    return {
      events: [makeEnvelope(createUnknownEvent(input, undefined, 'malformed'), input, context, undefined)],
      diagnostics: [createDiagnostic(context, undefined, 'wire.malformed', 'wire envelope has no object update', [], false)],
    }
  }

  // A few ACP bridges wrap tool fields in `toolCall`/`tool_call` while keeping the
  // discriminator at the top level.  Flatten that transport envelope at the seam;
  // raw input is still retained unchanged by makeEnvelope for diagnostics.
  const effectiveUpdate = flattenAcpUpdate(update)
  const normalized = semanticEventForUpdate(effectiveUpdate, context)
  const event = makeEnvelope(normalized.event, input, context, update, {}, identityFromUpdate(effectiveUpdate))
  return { events: [event], diagnostics: normalized.diagnostics }
}

function semanticEventForUpdate(update: Record<string, unknown>, context: NormalizeContext): { event: WorkbenchSemanticEvent; diagnostics: ReturnType<typeof createDiagnostic>[] } {
  const sessionUpdate = canonicalSessionUpdate(update)
  const diagnostics: ReturnType<typeof createDiagnostic>[] = []
  const content = update.content ?? update.parts ?? update.blocks ?? update.output
  const blocks = content !== undefined ? content : typeof update.text === 'string' ? { type: 'text', text: update.text } : undefined
  const normalizedBlocks = blocks === undefined ? { parts: [], diagnostics: [] } : normalizeContentBlocks(blocks, context, update)
  diagnostics.push(...normalizedBlocks.diagnostics)

  switch (sessionUpdate) {
    case 'user_message_chunk':
      return { event: { type: 'message.delta', role: 'user', parts: normalizedBlocks.parts }, diagnostics }
    case 'agent_message_chunk':
      return { event: { type: 'message.delta', role: 'assistant', parts: normalizedBlocks.parts }, diagnostics }
    case 'agent_thought_chunk':
      return { event: { type: 'reasoning.delta', parts: normalizedBlocks.parts }, diagnostics }
    case 'tool_call':
      return { event: { type: 'tool.started', tool: toolPayload(update, normalizedBlocks.parts, context) }, diagnostics: withToolNameDiagnostic(diagnostics, update, context) }
    case 'tool_call_update': {
      const status = stringField(wireField(update, ['status', 'state'])) ?? 'in_progress'
      const type = status === 'completed' ? 'tool.completed' : status === 'failed' || status === 'error' ? 'tool.failed' : 'tool.progress'
      // Hermes completion updates intentionally omit the machine name; the
      // projector merges them into the started card by toolCallId. Do not
      // manufacture `unknown` here or a completion would overwrite the
      // previously resolved skill/search identity.
      const rawOutput = wireField(update, ['rawOutput', 'raw_output', 'output', 'result', 'toolResult', 'tool_result'])
      return { event: { type, tool: toolPayload(update, normalizedBlocks.parts, context), ...(rawOutput !== undefined ? { result: toJsonValue(rawOutput) } : {}) }, diagnostics }
    }
    case 'plan':
      // C08：entries 结构化收窄为五状态 PlanEntryV2（cancelled 不坍缩、未知状态保留 rawStatus），
      // id 按 显式 id > itemId > content 派生，非 object 条目丢弃。
      return { event: { type: 'plan.replaced', entries: normalizePlanEntries(update.entries) as unknown as readonly JsonValue[] }, diagnostics }
    case 'usage_update':
      return { event: { type: 'usage.updated', usage: toJsonValue(normalizeUsageUpdate(update)) }, diagnostics }
    case 'available_commands_update':
      return { event: { type: 'session.commands-updated', commands: normalizeAvailableCommands(update.commands) }, diagnostics }
    case 'config_option_update':
      return { event: { type: 'session.config-updated', options: normalizeConfigOptions(update) }, diagnostics }
    case 'session_info_update':
      return { event: { type: 'session.status-updated', status: typeof update.mode === 'string' ? update.mode : 'updated' }, diagnostics }
    case 'done':
      return { event: { type: 'session.completed', stopReason: typeof update.stopReason === 'string' ? update.stopReason : undefined }, diagnostics }
    case 'error': {
      const message = typeof update.error === 'string' ? update.error : typeof update.message === 'string' ? update.message : typeof update.errorMessage === 'string' ? update.errorMessage : 'provider reported an error'
      // The semantic code drives projector convergence. Provider-specific error
      // detail remains available in raw/normalizer diagnostics.
      return { event: { type: 'diagnostic.notice', level: 'error', message, code: 'provider.error' }, diagnostics: [...diagnostics, createDiagnostic(context, update, 'provider.error', message, ['error'], true)] }
    }
    default:
      diagnostics.push(createDiagnostic(context, update, 'wire.unknown', `unknown ACP session update: ${wireKind(update)}`, ['sessionUpdate'], true))
      return { event: createUnknownEvent(update, update, wireKind(update)), diagnostics }
  }
}

function flattenAcpUpdate(update: Record<string, unknown>): Record<string, unknown> {
  const nested = [update.toolCall, update.tool_call, update.toolCallUpdate, update.tool_call_update]
    .find(isRecord)
  if (!nested) return update
  return { ...nested, ...update }
}

/** Accept the spelling variants used by ACP SDKs and provider bridges. */
function canonicalSessionUpdate(update: Record<string, unknown>): string | undefined {
  const raw = update.sessionUpdate ?? update.session_update ?? update.updateType ?? update.update_type ?? update.type
  if (typeof raw !== 'string') return undefined
  const normalized = raw.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase()
  const aliases: Record<string, string> = {
    assistant_message_chunk: 'agent_message_chunk',
    message_chunk: 'agent_message_chunk',
    thinking_chunk: 'agent_thought_chunk',
    reasoning_chunk: 'agent_thought_chunk',
    tool_call_start: 'tool_call',
    tool_call_started: 'tool_call',
    tool_call_progress: 'tool_call_update',
    tool_call_completed: 'tool_call_update',
    tool_call_result: 'tool_call_update',
    usage: 'usage_update',
    commands_update: 'available_commands_update',
    config_update: 'config_option_update',
  }
  return aliases[normalized] ?? normalized
}

function toolPayload(update: Record<string, unknown>, parts: readonly unknown[], context: NormalizeContext): Record<string, JsonValue> {
  const meta = isRecord(update._meta) ? update._meta : undefined
  const pylonCandidate = meta?.pylon
  const claudeCandidate = meta?.claudeCode
  const pylonMeta = isRecord(pylonCandidate) ? pylonCandidate : undefined
  const claudeMeta = isRecord(claudeCandidate) ? claudeCandidate : undefined
  const name = typeof pylonMeta?.toolName === 'string' && pylonMeta.toolName.trim()
    ? pylonMeta.toolName.trim()
    : typeof pylonMeta?.tool_name === 'string' && pylonMeta.tool_name.trim()
      ? pylonMeta.tool_name.trim()
      : typeof update.name === 'string' && update.name.trim() ? update.name.trim()
        : typeof update.toolName === 'string' && update.toolName.trim() ? update.toolName.trim() : 'unknown'
  const hasMachineName = name !== 'unknown'
  const updateKind = canonicalSessionUpdate(update)
  const omitMissingUpdateIdentity = updateKind === 'tool_call_update' && !hasMachineName
  const providerName = typeof update.name === 'string' && update.name.trim()
    ? update.name.trim()
    : typeof update.toolName === 'string' && update.toolName.trim() ? update.toolName.trim() : name
  const semantic = resolveToolSemantic(context.provider, name, context.toolGeneration)
  const resolution = resolveToolType(name, typeof update.kind === 'string' ? update.kind : undefined, {
    provider: context.provider,
    generation: context.toolGeneration,
  })
  const normalizedInput = wireField(update, ['input', 'rawInput', 'raw_input', 'args', 'arguments', 'parameters', 'toolInput', 'tool_input'])
  const rawInput = wireField(update, ['rawInput', 'raw_input', 'input', 'args', 'arguments', 'parameters'])
  const rawOutput = wireField(update, ['rawOutput', 'raw_output', 'output', 'result', 'toolResult', 'tool_result'])
  const locations = wireField(update, ['locations', 'location'])
  const progress = wireField(update, ['progress', 'progressData', 'progress_data'])
  const duration = wireField(update, ['durationMs', 'duration_ms', 'elapsedMs', 'elapsed_ms'])
  const error = wireField(update, ['error', 'toolError', 'tool_error'])
  return {
    toolCallId: toJsonValue(identityFromUpdate(update).toolCallId ?? ''),
    ...(!omitMissingUpdateIdentity ? { name } : {}),
    ...(!omitMissingUpdateIdentity ? { providerName } : {}),
    ...(!omitMissingUpdateIdentity ? { canonicalName: semantic?.name ?? resolution.canonicalName } : {}),
    kind: resolution.kind,
    action: resolution.action,
    semanticKind: `tool.${resolution.kind}`,
    provider: resolution.provider,
    ...(typeof update.title === 'string' ? { title: update.title } : typeof update.label === 'string' ? { title: update.label } : {}),
    ...(resolution.capabilities ? { capabilities: toJsonValue(resolution.capabilities) } : {}),
    ...(normalizedInput !== undefined ? { input: toJsonValue(normalizedInput) } : {}),
    ...(rawInput !== undefined ? { rawInput: toJsonValue(rawInput) } : {}),
    ...(rawOutput !== undefined ? { rawOutput: toJsonValue(rawOutput) } : {}),
    ...(locations !== undefined ? { locations: toJsonValue(Array.isArray(locations) ? locations : [locations]) } : {}),
    ...(progress !== undefined ? { progress: toJsonValue(progress) } : {}),
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0
      ? { durationMs: duration }
      : {}),
    ...(error !== undefined ? { error: toJsonValue(error) } : {}),
    ...(typeof update.status === 'string' ? { status: update.status } : typeof update.state === 'string' ? { status: update.state } : {}),
    ...(parts.length > 0 ? { parts: toJsonValue(parts) } : {}),
    ...(typeof claudeMeta?.parentToolUseId === 'string' ? { parentToolUseId: claudeMeta.parentToolUseId } : {}),
  }
}

function withToolNameDiagnostic(
  diagnostics: ReturnType<typeof createDiagnostic>[],
  update: Record<string, unknown>,
  context: NormalizeContext,
): ReturnType<typeof createDiagnostic>[] {
  const meta = isRecord(update._meta) ? update._meta : undefined
  const pylonCandidate = meta?.pylon
  const pylon = isRecord(pylonCandidate) ? pylonCandidate : undefined
  const hasName = (typeof pylon?.toolName === 'string' && pylon.toolName.trim()) || (typeof update.name === 'string' && update.name.trim())
  return hasName ? diagnostics : [...diagnostics, createDiagnostic(context, update, 'tool.name.missing', 'tool_call is missing _meta.pylon.toolName; generic tool fallback used', ['_meta', 'pylon', 'toolName'], true)]
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function normalizeUsageUpdate(update: Record<string, unknown>): Record<string, unknown> {
  const meta = isRecord(update._meta) ? update._meta : {}
  const usage = toJsonRecord(update.usage)
  const cost = isRecord(update.cost) ? update.cost : {}
  return {
    ...usage,
    ...(finiteNonNegative(meta.inputTokens) !== undefined ? { inputTokens: meta.inputTokens } : {}),
    ...(finiteNonNegative(meta.outputTokens) !== undefined ? { outputTokens: meta.outputTokens } : {}),
    ...(finiteNonNegative(meta.cacheReadTokens) !== undefined ? { cacheReadTokens: meta.cacheReadTokens } : {}),
    ...(finiteNonNegative(update.used ?? update.value) !== undefined ? { contextUsed: update.used ?? update.value } : {}),
    ...(finiteNonNegative(update.size) !== undefined ? { contextLimit: update.size } : {}),
    ...(finiteNonNegative(cost.amount) !== undefined ? { costUsd: cost.amount } : {}),
    ...(stringField(cost.currency) ? { currency: cost.currency } : {}),
  }
}

function normalizeAvailableCommands(value: unknown): readonly JsonValue[] {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    if (!isRecord(item)) return toJsonValue(item)
    const wireName = stringField(item.name) ?? `unknown-command-${index}`
    return toJsonValue({
      id: stringField(item.id) ?? wireName.replace(/^\//, ''),
      name: wireName.startsWith('/') ? wireName : `/${wireName}`,
      ...(stringField(item.description) ? { description: item.description } : {}),
      ...(stringField(item.inputHint ?? item.input_hint) ? { inputHint: item.inputHint ?? item.input_hint } : {}),
      ...((typeof item.availability === 'boolean' || typeof item.availability === 'string') ? { availability: item.availability } : {}),
      ...(stringField(item.capability) ? { capability: item.capability } : {}),
      ...unknownWireFields(item, ['id', 'name', 'description', 'inputHint', 'input_hint', 'availability', 'capability']),
    })
  })
}

function normalizeConfigOptions(update: Record<string, unknown>): readonly JsonValue[] {
  const values = Array.isArray(update.configOptions)
    ? update.configOptions
    : Array.isArray(update.config_options)
      ? update.config_options
      : [update]
  return values.map((item, index) => {
    if (!isRecord(item)) return toJsonValue(item)
    const id = extractConfigOptionId(item) ?? `unknown-option-${index}`
    const choices = extractConfigOptionChoices(item)
    const hasValue = hasWireField(item, [
      'currentValue', 'current_value', 'value', 'current', 'selected',
      'selectedValue', 'selected_value', 'defaultValue', 'default_value',
    ])
    const value = hasValue ? extractConfigOptionValue(item) ?? null : null
    const valueType = stringField(wireField(item, ['valueType', 'value_type', 'type']))
    const editable = (typeof item.editable === 'boolean' ? item.editable : item.readOnly !== true)
      && isAcpWritableConfigValue(valueType, value)
      && item.readonly !== true && item.read_only !== true
    const unknown = unknownWireFields(item, [
      'id', 'key', 'configId', 'config_id', 'optionId', 'option_id', 'name', 'label', 'title', 'description', 'category',
      'currentValue', 'current_value', 'value', 'current', 'selected', 'selectedValue', 'selected_value', 'defaultValue', 'default_value',
      'valueType', 'value_type', 'type', 'editable', 'readOnly', 'readonly', 'read_only',
      'options', 'choices', 'values', 'available', 'items', 'schema', 'version', 'capability', 'raw',
    ])
    const retainedRaw = {
      ...(isRecord(item.raw) ? item.raw : {}),
      ...(!isAcpWritableConfigValue(valueType, value) && hasValue ? { value, ...(valueType ? { valueType } : {}) } : {}),
      ...unknown,
    }
    const schema = wireField(item, ['schema'])
    return toJsonValue({
      id,
      label: stringField(wireField(item, ['label', 'name', 'title'])) ?? id,
      ...(hasValue
        ? { value } : {}),
      ...(valueType ? { valueType } : {}),
      editable,
      ...(choices.length > 0 ? { schema: { options: choices } } : schema !== undefined ? { schema } : {}),
      ...(finiteNonNegative(wireField(item, ['version'])) !== undefined ? { version: wireField(item, ['version']) } : {}),
      ...(stringField(item.capability) ? { capability: item.capability } : {}),
      ...(Object.keys(retainedRaw).length > 0 ? { raw: retainedRaw } : {}),
    })
  })
}

function isAcpWritableConfigValue(valueType: string | undefined, value: unknown): boolean {
  const type = valueType?.toLowerCase()
  return type === 'boolean' || type === 'bool' ? typeof value === 'boolean'
    : type === 'select' || type === 'enum' ? typeof value === 'string'
      : false
}

function normalizedWireKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase()
}

function wireField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  const wanted = new Set(keys.map(normalizedWireKey))
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(normalizedWireKey(key))) return value
  }
  return undefined
}

function hasWireField(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const wanted = new Set(keys.map(normalizedWireKey))
  return Object.keys(record).some(key => wanted.has(normalizedWireKey(key)))
}

function unknownWireFields(value: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const names = new Set(known)
  return Object.fromEntries(Object.entries(value).filter(([key]) => !names.has(key)))
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
