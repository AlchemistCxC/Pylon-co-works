import { describe, expect, it } from 'vitest'
import {
  normalizeAgentStatus,
  selectAgentStatus,
  statusLabel,
  type AgentConnectionStatus,
  type AgentStatus,
} from '../agentTypes'

describe('normalizeAgentStatus — 状态缺失/非法归一化矩阵（ISSUE-03 §6.4 L1）', () => {
  it('payload 缺少 status 且未 crashed → unknown，不再默认 connected（不出现假绿）', () => {
    const result = normalizeAgentStatus({ agent: 'peri' }, 'peri')
    expect(result.status).toBe('unknown')
    expect(result.status).not.toBe('connected')
    expect(result.recentError).toBeUndefined()
  })

  it('payload 缺少 status 且 crashed=true → crashed（缺失与崩溃不混淆）', () => {
    const result = normalizeAgentStatus({ agent: 'peri', crashed: true }, 'peri')
    expect(result.status).toBe('crashed')
  })

  it('空 payload 且无 fallbackAgent → unknown 且 agent 为空串', () => {
    const result = normalizeAgentStatus({})
    expect(result.status).toBe('unknown')
    expect(result.agent).toBe('')
  })

  it.each<[AgentConnectionStatus]>([
    ['connected'],
    ['connecting'],
    ['reconnecting'],
    ['disconnected'],
    ['error'],
    ['crashed'],
    ['inactive'],
  ])('合法状态 %s 原样透传', status => {
    expect(normalizeAgentStatus({ agent: 'peri', status }, 'peri').status).toBe(status)
  })

  it('非法字符串（如 paused）→ error，recentError 携带原始值诊断', () => {
    const result = normalizeAgentStatus({ agent: 'peri', status: 'paused' }, 'peri')
    expect(result.status).toBe('error')
    expect(result.recentError).toBe('未知 Agent 状态：paused')
  })

  it('显式下发 unknown 字符串按非法处理 → error（unknown 仅由 selector 合成，不进入 knownStatus）', () => {
    const result = normalizeAgentStatus({ agent: 'peri', status: 'unknown' }, 'peri')
    expect(result.status).toBe('error')
  })

  it('失败事件：payload.error 透传为 recentError 诊断', () => {
    const result = normalizeAgentStatus({ agent: 'peri', status: 'error', error: '心跳超时' }, 'peri')
    expect(result.status).toBe('error')
    expect(result.recentError).toBe('心跳超时')
  })
})

describe('selectAgentStatus — 单一 selector 矩阵（active 无快照→unknown；非 active→inactive；有快照→后端状态）', () => {
  const statuses: Record<string, AgentStatus> = {
    peri: { agent: 'peri', agentId: 'peri', status: 'connected', transport: 'qq' },
    hermes: { agent: 'hermes', agentId: 'hermes', status: 'error', recentError: '心跳超时' },
  }

  it('active agent 且无快照 → unknown', () => {
    expect(selectAgentStatus('peri', 'peri', {})).toMatchObject({
      agent: 'peri',
      agentId: 'peri',
      status: 'unknown',
    })
  })

  it('active agent 且有快照 → 透传后端状态（connected 及 transport）', () => {
    const result = selectAgentStatus('peri', 'peri', statuses)
    expect(result.status).toBe('connected')
    expect(result.transport).toBe('qq')
  })

  it('active agent 且有 error 快照 → 透传 error 并保留诊断', () => {
    const result = selectAgentStatus('hermes', 'hermes', statuses)
    expect(result.status).toBe('error')
    expect(result.recentError).toBe('心跳超时')
  })

  it('非 active agent → inactive，忽略其快照', () => {
    expect(selectAgentStatus('hermes', 'peri', statuses).status).toBe('inactive')
  })

  it('空 statuses 且 active → unknown（冷启动/清空后不残留旧状态）', () => {
    expect(selectAgentStatus('peri', 'peri', {}).status).toBe('unknown')
  })
})

describe('statusLabel — 全状态文案', () => {
  it.each<[AgentConnectionStatus, string]>([
    ['connected', '已连接'],
    ['connecting', '连接中'],
    ['reconnecting', '重连中'],
    ['disconnected', '未连接'],
    ['error', '错误'],
    ['crashed', '进程崩溃'],
    ['unknown', '状态未知'],
    ['inactive', '未激活'],
  ])('%s → %s', (status, label) => {
    expect(statusLabel(status)).toBe(label)
  })
})
