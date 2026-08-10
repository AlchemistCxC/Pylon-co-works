import { beforeEach, describe, expect, it } from 'vitest'
import { useRuntimeStore } from '../../../runtimeStore'
import {
  normalizeAgentStatus,
  selectAgentStatus,
  type AgentStatus,
  type AgentStatusPayload,
} from '../agentTypes'

/** 模拟一次后端 status 事件：先归一化再写入 store（与 App.applyAgentStatus 同一路径） */
const event = (payload: AgentStatusPayload, generation?: number): AgentStatus => ({
  ...normalizeAgentStatus(payload, 'peri'),
  generation,
})

const display = (agentId: string, activeAgent: string) =>
  selectAgentStatus(agentId, activeAgent, useRuntimeStore.getState().agentStatuses)

describe('agent status 事件矩阵（连接→失败→断开→清空 → 统一语义）', () => {
  beforeEach(() => {
    useRuntimeStore.setState({ agentStatuses: {} })
  })

  it('connected 事件 → selector 显示 connected', () => {
    useRuntimeStore.getState().setAgentStatus('peri', event({ agent: 'peri', status: 'connected' }))
    expect(display('peri', 'peri').status).toBe('connected')
  })

  it('失败事件（error + 诊断）→ 显示 error 且保留 recentError', () => {
    useRuntimeStore.getState().setAgentStatus('peri', event({ agent: 'peri', status: 'error', error: '心跳超时' }, 2))
    const shown = display('peri', 'peri')
    expect(shown.status).toBe('error')
    expect(shown.recentError).toBe('心跳超时')
  })

  it('断开事件（disconnected）→ 显示 disconnected', () => {
    useRuntimeStore.getState().setAgentStatus('peri', event({ agent: 'peri', status: 'disconnected' }))
    expect(display('peri', 'peri').status).toBe('disconnected')
  })

  it('事件序列 connected→error→disconnected：末态 disconnected，store 与 selector 读取一致', () => {
    const store = useRuntimeStore.getState()
    store.setAgentStatus('peri', event({ agent: 'peri', status: 'connected' }, 1))
    store.setAgentStatus('peri', event({ agent: 'peri', status: 'error', error: '上游错误' }, 2))
    store.setAgentStatus('peri', event({ agent: 'peri', status: 'disconnected' }, 3))

    const statuses = useRuntimeStore.getState().agentStatuses
    expect(statuses.peri.status).toBe('disconnected')
    expect(selectAgentStatus('peri', 'peri', statuses).status).toBe('disconnected')
  })

  it('切换/重启清空快照（agentStatuses 置空）→ 回到 unknown，不残留假绿', () => {
    const store = useRuntimeStore.getState()
    store.setAgentStatus('peri', event({ agent: 'peri', status: 'connected' }, 1))
    useRuntimeStore.setState({ agentStatuses: {} })

    expect(display('peri', 'peri').status).toBe('unknown')
  })

  it('非 active agent 的事件写入 store，但显示保持 inactive', () => {
    useRuntimeStore.getState().setAgentStatus('hermes', event({ agent: 'hermes', status: 'error' }))
    expect(useRuntimeStore.getState().agentStatuses.hermes.status).toBe('error')
    expect(display('hermes', 'peri').status).toBe('inactive')
  })

  it('capability hook 契约：无快照时 raw store 无记录 → 能力层按未连接 gate（InputBar 一致）', () => {
    expect(useRuntimeStore.getState().agentStatuses.peri).toBeUndefined()
  })
})
