// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
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
  it('消息风格（terminal/bubble 二值）渲染可访问单选组而非下拉', () => {
    render(<ZoneGroupFields zone="chat" ctx={makeCtx()} />)
    // ToggleGroup.Root 以 aria-label=字段名（「消息风格」）暴露为 radiogroup
    expect(screen.getByRole('radiogroup', { name: '消息风格' })).toBeInTheDocument()
  })

  it('segmented 组内含 optionLabels 文本的选项（终端记录流/对话气泡）', () => {
    render(<ZoneGroupFields zone="chat" ctx={makeCtx()} />)
    // 限定在「消息风格」组内断言——「对话气泡」同时是消息布局组的选项
    const msgStyleGroup = screen.getByRole('radiogroup', { name: '消息风格' })
    expect(within(msgStyleGroup).getByRole('radio', { name: '终端记录流' })).toBeInTheDocument()
    expect(within(msgStyleGroup).getByRole('radio', { name: '对话气泡' })).toBeInTheDocument()
  })
})

describe('T1-A assistantDotImage bgImage control', () => {
  it('头像图标字段渲染文件选择按钮', () => {
    render(<ZoneGroupFields zone="chat" ctx={makeCtx()} />)
    expect(screen.getByRole('button', { name: '选择' })).toBeInTheDocument()
  })
})
