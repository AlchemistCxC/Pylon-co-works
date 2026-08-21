import { describe, expect, it } from 'vitest'
import { normalizeAgentEvent, type NormalizeContext } from '../agentEventNormalizer.ts'
import { PYLON_EXTENSION_CAPABILITY, PYLON_EXTENSION_METHOD } from '../extensionNormalizer.ts'
import { makeSyntheticEnvelope } from '../normalizerSupport.ts'

function context(provider: string, sequence = 1): NormalizeContext {
  return {
    provider,
    sessionId: `${provider}-session`,
    sourceId: `${provider}-wire`,
    sequence,
    recordedAt: '2026-08-22T00:00:00.000Z',
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    negotiatedExtensions: [PYLON_EXTENSION_CAPABILITY],
  }
}

describe('generic ACP extension normalizer', () => {
  it.each(['claude-code', 'peri', 'hermes'])('uses one negotiated seam for %s', provider => {
    const result = normalizeAgentEvent({
      method: PYLON_EXTENSION_METHOD,
      params: {
        sessionId: `${provider}-session`,
        extension: { version: 1, kind: 'activity.subagent', payload: { activityId: 'child-1', status: 'running' } },
      },
    }, context(provider))
    expect(result.events[0]).toMatchObject({
      source: { provider },
      event: { type: 'extension.event', kind: 'activity.subagent', payload: { activityId: 'child-1' } },
    })
    expect(result.diagnostics).toEqual([])
  })

  it('preserves unknown versions and unnegotiated methods as unknown/raw', () => {
    const unknownVersion = normalizeAgentEvent({
      method: PYLON_EXTENSION_METHOD,
      params: { extension: { version: 2, kind: 'activity.subagent', payload: { id: 'future' } } },
    }, context('peri'))
    expect(unknownVersion.events[0].event).toMatchObject({ type: 'event.unknown', originalType: 'pylon/extension@2' })
    expect(unknownVersion.diagnostics[0]).toMatchObject({ code: 'extension.version-unsupported' })

    const unnegotiated = normalizeAgentEvent({
      method: PYLON_EXTENSION_METHOD,
      params: { extension: { version: 1, kind: 'activity.subagent', payload: { id: 'blocked' } } },
    }, { ...context('hermes'), negotiatedExtensions: [] })
    expect(unnegotiated.events[0].event.type).toBe('event.unknown')
    expect(unnegotiated.diagnostics[0]).toMatchObject({ code: 'extension.capability-unnegotiated' })
  })

  it('keeps wire sequence/provenance when extension notifications arrive out of order', () => {
    const later = normalizeAgentEvent({
      method: PYLON_EXTENSION_METHOD,
      params: { extension: { version: 1, kind: 'activity.subagent', payload: { status: 'completed' } } },
    }, context('claude-code', 8))
    const earlier = normalizeAgentEvent({
      method: PYLON_EXTENSION_METHOD,
      params: { extension: { version: 1, kind: 'activity.subagent', payload: { status: 'running' } } },
    }, context('claude-code', 7))
    expect([later.events[0].sequence, earlier.events[0].sequence]).toEqual([8, 7])
    expect(later.events[0].provenance).toEqual({ origin: 'local-observed', trust: 'authoritative' })
  })

  it('marks synthesized lifecycle with an observed order and explicit reason', () => {
    const synthetic = makeSyntheticEnvelope(
      { type: 'tool.started', tool: { toolCallId: 'orphan-1', name: 'unknown' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'orphan-1', status: 'completed' },
      context('peri'),
      { sessionUpdate: 'tool_call_update', toolCallId: 'orphan-1', status: 'completed' },
      'orphan tool result observed before start',
    )
    expect(synthetic.provenance).toMatchObject({
      origin: 'local-observed',
      trust: 'authoritative',
      orderConfidence: 'observed',
      synthetic: { reason: 'orphan tool result observed before start' },
    })
    expect(synthetic.raw).toMatchObject({ _pylonSynthetic: { reason: 'orphan tool result observed before start' } })
  })
})
