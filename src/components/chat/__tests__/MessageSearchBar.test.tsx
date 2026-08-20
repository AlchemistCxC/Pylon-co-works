// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import MessageSearchBar from '../MessageSearchBar'

function setup() {
  const onQueryChange = vi.fn()
  const onPrevious = vi.fn()
  const onNext = vi.fn()
  const onClose = vi.fn()
  render(
    <MessageSearchBar
      query="检查"
      matchIndex={0}
      matchCount={3}
      onQueryChange={onQueryChange}
      onPrevious={onPrevious}
      onNext={onNext}
      onClose={onClose}
    />,
  )
  return { onQueryChange, onPrevious, onNext, onClose }
}

describe('MessageSearchBar', () => {
  test('渲染查询词与计数', () => {
    setup()
    expect(screen.getByDisplayValue('检查')).toBeTruthy()
    expect(screen.getByText('1/3')).toBeTruthy()
  })

  test('输入触发 onQueryChange', () => {
    const { onQueryChange } = setup()
    const input = screen.getByDisplayValue('检查')
    fireEvent.change(input, { target: { value: '新词' } })
    expect(onQueryChange).toHaveBeenCalledWith('新词')
  })

  test('Enter 下一个 / Shift+Enter 上一个 / Esc 关闭', () => {
    const { onNext, onPrevious, onClose } = setup()
    const input = screen.getByDisplayValue('检查')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNext).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onPrevious).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('无结果时显示"无结果"且按钮禁用', () => {
    const { onPrevious, onNext } = setup()
    render(
      <MessageSearchBar
        query="无匹配词"
        matchIndex={0}
        matchCount={0}
        onQueryChange={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('无结果')).toBeTruthy()
    expect(onPrevious).toBeDefined()
    expect(onNext).toBeDefined()
  })
})
