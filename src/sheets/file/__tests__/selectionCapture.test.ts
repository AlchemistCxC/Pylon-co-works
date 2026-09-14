// 迁移自 scripts/test-file-dispatch-ui.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { lineFromDataNode, normalizeSelectionRange } from '../selectionCapture.ts'

// W2-08：DispatchBar——1-based selection 捕获 fixture

describe('normalizeSelectionRange 行号归一', () => {
  it('fixture 断言防 off-by-one', () => {
    expect(normalizeSelectionRange(3, 5)).toEqual({ startLine: 3, endLine: 5 })
  })

  it('anchor 在后也排序', () => {
    expect(normalizeSelectionRange(5, 3)).toEqual({ startLine: 3, endLine: 5 })
  })

  it('单行选区', () => {
    expect(normalizeSelectionRange(4, 4)).toEqual({ startLine: 4, endLine: 4 })
  })

  it('任一端缺失 → null（无有效框选）', () => {
    expect(normalizeSelectionRange(null, 3)).toBeNull()
    expect(normalizeSelectionRange(undefined as unknown as number | null, 3)).toBeNull()
  })
})

describe('lineFromDataNode：DOM data-line 查找', () => {
  it('节点本身带 data-line → 行号', () => {
    const el = { getAttribute: (name: string) => name === 'data-line' ? '42' : null, parentNode: null }
    expect(lineFromDataNode(el as unknown as Node)).toBe(42)
  })

  it('向上找最近 data-line（父级命中）', () => {
    const el = { getAttribute: (name: string) => name === 'data-line' ? '42' : null, parentNode: null }
    const parent = { getAttribute: () => null, parentNode: el }
    expect(lineFromDataNode(parent as unknown as Node)).toBe(42)
  })

  it('无 data-line → null', () => {
    const noLine = { getAttribute: () => null, parentNode: null }
    expect(lineFromDataNode(noLine as unknown as Node)).toBeNull()
  })

  it('null 节点 → null', () => {
    expect(lineFromDataNode(null)).toBeNull()
  })
})
