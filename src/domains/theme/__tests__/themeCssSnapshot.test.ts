/**
 * selectThemeCssSnapshot 行为测试（FE-AUD-013 / 报告 9B.1）：
 * 显式派生（背景/字体/布局）+ defs 循环注入 + 空 color 省略 + 布局宽度。
 */
import { describe, expect, it } from 'vitest'
import { selectThemeCssSnapshot } from '../themeCssSnapshot'

const LAYOUT = { sidebarCollapsed: false, sidebarWidth: 250 }

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...overrides }
}

describe('selectThemeCssSnapshot', () => {
  it('字体选择派生（mono → var(--mono)）', () => {
    const vars = selectThemeCssSnapshot(makeState({ globalFont: 'mono', chatFont: 'sans', msgFont: 'mono' }), LAYOUT)
    expect(vars['--global-font']).toBe('var(--mono)')
    expect(vars['--chat-font']).toBe('var(--font)')
    expect(vars['--msg-font']).toBe('var(--mono)')
  })

  it('布局宽度派生（折叠 42 / 展开 宽度）', () => {
    const vars = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: true, sidebarWidth: 250 })
    expect(vars['--titlebar-sidebar-width']).toBe('42px')
    const expanded = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: false, sidebarWidth: 320 })
    expect(expanded['--titlebar-sidebar-width']).toBe('320px')
    expect(expanded['--sheet-sidebar-width']).toBe('320px')
  })

  it('背景图经 toCssBackgroundImage 转换（非空输入产生 var 引用）', () => {
    const vars = selectThemeCssSnapshot(makeState({ globalBgImage: 'linear-gradient(#000,#111)' }), LAYOUT)
    expect(vars['--global-bg-image']).toContain('linear-gradient')
  })

  it('defs 驱动循环注入 color/number 且空 color 省略', () => {
    const vars = selectThemeCssSnapshot(makeState({ accent: '#3b82f6', editorFontSize: 14 }), LAYOUT)
    expect(vars['--accent']).toBe('#3b82f6')
    expect(vars['--editor-font-size']).toBe('14px')
    const empty = selectThemeCssSnapshot(makeState({ accent: '' }), LAYOUT)
    expect(empty['--accent']).toBeUndefined()
  })

  it('msgTextColor 空时走兜底链', () => {
    const vars = selectThemeCssSnapshot(makeState(), LAYOUT)
    expect(vars['--msg-text']).toContain('var(--chat-text-color')
  })
})
