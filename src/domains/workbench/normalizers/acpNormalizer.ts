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

  const normalized = semanticEventForUpdate(update, context)
  const event = makeEnvelope(normalized.event, input, context, update, {}, identityFromUpdate(update))
  return { events: [event], diagnostics: normalized.diagnostics }
}

function semanticEventForUpdate(update: Record<string, unknown>, context: NormalizeContext): { event: WorkbenchSemanticEvent; diagnostics: ReturnType<typeof createDiagnostic>[] } {
  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined
  const diagnostics: ReturnType<typeof createDiagnostic>[] = []
  const content = update.content
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
      const status = typeof update.status === 'string' ? update.status : 'in_progress'
      const type = status === 'completed' ? 'tool.completed' : status === 'failed' || status === 'error' ? 'tool.failed' : 'tool.progress'
      return { event: { type, tool: toolPayload(update, normalizedBlocks.parts, context), ...(update.rawOutput !== undefined ? { result: toJsonValue(update.rawOutput) } : {}) }, diagnostics: withToolNameDiagnostic(diagnostics, update, context) }
    }
    case 'plan':
      // C08：entries 结构化收窄为五状态 PlanEntryV2（cancelled 不坍缩、未知状态保留 rawStatus），
      // id 按 显式 id > itemId > content 派生，非 object 条目丢弃。
      return { event: { type: 'plan.replaced', entries: normalizePlanEntries(update.entries) as unknown as readonly JsonValue[] }, diagnostics }
    case 'usage_update':
      return { event: { type: 'usage.updated', usage: toJsonValue({ inputTokens: update.used ?? update.value, contextLimit: update.size, ...toJsonRecord(update.usage) }) }, diagnostics }
    case 'available_commands_update':
      return { event: { type: 'session.commands-updated', commands: Array.isArray(update.commands) ? update.commands.map(toJsonValue) : [] }, diagnostics }
    case 'config_option_update':
      return { event: { type: 'session.config-updated', options: Array.isArray(update.configOptions) ? update.configOptions.map(toJsonValue) : [toJsonValue(update)] }, diagnostics }
    case 'session_info_update':
      return { event: { type: 'session.status-updated', status: typeof update.mode === 'string' ? update.mode : 'updated' }, diagnostics }
    case 'done':
      return { event: { type: 'session.completed', stopReason: typeof update.stopReason === 'string' ? update.stopReason : undefined }, diagnostics }
    case 'error': {
      const message = typeof update.error === 'string' ? update.error : typeof update.message === 'string' ? update.message : 'provider reported an error'
      return { event: { type: 'diagnostic.notice', level: 'error', message, ...(typeof update.errorCode === 'string' ? { code: update.errorCode } : {}) }, diagnostics: [...diagnostics, createDiagnostic(context, update, 'provider.error', message, ['error'], true)] }
    }
    default:
      diagnostics.push(createDiagnostic(context, update, 'wire.unknown', `unknown ACP session update: ${wireKind(update)}`, ['sessionUpdate'], true))
      return { event: createUnknownEvent(update, update, wireKind(update)), diagnostics }
  }
}

function toolPayload(update: Record<string, unknown>, parts: readonly unknown[], context: NormalizeContext): Record<string, JsonValue> {
  const meta = isRecord(update._meta) ? update._meta : undefined
  const pylonMeta = isRecord(meta?.pylon) ? meta.pylon : undefined
  const claudeMeta = isRecord(meta?.claudeCode) ? meta.claudeCode : undefined
  const name = typeof pylonMeta?.toolName === 'string' && pylonMeta.toolName.trim()
    ? pylonMeta.toolName.trim()
    : typeof update.name === 'string' && update.name.trim() ? update.name.trim() : 'unknown'
  const semantic = resolveToolSemantic(context.provider, name, context.toolGeneration)
  const resolution = resolveToolType(name, typeof update.kind === 'string' ? update.kind : undefined, {
    provider: context.provider,
    generation: context.toolGeneration,
  })
  return {
    toolCallId: toJsonValue(identityFromUpdate(update).toolCallId ?? ''),
    name: name,
    canonicalName: semantic?.name ?? resolution.canonicalName,
    kind: resolution.kind,
    action: resolution.action,
    semanticKind: `tool.${resolution.kind}`,
    provider: resolution.provider,
    ...(typeof update.title === 'string' ? { title: update.title } : {}),
    ...(resolution.capabilities ? { capabilities: toJsonValue(resolution.capabilities) } : {}),
    ...(update.rawInput !== undefined ? { rawInput: toJsonValue(update.rawInput) } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: toJsonValue(update.rawOutput) } : {}),
    ...(typeof update.status === 'string' ? { status: update.status } : {}),
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
  const pylon = isRecord(meta?.pylon) ? meta.pylon : undefined
  const hasName = (typeof pylon?.toolName === 'string' && pylon.toolName.trim()) || (typeof update.name === 'string' && update.name.trim())
  return hasName ? diagnostics : [...diagnostics, createDiagnostic(context, update, 'tool.name.missing', 'tool_call is missing _meta.pylon.toolName; generic tool fallback used', ['_meta', 'pylon', 'toolName'], true)]
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}
