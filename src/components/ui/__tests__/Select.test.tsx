// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Select from '../Select.tsx'

const options = [
  { value: 'auto', label: '自动选择' },
  { value: 'react', label: 'React Renderer' },
  { value: 'solid', label: 'Solid Renderer', disabled: true },
  { value: 'isolated', label: '隔离 Surface' },
]

function Harness() {
  const [value, setValue] = useState('auto')
  return <Select id="renderer-select" ariaLabel="渲染引擎" value={value} options={options} onChange={setValue} />
}

describe('Select', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('提供 combobox/listbox/option ARIA 并通过点击提交值', () => {
    render(<Harness />)
    const trigger = screen.getByRole('combobox', { name: '渲染引擎' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox', { name: '渲染引擎' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '自动选择' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.mouseDown(screen.getByRole('option', { name: 'React Renderer' }))
    expect(trigger).toHaveTextContent('React Renderer')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('支持方向键、Home/End、Enter 与 Escape，并跳过禁用项', () => {
    render(<Harness />)
    const trigger = screen.getByRole('combobox', { name: '渲染引擎' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(trigger).toHaveTextContent('隔离 Surface')

    fireEvent.keyDown(trigger, { key: ' ' })
    fireEvent.keyDown(trigger, { key: 'Home' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(trigger).toHaveTextContent('自动选择')

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('支持首字母检索与 disabled 门禁', () => {
    render(<Harness />)
    const trigger = screen.getByRole('combobox', { name: '渲染引擎' })
    fireEvent.keyDown(trigger, { key: 'r' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(trigger).toHaveTextContent('React Renderer')

    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'Solid Renderer' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Solid Renderer' }))
    expect(trigger).toHaveTextContent('React Renderer')
  })
})
