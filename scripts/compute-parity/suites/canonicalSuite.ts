// canonical 域套件：词表/判别符映射/owner key/event id/sequence 原语。
// TS 侧全部是树上活实现（eventSchema.ts / canonicalNormalizer.ts）。

import type { Suite } from '../harness.ts'
import type { ComputeContext } from '../index.ts'
import { CANONICAL_EVENT_TYPES, nextEventSequence, toCanonicalEventId, toCanonicalOwnerKey, type CanonicalEventOwner } from '../../../src/domains/events/eventSchema.ts'
import { canonicalEventTypeFor } from '../../../src/domains/events/canonicalNormalizer.ts'

const SESSION_UPDATES = [
  'user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk',
  'tool_call', 'tool_call_update', 'plan', 'done', 'error', 'cancelled',
  'current_mode_update', 'config_options', 'session_info', null, undefined,
  'brand_new_discriminator',
] as const

const STATUSES = [undefined, null, 'completed', 'failed', 'running', 'pending'] as const

export function buildCanonicalSuite(ctx: ComputeContext): Suite {
  const wasm = ctx.compute
  return {
    domain: 'canonical',
    pairs: [
      {
        name: 'canonicalEventTypes',
        domain: 'canonical',
        ts: () => CANONICAL_EVENT_TYPES,
        wasm: () => wasm.canonicalEventTypes(),
        cases: [
          { id: 'wordlist-order', meta: { shape: 'wordlist' }, build: () => undefined },
        ],
      },
      {
        name: 'canonicalEventTypeFor',
        domain: 'canonical',
        ts: combos => combos.map(([sessionUpdate, status]) => canonicalEventTypeFor(sessionUpdate, status)),
        wasm: combos => combos.map(([sessionUpdate, status]) => wasm.canonicalEventTypeFor(sessionUpdate, status)),
        cases: [
          {
            id: 'discriminator-x-status-matrix',
            meta: { shape: 'matrix' },
            build: () => SESSION_UPDATES.flatMap(sessionUpdate => STATUSES.map(status => [sessionUpdate, status] as const)),
          },
        ],
      },
      {
        name: 'isCanonicalEventType',
        domain: 'canonical',
        ts: values => values.map(value => (CANONICAL_EVENT_TYPES as readonly string[]).includes(value)),
        wasm: values => values.map(value => wasm.isCanonicalEventType(value)),
        cases: [
          {
            id: 'members-and-outsiders',
            meta: { shape: 'wordlist', edge: true },
            build: () => [
              ...CANONICAL_EVENT_TYPES,
              'event.unknown', 'not.an.event', '', 'USER.MESSAGE', 'user.message ',
            ],
          },
        ],
      },
      {
        name: 'canonicalOwnerKey',
        domain: 'canonical',
        ts: owners => owners.map(owner => toCanonicalOwnerKey(owner)),
        wasm: owners => owners.map(owner => wasm.canonicalOwnerKey(owner.profileId, owner.agentId, owner.localSessionId)),
        cases: [
          {
            id: 'owner-triples',
            meta: { shape: 'ids' },
            build: () => [
              { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' },
              { profileId: '', agentId: '', localSessionId: '' },
              { profileId: 'a:b', agentId: 'c:d', localSessionId: 'e:f' } as CanonicalEventOwner,
              { profileId: '中文', agentId: '🤖', localSessionId: 'sess-0' } as CanonicalEventOwner,
            ],
          },
        ],
      },
      {
        name: 'canonicalEventId',
        domain: 'canonical',
        // TS 侧 = toCanonicalOwnerKey + toCanonicalEventId 组合；wasm 侧 =
        // canonicalOwnerKey + canonicalEventId 组合（两侧各自用同域出口拼装）。
        ts: inputs => inputs.map(([owner, sequence]) => toCanonicalEventId(owner, sequence)),
        wasm: inputs => inputs.map(([owner, sequence]) =>
          wasm.canonicalEventId(wasm.canonicalOwnerKey(owner.profileId, owner.agentId, owner.localSessionId), sequence)),
        cases: [
          {
            id: 'sequence-values',
            meta: { shape: 'ids', edge: true },
            build: () => [
              { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' },
              { profileId: '', agentId: '', localSessionId: '' },
              { profileId: 'a:b', agentId: 'c:d', localSessionId: 'e:f' },
            ].flatMap(owner => [1, 0, Number.MAX_SAFE_INTEGER].map(sequence => [owner, sequence] as const)),
          },
        ],
      },
      {
        name: 'nextEventSequence',
        domain: 'canonical',
        ts: previouses => previouses.map(previous => nextEventSequence(previous)),
        wasm: previouses => previouses.map(previous => wasm.nextEventSequence(previous)),
        cases: [
          {
            id: 'previous-values',
            meta: { shape: 'numbers', edge: true },
            build: () => [undefined, null, 0, 1, 4096, Number.MAX_SAFE_INTEGER],
          },
        ],
      },
    ],
  }
}
