// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStores } from '../../test/resetStores.ts'
import SheetTabStrip from '../SheetTabStrip.solid.tsx'
import type { SheetTabStripProps } from '../SheetTabStrip.solid.tsx'
import type { SheetRecord } from '../sheetTypes.ts'

// #498：React 死桥随 #484 删除后，溢出收拢语义（原 sheetTabOverflow.test.tsx）由 Solid
// 实体承接。行为面不变：页签装不下时收拢进「···」选单、不滚动、不截断；可用宽度由
// 标题栏中格决定，而不是页签区自己的宽度（后者按内容撑开，拿它当尺子会自指）。

const sheets: SheetRecord[] = Array.from({ length: 7 }, (_, index) => ({
  id: `sheet-${index + 1}`,
  kind: index === 0 ? 'file' : 'overview',
  title: index === 6 ? '一个用于验证截断行为的超长 Sheet 标题' : `Sheet ${index + 1}`,
  createdAt: index,
  lastFocusedAt: index,
}))

/** 页签的可用宽度由**标题栏中格**决定。jsdom 没有布局，这里显式给中格一个 clientWidth；
    不给（0）时组件按「全放得下」处理。 */
function setCellWidth(width: number) {
  const cell = document.querySelector('.sheet-tab-region')?.parentElement
  if (!cell) throw new Error('未找到页签区所在的容器')
  Object.defineProperty(cell, 'clientWidth', { configurable: true, value: width })
}

function renderStrip(activeSheetId = 'sheet-1', onFocus = vi.fn()) {
  const onClose = vi.fn()
  const menuActions = { onTogglePin: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onReopen: vi.fn() }
  const result = render(() => <SheetTabStrip latest={() => ({
    sheets,
    activeSheetId,
    activeAgent: '',
    onFocus,
    onClose,
    menuActions,
    canReopen: false,
  } satisfies SheetTabStripProps)} />)
  return { ...result, onFocus }
}

const renderedTabs = () =>
  [...document.querySelectorAll('.sheet-tab')].map(node => node.querySelector('.sheet-tab-title')?.textContent ?? null)

describe('SheetTabStrip.solid 装不下时的收拢（不滚动、不截断）', () => {
  beforeEach(() => {
    resetStores()
  })

  afterEach(cleanup)

  it('量不到宽度时不做假定：全部页签都渲染、没有「···」', () => {
    renderStrip()
    expect(document.querySelectorAll('.sheet-tab')).toHaveLength(7)
    expect(screen.queryByRole('button', { name: '显示所有 Sheet' })).toBeNull()
  })

  it('装不下时只渲染放得下的那几个，其余进「···」选单（选单仍列全部）', () => {
    const { onFocus } = renderStrip()
    // 中格 460px：减去启动器（jsdom 量到 0）、拖拽区最小 18px、「···」预留 32px ⇒ 预算 410px；
    // 每个页签最小 96px（jsdom 读不到 CSS 变量，走代码里的兜底值）⇒ 恰好 4 个。
    setCellWidth(460)
    fireEvent(window, new Event('resize'))

    expect(document.querySelectorAll('.sheet-tab')).toHaveLength(4)
    expect(renderedTabs().slice(0, 4)).toEqual(['Sheet 1', 'Sheet 2', 'Sheet 3', 'Sheet 4'])
    const region = document.querySelector('.sheet-tab-region')!
    expect(region).toHaveClass('overflowed')

    fireEvent.click(screen.getByRole('button', { name: '显示所有 Sheet' }))
    expect(screen.getByRole('menu', { name: '所有 Sheet' })).toBeTruthy()
    expect(screen.getAllByRole('menuitem')).toHaveLength(7)

    // 非 agent sheet：选单收起与 onFocus 同步发生（信号更新无批处理延迟）。
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sheet 6' }))
    expect(onFocus).toHaveBeenCalledWith('sheet-6')
    expect(screen.queryByRole('menu', { name: '所有 Sheet' })).toBeNull()
  })

  it('活动页签落在窗口之外时，窗口整体平移把它带进来', () => {
    renderStrip('sheet-6')
    setCellWidth(460)
    fireEvent(window, new Event('resize'))

    const titles = renderedTabs()
    expect(titles).toHaveLength(4)
    // 窗口从第 6 个往前挪：末尾是活动页签，标题栏上始终看得见「现在是谁」。
    expect(titles.at(-1)).toBe('Sheet 6')
  })

  it('窗口变宽后恢复显示全部页签', () => {
    renderStrip()
    setCellWidth(460)
    fireEvent(window, new Event('resize'))
    expect(document.querySelectorAll('.sheet-tab')).toHaveLength(4)

    setCellWidth(2000)
    fireEvent(window, new Event('resize'))
    expect(document.querySelectorAll('.sheet-tab')).toHaveLength(7)
    expect(screen.queryByRole('button', { name: '显示所有 Sheet' })).toBeNull()
  })

  it('溢出菜单支持 Escape 关闭', () => {
    renderStrip()
    setCellWidth(200)
    fireEvent(window, new Event('resize'))
    fireEvent.click(screen.getByRole('button', { name: '显示所有 Sheet' }))
    expect(screen.getByRole('menu', { name: '所有 Sheet' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '所有 Sheet' })).toBeNull()
  })
})
