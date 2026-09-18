import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatTime } from '../utils.ts'

/**
 * #116 子项 4：侧栏相对时间原先是「刚刚 + m ago / h ago / d ago」中英混用，
 * 同一批会话数据在 Overview sheet 显示「2 天前」、在侧栏显示「2d ago」。
 * 本用例锁住四个分档的中文口径（与 OverviewSheetView.relativeTime 对齐）。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function at(diffMs: number): number {
  return Date.now() - diffMs
}

afterEach(() => {
  vi.useRealTimers()
})

describe('formatTime（#116 子项 4）', () => {
  it('一分钟内为「刚刚」', () => {
    expect(formatTime(at(0))).toBe('刚刚')
    expect(formatTime(at(MINUTE - 1))).toBe('刚刚')
  })

  it('分钟 / 小时 / 天三个分档均为中文', () => {
    expect(formatTime(at(5 * MINUTE))).toBe('5 分钟前')
    expect(formatTime(at(59 * MINUTE))).toBe('59 分钟前')
    expect(formatTime(at(3 * HOUR))).toBe('3 小时前')
    expect(formatTime(at(23 * HOUR))).toBe('23 小时前')
    expect(formatTime(at(2 * DAY))).toBe('2 天前')
    expect(formatTime(at(30 * DAY))).toBe('30 天前')
  })

  it('空时间戳返回空串', () => {
    expect(formatTime(undefined)).toBe('')
    expect(formatTime(0)).toBe('')
  })

  it('任何分档都不再出现 ago / m / h / d 这类英文缩写', () => {
    const samples = [0, MINUTE, 5 * MINUTE, HOUR, 3 * HOUR, DAY, 2 * DAY, 400 * DAY]
    for (const diff of samples) {
      const text = formatTime(at(diff))
      expect(text).not.toMatch(/ago/)
      expect(text).not.toMatch(/\d[mhd]\b/)
    }
  })

  it('分档边界不跳档（59 分 59 秒仍是分钟档）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'))
    expect(formatTime(Date.parse('2026-01-02T11:00:01Z'))).toBe('59 分钟前')
    expect(formatTime(Date.parse('2026-01-02T11:00:00Z'))).toBe('1 小时前')
  })
})
