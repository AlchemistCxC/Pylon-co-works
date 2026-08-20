// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { lineNumberAtOffset, selectionLinesFromTextarea, workingDiffLines, workingDiffStats } from '../workingDiff'

// I08-A-FE-02 D-03/D-05：working-diff = 基线（最近一次成功保存）vs 未保存编辑

describe('workingDiffLines 基线 vs 当前全文行 diff', () => {
  it('完全相同 → 全部 context（无变更）', () => {
    const lines = workingDiffLines('a\nb\nc', 'a\nb\nc')
    expect(lines).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'context', text: 'b' },
      { kind: 'context', text: 'c' },
    ])
  })

  it('单行修改 → removed + added 对', () => {
    const lines = workingDiffLines('a\nb\nc', 'a\nB\nc')
    expect(lines).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'context', text: 'c' },
    ])
  })

  it('中间插入行 → 位置偏移语义（与 makeLines/changedLineNumbers 一致：后续行整体视为变更）', () => {
    const lines = workingDiffLines('a\nc', 'a\nb\nc')
    expect(lines).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'c' },
      { kind: 'added', text: 'b' },
      { kind: 'added', text: 'c' },
    ])
  })

  it('中间删除行 → 位置偏移语义（后续行整体视为变更）', () => {
    const lines = workingDiffLines('a\nb\nc', 'a\nc')
    expect(lines).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'c' },
      { kind: 'removed', text: 'c' },
    ])
  })

  it('空基线 → 全 added；空当前 → 全 removed', () => {
    expect(workingDiffLines('', 'x\ny').every(line => line.kind === 'added')).toBe(true)
    expect(workingDiffLines('x\ny', '').every(line => line.kind === 'removed')).toBe(true)
    expect(workingDiffLines('', '')).toEqual([])
  })

  it('行数不同时按行 index 逐行比较，尾部行不产生越界', () => {
    const lines = workingDiffLines('a', 'a\nb\nc')
    expect(lines.length).toBe(3)
  })
})

describe('workingDiffStats 增删统计', () => {
  it('统计 added/removed 行数', () => {
    const lines = workingDiffLines('a\nb\nc\nd', 'a\nX\nc\nY\nZ')
    const stats = workingDiffStats(lines)
    expect(stats.added).toBe(3)
    expect(stats.removed).toBe(2)
  })

  it('无变更 → 双零', () => {
    expect(workingDiffStats(workingDiffLines('a', 'a'))).toEqual({ added: 0, removed: 0 })
  })
})

describe('lineNumberAtOffset 字符偏移 → 1-based 行号', () => {
  it('偏移 0 → 第 1 行；越过换行 → 下一行', () => {
    expect(lineNumberAtOffset('a\nb', 0)).toBe(1)
    expect(lineNumberAtOffset('a\nb', 1)).toBe(1)
    expect(lineNumberAtOffset('a\nb', 2)).toBe(2)
    expect(lineNumberAtOffset('a\nb', 3)).toBe(2)
  })

  it('偏移越界 → 最后一行', () => {
    expect(lineNumberAtOffset('a\nb', 99)).toBe(2)
    expect(lineNumberAtOffset('', 0)).toBe(1)
  })
})

describe('selectionLinesFromTextarea textarea 选区 → 行号区间', () => {
  it('框选跨行 → startLine/endLine 对应 selectionStart/End 所在行', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'a\nb\nc\nd'
    textarea.selectionStart = 2
    textarea.selectionEnd = 6
    expect(selectionLinesFromTextarea(textarea)).toEqual({ startLine: 2, endLine: 4 })
  })

  it('光标停留（无选区）→ 单行区间', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'a\nb\nc'
    textarea.selectionStart = 2
    textarea.selectionEnd = 2
    expect(selectionLinesFromTextarea(textarea)).toEqual({ startLine: 2, endLine: 2 })
  })

  it('全部选中 → 第 1 行到最后一行', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'a\nb\nc'
    textarea.selectionStart = 0
    textarea.selectionEnd = 5
    expect(selectionLinesFromTextarea(textarea)).toEqual({ startLine: 1, endLine: 3 })
  })
})
