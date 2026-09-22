import { describe, expect, it } from 'vitest'
import { createRowHeightTable } from '../rowHeightTable.ts'

describe('rowHeightTable', () => {
  it('setKeys 播种估算并建立前缀偏移，totalSize 为全行高之和', () => {
    const table = createRowHeightTable()
    table.setKeys(['a', 'b', 'c'], key => ({ a: 10, b: 20, c: 30 })[key] ?? 0)
    expect(table.count).toBe(3)
    expect(table.offsetAt(0)).toBe(0)
    expect(table.offsetAt(1)).toBe(10)
    expect(table.offsetAt(2)).toBe(30)
    expect(table.offsetAt(3)).toBe(60)
    expect(table.totalSize()).toBe(60)
    expect(table.entry('b')).toEqual({ size: 20, source: 'estimated' })
  })

  it('尾部追加只重建后缀（脏起点 = 公共前缀末端）', () => {
    const table = createRowHeightTable()
    table.setKeys(['a', 'b'], () => 10)
    expect(table.dirty).toBe(false)
    table.setKeys(['a', 'b', 'c'], () => 40)
    // 公共前缀 ['a','b'] 未动，偏移前缀无需重算
    expect(table.offsetAt(2)).toBe(20)
    expect(table.offsetAt(3)).toBe(60)
  })

  it('indexForOffset 命中「顶边 ≤ offset 的最后一行」（<= 边界语义）', () => {
    const table = createRowHeightTable()
    table.setKeys(['a', 'b', 'c'], key => ({ a: 10, b: 20, c: 30 })[key] ?? 0)
    expect(table.indexForOffset(0)).toBe(0)
    expect(table.indexForOffset(9.99)).toBe(0)
    expect(table.indexForOffset(10)).toBe(1)
    expect(table.indexForOffset(29)).toBe(1)
    expect(table.indexForOffset(30)).toBe(2)
    expect(table.indexForOffset(59)).toBe(2)
    expect(table.indexForOffset(1000)).toBe(2)
    expect(table.indexForOffset(-1)).toBeUndefined()
  })

  it('实测回填生效差值；ε 内抖动被忽略但来源升格为实测', () => {
    const table = createRowHeightTable()
    table.setKeys(['a', 'b'], () => 50)
    expect(table.measure('a', 50.3)).toBe(0)
    expect(table.isMeasured('a')).toBe(true)
    expect(table.sizeOf('a')).toBe(50)
    expect(table.measure('a', 80)).toBe(30)
    expect(table.entry('a')).toEqual({ size: 80, source: 'measured' })
    expect(table.offsetAt(2)).toBe(130)
  })

  it('实测不随行卸载丢失（D7 改口径①：尺寸缓存按 key 保留）', () => {
    const table = createRowHeightTable()
    table.setKeys(['a', 'b'], () => 50)
    table.measure('a', 120)
    // 行集收缩：a 退役
    table.setKeys(['b'], () => 50)
    expect(table.totalSize()).toBe(50)
    // a 回归：命中历史实测而非估算播种
    table.setKeys(['a', 'b'], () => 50)
    expect(table.sizeOf('a')).toBe(120)
    expect(table.isMeasured('a')).toBe(true)
  })

  it('refreshAfterContentChange：未测行换估算、窗内实测保留、窗外实测降级', () => {
    const table = createRowHeightTable()
    table.setKeys(['a', 'b', 'c'], () => 50)
    table.measure('a', 100)
    table.measure('c', 100)

    // 未测行：估算跟随内容
    table.refreshAfterContentChange('b', 70, true)
    expect(table.entry('b')).toEqual({ size: 70, source: 'estimated' })

    // 窗内实测：保留（RO 稍后回填真实值）
    table.refreshAfterContentChange('a', 999, true)
    expect(table.entry('a')).toEqual({ size: 100, source: 'measured' })

    // 窗外实测：降级回估算（无法被观察器即时纠正）
    table.refreshAfterContentChange('c', 70, false)
    expect(table.entry('c')).toEqual({ size: 70, source: 'estimated' })
  })

  it('invalidate/invalidateAll 只作废实测，重算走 estimateFor', () => {
    const table = createRowHeightTable()
    table.setKeys(['a', 'b'], key => ({ a: 10, b: 20 })[key] ?? 0)
    table.measure('a', 100)
    table.measure('b', 200)

    table.invalidate('a', key => ({ a: 10, b: 20 })[key] ?? 0)
    expect(table.entry('a')).toEqual({ size: 10, source: 'estimated' })
    expect(table.isMeasured('b')).toBe(true)

    table.invalidateAll(() => 33)
    expect(table.isMeasured('b')).toBe(false)
    expect(table.sizeOf('b')).toBe(33)
    expect(table.offsetAt(2)).toBe(43)
  })

  it('offsetAt/indexForOffset 与真实 DOM 偏移的一致性（切片 1 验收口径）', () => {
    const table = createRowHeightTable()
    const heights = [64, 128, 96, 210, 48]
    table.setKeys(heights.map((_, index) => `row${index}`), key => heights[Number(key.slice(3))] ?? 0)
    // 逐行实测（模拟挂载后的 ResizeObserver 回填）
    heights.forEach((height, index) => table.measure(`row${index}`, height))

    // 表算偏移 == 真实 DOM 偏移：DOM 里第 i 行的 offsetTop 恰为前 i 行高度和
    let domTop = 0
    heights.forEach((height, index) => {
      expect(table.offsetAt(index)).toBe(domTop)
      domTop += height
    })
    expect(table.totalSize()).toBe(domTop)
    // 给定 scrollTop 命中首屏行（197 = 64+128+5，落在第 2 行 [192, 288) 内）
    expect(table.indexForOffset(197)).toBe(2)
  })

  it('reset 清空全部状态', () => {
    const table = createRowHeightTable()
    table.setKeys(['a'], () => 10)
    table.measure('a', 99)
    table.reset()
    expect(table.count).toBe(0)
    expect(table.sizeOf('a')).toBeUndefined()
    expect(table.totalSize()).toBe(0)
    expect(table.indexForOffset(0)).toBeUndefined()
  })
})
