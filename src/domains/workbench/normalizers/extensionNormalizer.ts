import { createUnknownContentPart, isValidHookSurfaceInput, type HookSurfaceSnapshot, type JsonValue } from '../content/contentPartSchema.ts'
import type { AgentWireEnvelope, NormalizeContext, NormalizeResult } from './agentEventNormalizer.ts'
import { createDiagnostic, createUnknownEvent, isRecord, makeEnvelope } from './normalizerSupport.ts'

export const PYLON_EXTENSION_METHOD = 'pylon/extension'
export const PYLON_EXTENSION_CAPABILITY = 'pylon.extension.v1'
export const PYLON_EXTENSION_VERSION = 1

export function isPylonExtension(input: AgentWireEnvelope | unknown): boolean {
  return isRecord(input) && input.method === PYLON_EXTENSION_METHOD
}

/** One provider-neutral namespaced extension seam on the existing ACP connection. */
export function normalizePylonExtension(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  const root = isRecord(input) ? input : {}
  const params = isRecord(root.params) ? root.params : {}
  const extension = isRecord(params.extension) ? params.extension : undefined
  const capabilityKnown = context.negotiatedExtensions?.includes(PYLON_EXTENSION_CAPABILITY) === true
  if (!capabilityKnown) {
    return unknown(input, context, extension, 'extension.capability-unnegotiated', 'Pylon extension capability was not negotiated')
  }
  if (!extension) return unknown(input, context, undefined, 'extension.payload-invalid', 'Pylon extension payload is missing')
  const version = extension.version
  if (version !== PYLON_EXTENSION_VERSION) {
    return unknown(input, context, extension, 'extension.version-unsupported', `Unsupported Pylon extension version: ${String(version)}`, `pylon/extension@${String(version)}`)
  }
  const kind = typeof extension.kind === 'string' ? extension.kind.trim() : ''
  if (!kind.includes('.') || kind.startsWith('.') || kind.endsWith('.')) {
    return unknown(input, context, extension, 'extension.kind-invalid', 'Pylon extension kind must be namespaced')
  }
  if (kind === 'system.hook') {
    const normalized = normalizeHookPayload(extension.payload)
    if (!normalized) {
      const safeInput = safeExtensionWire(kind, { omitted: true, reason: 'invalid-system-hook' })
      return unknown(safeInput, context, extension, 'extension.hook-invalid', 'system.hook payload is invalid', kind)
    }
    const payload = normalized.snapshot
    const jsonPayload = payload as unknown as JsonValue
    const fallback = [createUnknownContentPart(kind, jsonPayload)]
    return {
      events: [makeEnvelope({ type: 'extension.event', kind, payload: jsonPayload, fallback }, safeExtensionWire(kind, jsonPayload), context, undefined)],
      diagnostics: normalized.sanitized
        ? [createDiagnostic(context, extension, 'extension.hook-sanitized', 'Hook input or sensitive metadata was omitted', ['params', 'extension', 'payload'], true)]
        : [],
    }
  }
  const payloadSnapshot = createUnknownContentPart(kind, extension.payload, { maxRawBytes: 32 * 1024 })
  const payload = payloadSnapshot.raw
  const fallback = [payloadSnapshot]
  const diagnostics = payloadSnapshot.truncated || payloadSnapshot.redactions?.length
    ? [createDiagnostic(context, extension, 'extension.payload-sanitized', 'Extension payload was redacted or truncated', ['params', 'extension', 'payload'], true)]
    : []
  return {
    events: [makeEnvelope({ type: 'extension.event', kind: kind as `${string}.${string}`, payload, fallback }, safeExtensionWire(kind, payload), context, undefined)],
    diagnostics,
  }
}

function normalizeHookPayload(value: unknown): { snapshot: HookSurfaceSnapshot; sanitized: boolean } | undefined {
  if (!isRecord(value)) return undefined
  const owner = isRecord(value.owner) ? value.owner : {}
  const error = isRecord(value.error) && typeof value.error.message === 'string' && value.error.message.trim()
    ? { message: value.error.message.trim(), ...(typeof value.error.code === 'string' && value.error.code.trim() ? { code: value.error.code.trim() } : {}) }
    : undefined
  const known = new Set(['phase', 'owner', 'status', 'durationMs', 'duration_ms', 'decision', 'error'])
  const entries = Object.entries(value)
  const forbiddenFields = entries.filter(([key]) => !known.has(key) && isForbiddenHookField(key))
  const unknownFields = Object.fromEntries(entries.filter(([key]) => !known.has(key) && !isForbiddenHookField(key)))
  const rawSnapshot = Object.keys(unknownFields).length > 0
    ? createUnknownContentPart('system.hook.metadata', unknownFields, { maxRawBytes: 8 * 1024 })
    : undefined
  const safeRaw = rawSnapshot?.raw
  const candidate = {
    phase: typeof value.phase === 'string' ? value.phase.trim() : '',
    owner: {
      pluginId: typeof owner.pluginId === 'string' ? owner.pluginId.trim() : '',
      ...(typeof owner.runtimeInstanceId === 'string' && owner.runtimeInstanceId.trim() ? { runtimeInstanceId: owner.runtimeInstanceId.trim() } : {}),
      handlerId: typeof owner.handlerId === 'string' ? owner.handlerId.trim() : '',
    },
    status: typeof value.status === 'string' ? value.status.trim() : '',
    ...(typeof (value.durationMs ?? value.duration_ms) === 'number' ? { durationMs: value.durationMs ?? value.duration_ms } : {}),
    ...(typeof value.decision === 'string' && value.decision.trim() ? { decision: value.decision.trim() } : {}),
    ...(error ? { error } : {}),
    ...(safeRaw !== undefined && isRecord(safeRaw) ? { raw: safeRaw as Readonly<Record<string, JsonValue>> } : {}),
  }
  return isValidHookSurfaceInput(candidate)
    ? { snapshot: candidate, sanitized: forbiddenFields.length > 0 || Boolean(rawSnapshot?.truncated || rawSnapshot?.redactions?.length) }
    : undefined
}

const HOOK_FORBIDDEN_FIELDS = new Set(['input', 'event', 'credential', 'credentials', 'secret', 'token', 'password', 'authorization', 'cookie'])

function isForbiddenHookField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '')
  return HOOK_FORBIDDEN_FIELDS.has(normalized) || normalized.includes('input')
    || normalized.startsWith('event') || normalized.endsWith('event')
}

function safeExtensionWire(kind: string, payload: unknown): Record<string, unknown> {
  return { method: PYLON_EXTENSION_METHOD, params: { extension: { version: PYLON_EXTENSION_VERSION, kind, payload } } }
}

function unknown(
  input: AgentWireEnvelope | unknown,
  context: NormalizeContext,
  extension: Record<string, unknown> | undefined,
  code: string,
  message: string,
  originalType = PYLON_EXTENSION_METHOD,
): NormalizeResult {
  return {
    events: [makeEnvelope(createUnknownEvent(input, undefined, originalType), input, context, undefined)],
    diagnostics: [createDiagnostic(context, extension, code, message, ['params', 'extension'], true)],
  }
}
