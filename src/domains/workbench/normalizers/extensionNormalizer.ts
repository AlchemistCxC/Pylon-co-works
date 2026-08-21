import { createUnknownContentPart } from '../content/contentPartSchema.ts'
import type { AgentWireEnvelope, NormalizeContext, NormalizeResult } from './agentEventNormalizer.ts'
import { createDiagnostic, createUnknownEvent, isRecord, makeEnvelope, toJsonValue } from './normalizerSupport.ts'

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
  const payload = toJsonValue(extension.payload)
  const fallback = [createUnknownContentPart(kind, payload)]
  return {
    events: [makeEnvelope({ type: 'extension.event', kind: kind as `${string}.${string}`, payload, fallback }, input, context, undefined)],
    diagnostics: [],
  }
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
