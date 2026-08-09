// @vitest-environment jsdom
/**
 * useAgentCapabilities 消费行为测试（I02-A-TEST-01 / ISSUE-02 6.3 #10 等级 1）：
 * 基础文本只依赖 lifecycle；图片只依赖 promptImage；能力未知时扩展项保守禁用。
 * 覆盖 connected、缺失 status、非法 capabilities、旧代际 的状态矩阵在 store→快照链路的映射。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAgentCapabilities } from '../useAgentCapabilities'
import { useRuntimeStore } from '../../../runtimeStore'
import { useIdentityStore } from '../../../identityStore'
import type { AgentStatus } from '../../../components/settings/agentTypes'

function status(partial: Partial<AgentStatus>): AgentStatus {
  return {
    agent: 'peri',
    agentId: 'peri',
    status: 'connected',
    ...partial,
  }
}

describe('useAgentCapabilities（I02-A-TEST-01 状态矩阵）', () => {
  beforeEach(() => {
    useRuntimeStore.setState({ agentStatuses: {} })
    useIdentityStore.setState({ activeAgent: 'peri' })
  })

  it('connected + null capabilities → connected 且基础文本可用（能力未确认）', () => {
    useRuntimeStore.setState({ agentStatuses: { peri: status({ capabilities: null }) } })
    const { result } = renderHook(() => useAgentCapabilities('peri'))
    expect(result.current.connected).toBe(true)
    expect(result.current.capabilitiesKnown).toBe(false)
  })

  it('connected + 缺失 capabilities → 同上，连接不被能力缺失反推', () => {
    useRuntimeStore.setState({ agentStatuses: { peri: status({}) } })
    const { result } = renderHook(() => useAgentCapabilities('peri'))
    expect(result.current.connected).toBe(true)
    expect(result.current.capabilitiesKnown).toBe(false)
  })

  it('connected + capabilities 对象 → 能力已协商，promptImage 独立决定图片 gate', () => {
    useRuntimeStore.setState({
      agentStatuses: { peri: status({ capabilities: { promptCapabilities: { image: true } } }) },
    })
    const { result } = renderHook(() => useAgentCapabilities('peri'))
    expect(result.current.connected).toBe(true)
    expect(result.current.capabilitiesKnown).toBe(true)
    expect(result.current.promptImage).toBe(true)
  })

  it.each(['connecting', 'reconnecting', 'disconnected', 'crashed', 'error', 'inactive', 'unknown'] as const)(
    '旧代际：status %s 携带旧 capabilities → 快照 connected=false（功能 gate 保守关闭）',
    (s) => {
      useRuntimeStore.setState({
        agentStatuses: { peri: status({ status: s, capabilities: { promptCapabilities: { image: true } } }) },
      })
      const { result } = renderHook(() => useAgentCapabilities('peri'))
      expect(result.current.connected).toBe(false)
    },
  )

  it('缺失 status（store 无该 agent）→ 快照 connected=false', () => {
    const { result } = renderHook(() => useAgentCapabilities('peri'))
    expect(result.current.connected).toBe(false)
    expect(result.current.capabilitiesKnown).toBe(false)
  })

  it('非法 capabilities 形状（字符串）→ capabilitiesKnown=false，不崩溃', () => {
    useRuntimeStore.setState({
      agentStatuses: { peri: status({ capabilities: 'stale' as unknown }) },
    })
    const { result } = renderHook(() => useAgentCapabilities('peri'))
    expect(result.current.capabilitiesKnown).toBe(false)
    expect(result.current.promptImage).toBe(false)
  })
})
