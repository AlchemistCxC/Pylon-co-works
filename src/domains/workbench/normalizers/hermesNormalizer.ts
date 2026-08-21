import type { AgentEventNormalizer, AgentWireEnvelope, NormalizeContext, NormalizeResult } from './agentEventNormalizer.ts'
import { normalizeAcpEvent } from './acpNormalizer.ts'
import { createDiagnostic, createUnknownEvent, extractUpdate, makeEnvelope, wireKind } from './normalizerSupport.ts'

export const hermesNormalizer: AgentEventNormalizer = {
  id: 'hermes',
  canNormalize: (_input, context) => context.provider.toLowerCase() === 'hermes',
  normalize: normalizeHermesEvent,
}

export function normalizeHermesEvent(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  const update = extractUpdate(input)
  const kind = wireKind(update)
  if (kind === 'delegate' || kind === 'delegation' || kind === 'media') {
    const diagnostic = createDiagnostic(context, update, 'hermes.incomplete-extension', 'Hermes extension lacks a complete semantic payload; preserved as unknown', ['payload'], true)
    return {
      events: [makeEnvelope(createUnknownEvent(input, update, kind), input, context, update, { orderConfidence: context.replay ? 'grouped' : 'observed' })],
      diagnostics: [diagnostic],
    }
  }
  const result = normalizeAcpEvent(input, context)
  const grouped = context.groupedReplay ?? context.replay ?? isGroupedReplay(update)
  if (!grouped) return result
  return {
    events: result.events.map(event => ({
      ...event,
      provenance: {
        ...event.provenance,
        orderConfidence: 'grouped' as const,
        collectionComplete: event.provenance.collectionComplete ?? true,
      },
    })),
    diagnostics: result.diagnostics,
  }
}

function isGroupedReplay(update: Record<string, unknown> | undefined): boolean {
  const meta = update?._meta
  return typeof meta === 'object' && meta !== null && (meta as Record<string, unknown>).hermesReplay === true
}
