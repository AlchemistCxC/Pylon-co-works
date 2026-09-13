import { beforeEach, describe, expect, it } from 'vitest'
import { useRuntimeStore } from '../../../runtimeStore.ts'
import { agentAdvertisedModelEntries } from '../agentAdvertisedModels.ts'

const agentA = { agentId: 'agent-a', source: 'ws://a/session-1' }
const agentASecondSession = { agentId: 'agent-a', source: 'ws://a/session-2' }
const agentB = { agentId: 'agent-b', source: 'ws://b/session-1' }

describe('agentAdvertisedModelEntries', () => {
  beforeEach(() => {
    useRuntimeStore.setState({ sessionConfig: {} })
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
})
