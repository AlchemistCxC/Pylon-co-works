// 迁移自 scripts/test-input-overflow-state.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { resolveCliTextareaLayout, resolveDefaultTextareaHeight } from '../inputOverflowState.ts'

describe('resolveCliTextareaLayout textarea 布局', () => {
  it('fixed-scroll：单行不滚动', () => {
    expect(resolveCliTextareaLayout(22, 'fixed-scroll')).toEqual({
      height: 22,
      overflowY: 'hidden',
      expanded: false,
    })
  })

  it('fixed-scroll：内容超高 → 固定高度 + auto 滚动', () => {
    expect(resolveCliTextareaLayout(120, 'fixed-scroll')).toEqual({
      height: 22,
      overflowY: 'auto',
      expanded: false,
    })
  })

  it('grow：未超上限 → 原高度展开、不滚动', () => {
    expect(resolveCliTextareaLayout(120, 'grow')).toEqual({
      height: 120,
      overflowY: 'hidden',
      expanded: true,
    })
  })

  it('grow：超上限 → 钳到最大高度 + auto 滚动', () => {
    expect(resolveCliTextareaLayout(280, 'grow')).toEqual({
      height: 200,
      overflowY: 'auto',
      expanded: true,
    })
  })

  it('overlay：原高度展开、不滚动', () => {
    expect(resolveCliTextareaLayout(120, 'overlay')).toEqual({
      height: 120,
      overflowY: 'hidden',
      expanded: true,
    })
  })
})

describe('resolveDefaultTextareaHeight', () => {
  it('单行下限 22', () => {
    expect(resolveDefaultTextareaHeight(12)).toBe(22)
  })

  it('超上限钳到 200', () => {
    expect(resolveDefaultTextareaHeight(280)).toBe(200)
  })
})
