import {
  coalesceAdjacentDisplayTextParts,
  createUnknownContentPart,
  type ContentPart,
  type JsonValue,
} from '../content/contentPartSchema.ts'
import {
  createWorkbenchEnvelope,
  type WorkbenchEventEnvelope,
  type WorkbenchEventIdentity,
  type WorkbenchEventProvenance,
  type WorkbenchSemanticEvent,
} from '../events/workbenchEventSchema.ts'
import type { NormalizeContext, NormalizeDiagnostic } from './agentEventNormalizer.ts'

/** wire 对象判型的 normalizers 共享出口：单一实现在 utils/wireGuards。 */
import { isRecord } from '../../../utils/wireGuards.ts'
export { isRecord }

// B-8b：content block 语义归一（normalizeContentBlock 及其 content 族处理函数/校验帮助）
// 已拆至 contentBlockNormalizers；此处 re-export 维持 normalizerSupport 既有公开面。
export { normalizeContentBlock } from './contentBlockNormalizers.ts'
import { normalizeContentBlock } from './contentBlockNormalizers.ts'


export function extractUpdate(input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined
  const params = isRecord(input.params) ? input.params : undefined
  const paramsUpdate = params?.update
  if (isRecord(paramsUpdate)) return paramsUpdate
  if (isRecord(input.update)) return input.update
  // ACP SDKs have used all of these discriminator spellings. Keep extraction
  // aligned with the canonicalizers so a valid bare update is not reported as
  // a malformed envelope merely because it came from a snake_case/legacy
  // bridge. `type` is intentionally included last: JSON-RPC wrappers may use
  // it for unrelated metadata, while an update with an ACP payload is still
  // safely handled by the normalizer's unknown-event fallback.
  const updateKeys = ['sessionUpdate', 'session_update', 'updateType', 'update_type', 'eventType', 'event_type', 'type'] as const
  if (updateKeys.some(key => typeof input[key] === 'string')) return input
  if (params && updateKeys.some(key => typeof params[key] === 'string')) return params
  return undefined
}

export function wireKind(update: Record<string, unknown> | undefined): string {
  const value = update?.sessionUpdate
    ?? update?.session_update
    ?? update?.updateType
    ?? update?.update_type
    ?? update?.eventType
    ?? update?.event_type
    ?? update?.type
  return typeof value === 'string' && value.trim() ? value : 'malformed'
}

export function identityFromUpdate(update: Record<string, unknown> | undefined): WorkbenchEventIdentity {
  if (!update) return {}
  const content = isRecord(update.content) ? update.content : undefined
  const meta = isRecord(update._meta) ? update._meta : undefined
  const pick = (keys: readonly string[], records: readonly (Record<string, unknown> | undefined)[]): string | undefined => {
    for (const record of records) {
      for (const key of keys) {
        const value = record?.[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
    return undefined
  }
  const identity: WorkbenchEventIdentity = {
    ...(pick(['turnId', 'turn_id'], [content, update, meta]) ? { turnId: pick(['turnId', 'turn_id'], [content, update, meta]) } : {}),
    ...(pick(['messageId', 'message_id'], [content, update, meta]) ? { messageId: pick(['messageId', 'message_id'], [content, update, meta]) } : {}),
    ...(pick(['toolCallId', 'tool_call_id', 'toolUseId', 'tool_use_id'], [update, content, meta]) ? { toolCallId: pick(['toolCallId', 'tool_call_id', 'toolUseId', 'tool_use_id'], [update, content, meta]) } : {}),
    ...(pick(['taskId', 'task_id'], [content, update, meta]) ? { taskId: pick(['taskId', 'task_id'], [content, update, meta]) } : {}),
    ...(pick(['runId', 'run_id'], [content, update, meta]) ? { runId: pick(['runId', 'run_id'], [content, update, meta]) } : {}),
    ...(pick(['interactionId', 'interaction_id', 'requestId', 'request_id'], [content, update, meta]) ? { interactionId: pick(['interactionId', 'interaction_id', 'requestId', 'request_id'], [content, update, meta]) } : {}),
    // Claude's parentToolUseId describes the tool/agent edge, not the current
    // event's task identity.  ClaudeCodeNormalizer promotes it to
    // `source.parentAgentId` and `event.tool.parentToolUseId`; mapping it to
    // identity.taskId here makes the child look like a new activity and can
    // split/overwrite projector state.  Keep the shared ACP identity provider-
    // neutral and never infer task ids from vendor metadata.
  }
  return identity
}


export function createDiagnostic(
  context: NormalizeContext,
  update: Record<string, unknown> | undefined,
  code: string,
  message: string,
  path: readonly (string | number)[] = [],
  recoverable = true,
): NormalizeDiagnostic {
  return {
    provider: context.provider,
    sessionId: context.sessionId,
    wireKind: wireKind(update),
    path,
    code,
    message,
    recoverable,
  }
}

export function normalizeContentBlocks(
  raw: unknown,
  context: NormalizeContext,
  update: Record<string, unknown> | undefined,
): { parts: ContentPart[]; diagnostics: NormalizeDiagnostic[] } {
  const blocks = Array.isArray(raw) ? raw : raw === undefined ? [] : typeof raw === 'string' ? [{ type: 'text', text: raw }] : [raw]
  const parts: ContentPart[] = []
  const diagnostics: NormalizeDiagnostic[] = []
  blocks.forEach((block, index) => {
    const normalized = normalizeContentBlock(block)
    parts.push(normalized.part)
    if (normalized.diagnostic) diagnostics.push({
      ...createDiagnostic(context, update, normalized.diagnostic.code, normalized.diagnostic.message, ['content', index, ...normalized.diagnostic.path]),
      recoverable: true,
    })
  })
  return { parts: [...coalesceAdjacentDisplayTextParts(parts)], diagnostics }
}

export function createUnknownEvent(
  input: unknown,
  update: Record<string, unknown> | undefined,
  originalType = wireKind(update),
): WorkbenchSemanticEvent {
  const unknown = createUnknownContentPart(originalType, input)
  return {
    type: 'event.unknown',
    originalType,
    summary: unknown.summary,
    raw: unknown.raw,
    truncated: unknown.truncated,
    ...(unknown.truncation ? { truncation: unknown.truncation } : {}),
  }
}

export function makeEnvelope(
  event: WorkbenchSemanticEvent,
  input: unknown,
  context: NormalizeContext,
  update: Record<string, unknown> | undefined,
  provenancePatch: Partial<WorkbenchEventProvenance> = {},
  identity = identityFromUpdate(update),
): WorkbenchEventEnvelope {
  const source = isRecord(input) && typeof input.source === 'string' ? input.source : context.sourceId
  return createWorkbenchEnvelope({
    sessionId: context.sessionId,
    sequence: context.sequence,
    recordedAt: context.recordedAt,
    ...(context.occurredAt ? { occurredAt: context.occurredAt } : {}),
    source: {
      provider: context.provider,
      sourceId: source,
      ...(context.agentId ? { agentId: context.agentId } : {}),
      ...(context.parentAgentId ? { parentAgentId: context.parentAgentId } : {}),
    },
    identity,
    provenance: { ...context.provenance, ...provenancePatch },
    event,
    raw: input,
  })
}

export function makeSyntheticEnvelope(
  event: WorkbenchSemanticEvent,
  input: unknown,
  context: NormalizeContext,
  update: Record<string, unknown> | undefined,
  reason: string,
): WorkbenchEventEnvelope {
  const normalizedReason = reason.trim()
  if (!normalizedReason) throw new Error('Synthetic event reason must be non-empty')
  const rawInput = isRecord(input)
    ? { ...input, _pylonSynthetic: { reason: normalizedReason } }
    : { observed: toJsonValue(input), _pylonSynthetic: { reason: normalizedReason } }
  return makeEnvelope(event, rawInput, context, update, {
    orderConfidence: 'observed',
    synthetic: { reason: normalizedReason },
  })
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJsonValue(child)]))
  return String(value)
}