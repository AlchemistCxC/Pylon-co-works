// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import RendererSettingField, { evaluateRenderSettingCondition } from '../RendererSettingField.tsx'
import type { RenderSettingField } from '../../../plugin-runtime/renderers/rendererSettingsTypes.ts'

/** S4：分发矩阵逐形态断言（施工书 06 §S4；设计书 §3.1/§3.7）。 */

const opts = (values: string[]) => values.map(v => ({ value: v, label: v }))

function mount(field: RenderSettingField, value?: unknown) {
  const received: unknown[] = []
  render(<RendererSettingField field={field} value={value as never}
    onChange={v => received.push(v)} />)
  return received
}

describe('S4 分发矩阵', () => {
  it('choice 未声明 presentation → select（DISPLAY_DEFAULTS）', () => {
    mount({ key: 'f', label: '单选', type: 'choice', options: opts(['a', 'b']) })
    expect(screen.getByLabelText('单选').tagName).toBe('SELECT')
  })

  it('choice segmented → radiogroup（K-3 Radix ToggleGroup），click 写入 string', () => {
    const received = mount({ key: 'f', label: '视图', type: 'choice', presentation: 'segmented', options: opts(['a', 'b']) }, 'a')
    // K-3 底座切换：Radix single ToggleGroup 的容器语义是 radiogroup（施工书 09 §K-3 预告的迁移点）
    expect(screen.getByRole('radiogroup', { name: '视图' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'b' }))
    expect(received.at(-1)).toBe('b')
  })

  it('multi-choice checklist（默认）→ checkbox 组写入 string[]', () => {
    const received = mount({ key: 'f', label: '块', type: 'multi-choice', presentation: 'checklist', options: opts(['x', 'y']) }, ['x'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'y' }))
    expect(received.at(-1)).toEqual(['x', 'y'])
  })

  it('color palette+picker → ColorPopover 触发钮带字段名 aria', () => {
    mount({ key: 'f', label: '强调色2', type: 'color', presentation: 'palette+picker', default: '#3366ff' })
    expect(screen.getByRole('button', { name: '强调色2' })).toBeTruthy()
  })

  it('number 未声明 → slider+input 双输入联动，载荷 number', () => {
    const received = mount({ key: 'f', label: '大小', type: 'number', min: 0, max: 100, default: 10 })
    // K-3：range 半边升级 Radix Slider——Thumb 键盘交互（ArrowRight 按 step 步进）
    const thumb = screen.getByRole('slider', { name: '大小滑块' })
    fireEvent.focus(thumb)
    fireEvent.keyDown(thumb, { key: 'ArrowRight' })
    const stepped = received.at(-1)
    expect(typeof stepped).toBe('number')
    expect(stepped).toBeGreaterThan(10)
    // 数值半边（原生 number input）直接改写
    fireEvent.change(screen.getByLabelText('大小数值'), { target: { value: '42' } })
    expect(received.at(-1)).toBe(42)
  })

  it('boolean toggle → role=switch，click 写入 boolean', () => {
    const received = mount({ key: 'f', label: '启用2', type: 'boolean', presentation: 'toggle', default: false })
    const sw = screen.getByRole('switch', { name: '启用2' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(received.at(-1)).toBe(true)
  })

  it('text textarea（回归）', () => {
    mount({ key: 'f', label: '备注3', type: 'text', presentation: 'textarea' })
    expect(screen.getByLabelText('备注3').tagName).toBe('TEXTAREA')
  })

  it('evaluateRenderSettingCondition 回归（equals/not/all）', () => {
    const values = { a: true }
    expect(evaluateRenderSettingCondition({ equals: { field: 'a', value: true } }, values)).toBe(true)
    expect(evaluateRenderSettingCondition({ not: { equals: { field: 'a', value: true } } }, values)).toBe(false)
  })
})
