import { beforeEach, describe, expect, it } from 'vitest'
import { useRuntimeStore } from '../../../domains/runtime/runtimeStore.ts'
import {
  agentAdvertisedModelEntries,
  markProbeUnavailable,
  noteAgentSelectorsSnapshot,
  resetAgentProbeForTests,
} from '../agentAdvertisedModels.ts'

const agentA = { agentId: 'agent-a', source: 'ws://a/session-1' }
const agentASecondSession = { agentId: 'agent-a', source: 'ws://a/session-2' }
const agentB = { agentId: 'agent-b', source: 'ws://b/session-1' }

describe('agentAdvertisedModelEntries', () => {
  beforeEach(() => {
    useRuntimeStore.setState({ sessionConfig: {} })
    resetAgentProbeForTests()
  })

  it('returns the advertised modelChoices (id/label) of the owning agent', () => {
    useRuntimeStore.getState().setSessionConfig(agentA, {
      modelChoices: [
        { id: 'nous:hermes-4', label: 'Nous · hermes-4' },
        { id: 'kimi-k2', label: 'Kimi K2' },
      ],
      models: ['nous:hermes-4', 'kimi-k2'],
    })
    expect(agentAdvertisedModelEntries('agent-a')).toEqual([
      { id: 'nous:hermes-4', label: 'Nous · hermes-4' },
      { id: 'kimi-k2', label: 'Kimi K2' },
    ])
  })

  it('does not leak another agent’s buckets (issue #53 A5)', () => {
    useRuntimeStore.getState().setSessionConfig(agentA, { models: ['a-model'] })
    useRuntimeStore.getState().setSessionConfig(agentB, {
      modelChoices: [{ id: 'b-model', label: 'B Model' }],
    })
    expect(agentAdvertisedModelEntries('agent-a').map(entry => entry.id)).toEqual(['a-model'])
    expect(agentAdvertisedModelEntries('agent-b').map(entry => entry.id)).toEqual(['b-model'])
  })

  it('unions the agent’s per-session buckets first-seen, falling back to plain ids', () => {
    useRuntimeStore.getState().setSessionConfig(agentA, { models: ['shared-model', 'a-only'] })
    useRuntimeStore.getState().setSessionConfig(agentASecondSession, {
      modelChoices: [
        { id: 'shared-model' },
        { id: 'newer-model', label: 'Newer Model' },
      ],
    })
    expect(agentAdvertisedModelEntries('agent-a')).toEqual([
      { id: 'shared-model', label: 'shared-model' },
      { id: 'a-only', label: 'a-only' },
      { id: 'newer-model', label: 'Newer Model' },
    ])
  })

  it('returns an empty frozen list when the agent never advertised', () => {
    const entries = agentAdvertisedModelEntries('agent-unknown')
    expect(entries).toEqual([])
    expect(Object.isFrozen(entries)).toBe(true)
  })

  it('keeps snapshot identity across unrelated store writes and refreshes on config writes', () => {
    useRuntimeStore.getState().setSessionConfig(agentA, { models: ['first'] })
    const first = agentAdvertisedModelEntries('agent-a')
    expect(agentAdvertisedModelEntries('agent-a')).toBe(first)

    useRuntimeStore.getState().setSessionLiveStats(agentA, { commands: [] })
    expect(agentAdvertisedModelEntries('agent-a')).toBe(first)

    useRuntimeStore.getState().setSessionConfig(agentA, { models: ['second'] })
    const second = agentAdvertisedModelEntries('agent-a')
    expect(second).not.toBe(first)
    expect(second.map(entry => entry.id)).toEqual(['second'])
  })

  it('keeps each mounted agent snapshot stable across interleaved reads', () => {
    useRuntimeStore.getState().setSessionConfig(agentA, { models: ['a-model'] })
    useRuntimeStore.getState().setSessionConfig(agentB, { models: ['b-model'] })
    const firstA = agentAdvertisedModelEntries('agent-a')
    const firstB = agentAdvertisedModelEntries('agent-b')
    for (let index = 0; index < 20; index += 1) {
      expect(agentAdvertisedModelEntries('agent-a')).toBe(firstA)
      expect(agentAdvertisedModelEntries('agent-b')).toBe(firstB)
    }
    useRuntimeStore.getState().setSessionConfig(agentB, { models: ['new-b'] })
    const nextA = agentAdvertisedModelEntries('agent-a')
    const nextB = agentAdvertisedModelEntries('agent-b')
    expect(nextA).toEqual(firstA)
    expect(nextB.map(entry => entry.id)).toEqual(['new-b'])
    expect(agentAdvertisedModelEntries('agent-a')).toBe(nextA)
    expect(agentAdvertisedModelEntries('agent-b')).toBe(nextB)
  })

  // —— #53：空态探测结果并入（探测 label 为权威形状，压在历史桶之上）——

  it('merges probed candidates over the bucket union with probe labels winning', () => {
    useRuntimeStore.getState().setSessionConfig(agentA, { models: ['shared-model', 'a-only'] })
    noteAgentSelectorsSnapshot('agent-a', {
      configOptions: [
        {
          id: 'model-selection',
          category: 'model',
          options: [
            { valueId: 'shared-model', name: 'Shared (probed)' },
            { valueId: 'probed-only', name: 'Probed Only' },
          ],
          currentValue: 'shared-model',
        },
      ],
    })
    const entries = agentAdvertisedModelEntries('agent-a')
    // 同 id 冲突：探测条目在桶的既有位置上覆盖（Map 语义），新 id 追加在后。
    expect(entries.map(entry => entry.id)).toEqual(['shared-model', 'a-only', 'probed-only'])
    expect(entries.find(entry => entry.id === 'shared-model')?.label).toBe('Shared (probed)')
    expect(entries.find(entry => entry.id === 'probed-only')?.label).toBe('Probed Only')
  })

  it('falls back to snapshot modelChoices ids when no standard option is advertised', () => {
    noteAgentSelectorsSnapshot('agent-a', { modelChoices: ['raw-id-1', 'raw-id-2'] })
    expect(agentAdvertisedModelEntries('agent-a')).toEqual([
      { id: 'raw-id-1', label: 'raw-id-1' },
      { id: 'raw-id-2', label: 'raw-id-2' },
    ])
  })

  it('reports no candidates when the agent advertises nothing (empty is valid)', () => {
    noteAgentSelectorsSnapshot('agent-a', { configOptions: [] })
    expect(agentAdvertisedModelEntries('agent-a')).toEqual([])
  })

  it('probe failure keeps the bucket-union fallback without poisoning the cache', () => {
    useRuntimeStore.getState().setSessionConfig(agentA, { models: ['a-model'] })
    markProbeUnavailable('agent-a')
    expect(agentAdvertisedModelEntries('agent-a').map(entry => entry.id)).toEqual(['a-model'])
  })
})
