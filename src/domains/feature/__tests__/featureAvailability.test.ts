/**
 * featureAvailability 行为测试（报告阶段 4.5-4.7）：
 * 五态派生、保守写策略、原因文案。
 */
import { describe, expect, it } from 'vitest'
import { resolveFeatureAvailability, canWrite, availabilityReason } from '../featureAvailability'

describe('resolveFeatureAvailability', () => {
  it('connected + true → available', () => {
    expect(resolveFeatureAvailability(true, true)).toBe('available')
  })

  it('connected + false → unsupported', () => {
    expect(resolveFeatureAvailability(false, true)).toBe('unsupported')
  })

  it('disconnected → disconnected（忽略能力声明）', () => {
    expect(resolveFeatureAvailability(true, false)).toBe('disconnected')
    expect(resolveFeatureAvailability(undefined, false)).toBe('disconnected')
  })

  it('connected + 未声明 → unknown（保守）', () => {
    expect(resolveFeatureAvailability(undefined, true)).toBe('unknown')
  })
})

describe('canWrite', () => {
  it('仅 available 放行写', () => {
    expect(canWrite('available')).toBe(true)
    expect(canWrite('read-only')).toBe(false)
    expect(canWrite('unsupported')).toBe(false)
    expect(canWrite('disconnected')).toBe(false)
    expect(canWrite('unknown')).toBe(false)
  })
})

describe('availabilityReason', () => {
  it('available 无原因，其余有解释', () => {
    expect(availabilityReason('available')).toBeNull()
    expect(availabilityReason('disconnected')).toContain('未连接')
    expect(availabilityReason('unknown')).toContain('未确认')
  })
})
