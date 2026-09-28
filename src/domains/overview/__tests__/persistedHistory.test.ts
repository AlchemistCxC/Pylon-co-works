// 迁移自 scripts/test-history-sheet.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { pagePersistedSessions, validateExportPath, HISTORY_PAGE_SIZE } from '../persistedHistory.ts'

// W4-01：历史列表分页/排序 + 导出参数校验

describe('pagePersistedSessions 分页/排序', () => {
  const raw = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, updatedAt: i * 10 }))

  it('第一页：pageSize 条、total/pages 正确、updatedAt 倒序', () => {
    const p1 = pagePersistedSessions(raw, 1, HISTORY_PAGE_SIZE)
    expect(p1.entries.length).toBe(HISTORY_PAGE_SIZE)
    expect(p1.total).toBe(45)
    expect(p1.pages).toBe(3)
    expect(p1.entries.map(e => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => `s${44 - i}`))
  })

  it('第二页：从第 21 条（按倒序）继续', () => {
    const p2 = pagePersistedSessions(raw, 2)
    expect(p2.entries[0]?.id).toBe('s24')
  })

  it('越界页 clamp 到末页', () => {
    const p3 = pagePersistedSessions(raw, 99, HISTORY_PAGE_SIZE)
    expect(p3.page).toBe(3)
  })

  it('空列表 → 单页空结果', () => {
    expect(pagePersistedSessions([], 1)).toEqual({ entries: [], total: 0, page: 1, pages: 1 })
  })
})

describe('validateExportPath 导出参数校验', () => {
  it('空路径 → 拒绝', () => {
    expect(validateExportPath('')).toBe('导出路径不能为空')
  })

  it('相对路径 → 拒绝（导出必须绝对路径预检）', () => {
    expect(validateExportPath('relative/path.md')).toBe('导出路径必须是绝对路径')
  })

  it('合法绝对路径 → null（通过）', () => {
    expect(validateExportPath('G:/work/out.md')).toBeNull()
  })
})
