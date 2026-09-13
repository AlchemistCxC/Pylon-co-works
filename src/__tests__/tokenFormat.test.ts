// 迁移自 scripts/test-token-format.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { formatCacheReadTokens, formatTokenCount } from '../tokenFormat.ts'

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
