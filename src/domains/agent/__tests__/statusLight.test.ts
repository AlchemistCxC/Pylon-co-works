import { describe, expect, it } from 'vitest'
import { agentLightDisplay, agentStatusLight } from '../statusLight.ts'

// 下沉自 scripts/test-agent-sidebar.mts（P91 A2）：六 status → 三灯状态矩阵。
describe('agentStatusLight 六状态归一', () => {
  it('connected → ok', () => {
    expect(agentStatusLight('connected')).toBe('ok')
  })

  it('connecting/reconnecting → warn', () => {
    expect(agentStatusLight('connecting')).toBe('warn')
    expect(agentStatusLight('reconnecting')).toBe('warn')
  })

  it('crashed/disconnected/error → error', () => {
    expect(agentStatusLight('crashed')).toBe('error')
    expect(agentStatusLight('disconnected')).toBe('error')
    expect(agentStatusLight('error')).toBe('error')
  })

  it('inactive/未知/空 → off', () => {
    expect(agentStatusLight('inactive')).toBe('off')
    expect(agentStatusLight('unknown')).toBe('off')
    expect(agentStatusLight('')).toBe('off')
  })
})

describe('agentLightDisplay 三灯辉光展示模型', () => {
  it('ok → 三灯 cascade（左→右传播）', () => {
    expect(agentLightDisplay('connected')).toEqual({
      lights: ['ok', 'warn', 'error'],
      mode: 'cascade',
    })
  })

  it('warn → 黄灯常亮 steady，其余灰', () => {
    expect(agentLightDisplay('reconnecting')).toEqual({
      lights: ['warn', 'off', 'off'],
      mode: 'steady',
    })
  })

  it('error → 三灯全红 sync', () => {
    expect(agentLightDisplay('crashed')).toEqual({
      lights: ['error', 'error', 'error'],
      mode: 'sync',
    })
  })

  it('off → 全灰无辉光', () => {
    expect(agentLightDisplay('unknown')).toEqual({
      lights: ['off', 'off', 'off'],
      mode: 'none',
    })
  })
})
