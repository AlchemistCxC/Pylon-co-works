import { beforeEach, describe, expect, it } from 'vitest'
import { useRuntimeStore } from '../../../runtimeStore'
import { runReconnectCommand } from '../reconnectCommand'
import type { AgentStatus } from '../agentTypes'

const status = (
  lifecycle: AgentStatus['status'],
  generation?: number,
  capabilities?: unknown,
): AgentStatus => ({
  agent: 'peri',
  agentId: 'peri',
  status: lifecycle,
  generation,
  capabilities,
})

describe('reconnect interleaving regression (AC-1)', () => {
  beforeEach(() => {
    useRuntimeStore.setState({ agentStatuses: {} })
  })

  it('connected event arriving early survives a late command rejection (catch 晚到)', async () => {
    useRuntimeStore.getState().setAgentStatus('peri', status('connected', 4, { promptCapabilities: { image: true } }))

    // backend 在 command 未决期间先广播了更新的 connected 事件
    useRuntimeStore.getState().setAgentStatus('peri', status('connected', 5, { promptCapabilities: { image: true, audio: true } }))

    // command 随后 reject；对账 agent_status 返回权威快照
    const commandError = new Error('command rejected')
    const rejected = await runReconnectCommand({
      reconnect: async () => { throw commandError },
      readSnapshot: async () => status('connected', 5, { promptCapabilities: { image: true, audio: true } }),
      applySnapshot: snapshot => useRuntimeStore.getState().setAgentStatus('peri', snapshot),
    })

    expect(rejected).toEqual({ commandError })
    const final = useRuntimeStore.getState().agentStatuses.peri
    expect(final.status).toBe('connected')
    expect(final.generation).toBe(5)
    expect(final.capabilities).toMatchObject({ promptCapabilities: { audio: true } })
  })

  it('accepted command does not overwrite a connected event that arrived first (connected 早到)', async () => {
    useRuntimeStore.getState().setAgentStatus('peri', status('connected', 4))

    const result = await runReconnectCommand({
      reconnect: async () => undefined,
      readSnapshot: async () => status('disconnected', 4),
      applySnapshot: snapshot => useRuntimeStore.getState().setAgentStatus('peri', snapshot),
    })

    expect(result).toEqual({})
    expect(useRuntimeStore.getState().agentStatuses.peri.status).toBe('connected')
  })

  it('stale capabilities do not leak into a reconciled snapshot (旧 capabilities 残留)', async () => {
    useRuntimeStore.getState().setAgentStatus('peri', status('connected', 4, { promptCapabilities: { image: true } }))

    const rejected = await runReconnectCommand({
      reconnect: async () => { throw new Error('command rejected') },
      readSnapshot: async () => status('disconnected', 5, null),
      applySnapshot: snapshot => useRuntimeStore.getState().setAgentStatus('peri', snapshot),
    })

    expect(rejected.commandError).toBeInstanceOf(Error)
    const final = useRuntimeStore.getState().agentStatuses.peri
    expect(final.status).toBe('disconnected')
    expect(final.generation).toBe(5)
    expect(final.capabilities).toBeNull()
  })

  it('late catch cannot roll back a newer authoritative snapshot via stale reconciliation', async () => {
    useRuntimeStore.getState().setAgentStatus('peri', status('connected', 5, { promptCapabilities: { image: true } }))

    const rejected = await runReconnectCommand({
      reconnect: async () => { throw new Error('command rejected') },
      // 对账读到的是旧代际快照
      readSnapshot: async () => status('disconnected', 4, null),
      applySnapshot: snapshot => useRuntimeStore.getState().setAgentStatus('peri', snapshot),
    })

    expect(rejected.commandError).toBeInstanceOf(Error)
    const final = useRuntimeStore.getState().agentStatuses.peri
    expect(final.status).toBe('connected')
    expect(final.generation).toBe(5)
  })
})
