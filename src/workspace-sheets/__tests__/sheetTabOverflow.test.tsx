// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStores } from '../../test/resetStores.ts'
import type { SheetRecord } from '../sheetTypes.ts'
import SheetTabStrip from '../SheetTabStrip.tsx'

const sheets: SheetRecord[] = Array.from({ length: 7 }, (_, index) => ({
  id: `sheet-${index + 1}`,
  kind: index === 0 ? 'file' : 'overview',
  title: index === 6 ? '一个用于验证截断行为的超长 Sheet 标题' : `Sheet ${index + 1}`,
  createdAt: index,
  lastFocusedAt: index,
}))

function renderStrip(activeSheetId = 'sheet-1', onFocus = vi.fn()) {
  render(<SheetTabStrip
    sheets={sheets}
    activeSheetId={activeSheetId}
    activeAgent=""
    onFocus={onFocus}
    onClose={vi.fn()}
    menuActions={{ onTogglePin: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onReopen: vi.fn() }}
    canReopen={false}
  />)
  return onFocus
}

describe('SheetTabStrip 溢出导航', () => {
  beforeEach(() => {
    resetStores()
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    })
  })

  it('仅在真实溢出时显示边缘提示与所有 Sheet 菜单', () => {
    const onFocus = renderStrip()
    const strip = screen.getByRole('tablist', { name: 'Workspace Sheets' })
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 320 },
      scrollWidth: { configurable: true, value: 1120 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    })
    fireEvent.scroll(strip)

    const region = strip.closest('.sheet-tab-region')!
    expect(region).toHaveClass('overflowed', 'can-scroll-right')
    expect(region).not.toHaveClass('can-scroll-left')
    fireEvent.click(screen.getByRole('button', { name: '显示所有 Sheet' }))
    expect(screen.getByRole('menu', { name: '所有 Sheet' })).toBeTruthy()
    expect(screen.getAllByRole('menuitem')).toHaveLength(7)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Sheet 6' }))
    expect(onFocus).toHaveBeenCalledWith('sheet-6')
    expect(screen.queryByRole('menu', { name: '所有 Sheet' })).toBeNull()

    strip.scrollLeft = 400
    fireEvent.scroll(strip)
    expect(region).toHaveClass('can-scroll-left', 'can-scroll-right')
    strip.scrollLeft = 800
    fireEvent.scroll(strip)
    expect(region).toHaveClass('can-scroll-left')
    expect(region).not.toHaveClass('can-scroll-right')
  })

  it('活动 Sheet 变化时保持 scrollIntoView nearest 契约', () => {
    const view = renderStrip('sheet-1')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(view).not.toHaveBeenCalled()
  })

  it('溢出菜单支持 Escape 关闭', () => {
    renderStrip()
    const strip = screen.getByRole('tablist', { name: 'Workspace Sheets' })
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 1120 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    })
    fireEvent.scroll(strip)
    fireEvent.click(screen.getByRole('button', { name: '显示所有 Sheet' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '所有 Sheet' })).toBeNull()
  })
})
