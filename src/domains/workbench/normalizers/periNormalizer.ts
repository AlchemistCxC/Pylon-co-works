import type { AgentEventNormalizer, AgentWireEnvelope, NormalizeContext, NormalizeResult } from './agentEventNormalizer.ts'
import { normalizeAcpEvent } from './acpNormalizer.ts'
import { createDiagnostic, extractUpdate, makeEnvelope, wireKind } from './normalizerSupport.ts'
import type { WorkbenchEventEnvelope } from '../events/workbenchEventSchema.ts'

export const periNormalizer: AgentEventNormalizer = {
  id: 'peri',
  canNormalize: (_input, context) => context.provider.toLowerCase() === 'peri',
  normalize: normalizePeriEvent,
}

export function normalizePeriEvent(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  const update = extractUpdate(input)
  const kind = wireKind(update)
  if (kind === 'unstable-event' || kind === 'peri/unstable-event') {
    const diagnostic = createDiagnostic(context, update, 'peri.unstable-event', 'Peri unstable event is diagnostic-only and does not enter the timeline', ['sessionUpdate'], true)
    if (!context.observe) return { events: [], diagnostics: [diagnostic] }
    return {
      events: [makeEnvelope({ type: 'diagnostic.notice', level: 'info', message: diagnostic.message, code: diagnostic.code }, input, context, update)],
      diagnostics: [diagnostic],
    }
  }
  const result = normalizeAcpEvent(input, context)
  if (!context.seenEventKeys) return result
  const events = [] as typeof result.events[number][]
  const diagnostics = [...result.diagnostics]
  for (const event of result.events) {
    const key = stableEventKey(event)
    if (!key) {
      events.push(event)
      continue
    }
    if (context.seenEventKeys.has(key)) {
      diagnostics.push(createDiagnostic(context, update, 'duplicate.identity', 'duplicate Peri event identity ignored', ['identity'], true))
      continue
    }
    context.seenEventKeys.add(key)
    events.push(event)
  }
  return { events, diagnostics }
}

function stableEventKey(event: WorkbenchEventEnvelope): string | undefined {
  if (Object.keys(event.identity).length === 0) return undefined
  return JSON.stringify([event.source.provider, event.source.sourceId, event.identity, event.event.type])
}
