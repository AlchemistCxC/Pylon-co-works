// @vitest-environment jsdom
/**
 * SheetErrorBoundary 行为测试（报告 8.2）：
 * Sheet 渲染异常被隔离（显示错误态 + retry 恢复），不扩散。
 */
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SheetErrorBoundary from '../../workspace-sheets/SheetErrorBoundary'

function Exploding(): never {
  throw new Error('boom in sheet')
}

describe('SheetErrorBoundary', () => {
  it('Sheet 渲染异常 → 错误态，retry 恢复后显示新内容', () => {
    const { rerender } = render(
      <SheetErrorBoundary sheetId="s1">
        <Exploding />
      </SheetErrorBoundary>,
    )
    expect(screen.getByText('此 Sheet 渲染失败')).toBeTruthy()
    expect(screen.getByText(/boom in sheet/)).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    // 外部修复后 rerender（ErrorBoundary state 保留）；点击重试清 error 渲染新内容
    rerender(
      <SheetErrorBoundary sheetId="s1">
        <div>normal content</div>
      </SheetErrorBoundary>,
    )
    expect(screen.getByText('此 Sheet 渲染失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(screen.getByText('normal content')).toBeTruthy()
  })
})
