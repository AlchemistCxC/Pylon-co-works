// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ZoneGroupFields, type RenderCtx } from '../../../themeFieldRenderer'
import { THEME_DEFAULTS } from '../../../themeFieldDefs'

/** T1 第一批：链A control 丰富——segmented 覆盖 + assistantDotImage 文件选择。 */

function makeCtx(overrides: Record<string, unknown> = {}): RenderCtx {
  return {
    t: { ...THEME_DEFAULTS, ...overrides } as unknown as RenderCtx['t'],
    onChange: () => {},
    search: '',
  }
}

describe('T1-B segmented control 覆盖（control=segmented 的 select 渲染按钮组）', () => {
  it('消息风格（terminal/bubble 二值）渲染 renderer-segmented 按钮组而非下拉', () => {
    const { container } = render(<ZoneGroupFields zone="chat" ctx={makeCtx()} />)
    const seg = container.querySelector('.renderer-segmented')
    expect(seg).not.toBeNull()
  })

  it('segmented 组内含 optionLabels 文本的按钮（终端记录流/对话气泡）', () => {
    const { container } = render(<ZoneGroupFields zone="chat" ctx={makeCtx()} />)
    const chips = [...container.querySelectorAll('.renderer-segmented-chip')]
      .map(el => el.textContent)
    expect(chips).toContain('终端记录流')
    expect(chips).toContain('对话气泡')
  })
})

describe('T1-A assistantDotImage bgImage control', () => {
  it('头像图标字段渲染文件选择按钮（ps-btn 选择）', () => {
    const { container } = render(<ZoneGroupFields zone="chat" ctx={makeCtx()} />)
    const buttons = [...container.querySelectorAll('button')].map(b => b.textContent ?? '')
    expect(buttons.some(x => x.includes('选择'))).toBe(true)
  })
})
