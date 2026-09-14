// 迁移自 scripts/test-overview-sessions.mts（P91 A1）——仅迁 persistedSessions 纯函数段；
// View 接线段（源码 token 断言）不迁，已由 src/sheets/__tests__/OverviewSheetView.resumeError.test.tsx 锁定。
import { describe, expect, it } from 'vitest'
import { normalizePersistedSessions, recentPersistedSessions } from '../persistedSessions.ts'

// W1-06：最近会话恢复——宽容 normalize + updatedAt 倒序取 5 + 不直接 load（listener 就绪）

describe('persistedSessions 宽容 normalize（迁移自 scripts/test-overview-sessions.mts，P91 A1）', () => {
  it('非数组 → []；未知项/缺 id 跳过不崩', () => {
    expect(normalizePersistedSessions(null)).toEqual([])
    expect(normalizePersistedSessions('x')).toEqual([])
    expect(normalizePersistedSessions([null, 'str', { title: 'no-id' }])).toEqual([])
  })

  it('updatedAt 数字/字符串/缺失稳定 fallback，不 NaN', () => {
    const entries = normalizePersistedSessions([
      { id: 'a', title: 'A', updatedAt: 300 },
      { id: 'b', source: 'local:b', updatedAt: '500' },
      { id: 'c', updatedAt: '2026-08-01T00:00:00Z' },
      { id: 'd', updatedAt: undefined },
      { id: 'e', updatedAt: 'not-a-date' },
      { id: 'f' },
    ])
    expect(entries.length).toBe(6)
    expect(entries[0]?.updatedAt).toBe(300)
    expect(entries[1]?.updatedAt).toBe(500) // 字符串数字必须解析
    expect(entries[2]?.updatedAt).toBeGreaterThan(0) // ISO 日期必须解析
    expect(entries[3]?.updatedAt).toBe(0) // undefined 时间戳 fallback 0
    expect(entries[4]?.updatedAt).toBe(0) // 非法字符串 fallback 0
    expect(entries[5]?.updatedAt).toBe(0)
  })
})

describe('recentPersistedSessions 倒序取 5（迁移自 scripts/test-overview-sessions.mts，P91 A1）', () => {
  it('按 updatedAt 倒序、截取 limit；空输入为空', () => {
    const raw = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, updatedAt: i * 10 }))
    const recent = recentPersistedSessions(raw)
    expect(recent.length).toBe(5)
    expect(recent.map(r => r.id)).toEqual(['s7', 's6', 's5', 's4', 's3'])
    expect(recentPersistedSessions([]).length).toBe(0)
  })

  it('缺 updatedAt 的排最后（不 NaN）', () => {
    const mixed = recentPersistedSessions([
      { id: 'old', updatedAt: 1 },
      { id: 'no-time' },
      { id: 'new', updatedAt: 2 },
    ])
    expect(mixed.map(r => r.id)).toEqual(['new', 'old', 'no-time'])
    expect(mixed.every(r => Number.isFinite(r.updatedAt))).toBe(true) // 排序不得产生 NaN
  })
})
