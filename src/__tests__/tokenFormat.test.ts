// 迁移自 scripts/test-token-format.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { formatCacheReadTokens, formatTokenCount, formatUsagePercent, formatUsageTokens } from '../tokenFormat.ts'

describe('tokenFormat 格式化（迁移自 scripts/test-token-format.mts，P91 A1）', () => {
  it('formatTokenCount：K/M 进位', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(950)).toBe('950')
    expect(formatTokenCount(1500)).toBe('1.5K')
    expect(formatTokenCount(12000)).toBe('12K')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
  })

  it('formatCacheReadTokens：cached 后缀', () => {
    expect(formatCacheReadTokens(3200)).toBe('3.2K cached')
    expect(formatCacheReadTokens(42)).toBe('42 cached')
  })
})

describe('用量控件格式化（S11）', () => {
  it('formatUsageTokens：小写 k/m、数字与单位间一个空格、小数恒一位', () => {
    expect(formatUsageTokens(0)).toBe('0.0 k')
    expect(formatUsageTokens(950)).toBe('0.9 k')
    expect(formatUsageTokens(123_456)).toBe('123.5 k')
    expect(formatUsageTokens(200_000)).toBe('200.0 k')
    expect(formatUsageTokens(1_234_567)).toBe('1.2 m')
  })

  it('formatUsageTokens：非有限值与负数回落 0.0 k', () => {
    expect(formatUsageTokens(Number.NaN)).toBe('0.0 k')
    expect(formatUsageTokens(Number.POSITIVE_INFINITY)).toBe('0.0 k')
    expect(formatUsageTokens(-5)).toBe('0.0 k')
  })

  it('formatUsagePercent：一位小数、不取整', () => {
    expect(formatUsagePercent(0)).toBe('0.0%')
    expect(formatUsagePercent(0.456)).toBe('45.6%')
    expect(formatUsagePercent(1)).toBe('100.0%')
    expect(formatUsagePercent(Number.NaN)).toBe('0.0%')
  })
})
