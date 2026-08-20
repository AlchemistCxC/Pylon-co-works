import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAgentRegistriesForTests,
  getAgentDescriptor,
  getAgentInstance,
  listAgentDescriptors,
  listAgentInstances,
  registerAgentDescriptor,
  registerInteractionAdapter,
  replaceAgentInstances,
  resolveAgentInteraction,
  resolveAgentTool,
} from '../agentRegistry.ts'
import type { AgentDescriptor } from '../agentContracts.ts'

afterEach(() => clearAgentRegistriesForTests())

const descriptor: AgentDescriptor = {
  provider: 'new-agent',
  displayName: 'New Agent',
  protocol: 'custom',
  capabilities: {
    sessionUpdates: true,
    interactionEvents: true,
    permissionRequests: false,
    replay: true,
    responseMethods: ['question.respond'],
  },
  tools: [{ name: 'inspect_repo', kind: 'read', action: 'read', aliases: ['repo_inspect'] }],
  interactionKinds: ['ask-question'],
}

describe('Agent registry', () => {
  it('按 provider 隔离新 Agent 工具字典，并保留 canonical name', () => {
    registerAgentDescriptor(descriptor)
    expect(getAgentDescriptor('new-agent')).toEqual(descriptor)
    expect(listAgentDescriptors()).toHaveLength(1)
    expect(resolveAgentTool({ provider: 'new-agent', name: 'repo_inspect' })).toMatchObject({
      kind: 'read', action: 'read', canonicalName: 'inspect_repo', provider: 'new-agent', matchedBy: 'provider-dictionary',
    })
  })

  it('未注册 provider 仍走通用 wire/fallback，不阻塞未知 Agent', () => {
    expect(resolveAgentTool({ provider: 'future-agent', name: 'run_shell', wireKind: 'execute' })).toMatchObject({
      kind: 'execute', action: 'execute', matchedBy: 'wire',
    })
  })

  it('同 provider 的多个 agentId 绑定独立实例，reload 原子替换且不串', () => {
    registerAgentDescriptor({ ...descriptor, provider: 'shared-provider', displayName: 'Shared' })
    const entries = replaceAgentInstances([
      { id: 'agent-a', name: 'A', provider: 'shared-provider' },
      { id: 'agent-b', name: 'B', provider: 'shared-provider' },
    ])
    expect(entries).toHaveLength(2)
    expect(getAgentInstance('agent-a')).toMatchObject({ agentId: 'agent-a', provider: 'shared-provider', state: 'ready' })
    expect(getAgentInstance('agent-b')).toMatchObject({ agentId: 'agent-b', provider: 'shared-provider', state: 'ready' })
    expect(resolveAgentTool({ agentId: 'agent-a', name: 'repo_inspect' })).toMatchObject({ provider: 'shared-provider', kind: 'read' })

    replaceAgentInstances([{ id: 'agent-b', name: 'B', provider: 'shared-provider' }])
    expect(getAgentInstance('agent-a')).toBeNull()
    expect(listAgentInstances()).toHaveLength(1)
  })

  it('配置缺失 provider 或 provider 未注册时进入 degraded，不静默冒充 ready', () => {
    expect(replaceAgentInstances([
      { id: 'broken', name: 'Broken' },
      { id: 'future', name: 'Future', provider: 'future-provider' },
    ])).toMatchObject([
      { agentId: 'broken', state: 'degraded', issue: 'invalid-instance' },
      { agentId: 'future', state: 'degraded', issue: 'provider-unregistered' },
    ])
  })

  it('provider adapter 优先于通用 interaction normalizer', () => {
    registerInteractionAdapter({
      id: 'new-agent-question',
      provider: 'new-agent',
      canHandle: input => input.eventType === 'new.question',
      normalize: input => ({
        surface: 'interaction', kind: 'ask-question',
        identity: { provider: null, agentId: null, requestId: 'new-1', sessionId: 's1', toolCallId: null, clientGeneration: null },
        questions: [], state: 'waiting', eventType: input.eventType,
      }),
      responseMethodFor: kind => kind === 'ask-question' ? 'question.respond' : null,
    })
    expect(resolveAgentInteraction({ provider: 'new-agent', eventType: 'new.question', payload: {} })).toMatchObject({
      kind: 'ask-question', identity: { provider: null, agentId: null, requestId: 'new-1' },
    })
  })
})
