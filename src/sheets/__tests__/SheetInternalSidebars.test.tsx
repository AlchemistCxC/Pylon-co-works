// @vitest-environment jsdom
/**
 * #154 左列统一模型契约（改写自 I09-A-FE-01/02 的「Sheet 自持左栏」契约）。
 *
 * 旧契约断言「折叠时 Sheet 自己把侧栏从 DOM 摘掉，侧栏状态由 Sheet 持有」。
 * 那正是分割线对不齐的成因：每个 Sheet 各自决定宽度与边框，标题栏又按自己的
 * token 另画一条。新契约把几何收归布局层，因此这里断言三件事：
 *
 * 1. 每个 Sheet 的左栏挂共享几何类 `.sidebar`（宽度唯一来自
 *    `--sheet-sidebar-track-width`，由 .sidebar 消费）；
 * 2. 左栏不再自带宽度 / flex 基准 / 竖边框（几何不许回到 Sheet 手里）；
 * 3. 折叠时左栏**仍在 DOM**——可见性归布局层的 `.layout[data-sidebar="collapsed"]`，
 *    Sheet 不再自己摘节点（否则折叠动画与 a11y 可见性会各说各话）。
 *
 * 断言强度不降：旧断言的「折叠后用户看不到左栏」在新模型里由布局层状态保证，
 * 已在 `sidebarUnifiedModel.css.test.ts` 里以 CSS 契约静态钉住。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import PrismManagerSheetView from '../PrismManagerSheetView.tsx'
import RuntimeSheetView from '../RuntimeSheetView.tsx'
import OverviewSheetView from '../OverviewSheetView.tsx'
import SearchSheetView from '../search/SearchSheetView.tsx'
import HistorySheetView from '../history/HistorySheetView.tsx'
import GatewaySheetView from '../gateway/GatewaySheetView.tsx'
import type { SheetContext, SheetKind, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((command: string) => {
    if (command === 'list_runtime_logs' || command === 'gateway_sessions' || command === 'gateway_catalog' || command === 'gateway_instances' || command === 'list_persisted_sessions') return Promise.resolve([])
    if (command === 'gateway_status') return Promise.resolve({ adapters: [], routes: [], qq: null, inject: null })
    if (command === 'startup_diagnostics') return Promise.resolve({})
    return Promise.resolve(null)
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(() => Promise.resolve(null)) }))
vi.mock('../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: false, hasTauriRuntime: () => false }))

afterEach(cleanup)

const sheet = (kind: SheetKind): SheetRecord => ({ id: kind, kind, title: kind, createdAt: 0, lastFocusedAt: 0 })
const ctx = (sidebarCollapsed: boolean) => ({
  sidebarCollapsed,
  openSheet: vi.fn(),
  focusSheet: vi.fn(),
  closeSheet: vi.fn(),
  selectSession: vi.fn(),
} as unknown as SheetContext)

const cases = [
  ['prism', PrismManagerSheetView, '.ps-nav'],
  ['runtime', RuntimeSheetView, '.runtime-sidebar'],
  ['overview', OverviewSheetView, '.overview-sidebar'],
  ['search', SearchSheetView, '.search-sidebar'],
  ['history', HistorySheetView, '.history-sidebar'],
  ['gateway', GatewaySheetView, '.gateway-sidebar'],
] as const

/** 退休的宽度 token 与几何工具类：任何一个回到 Sheet 手里都意味着又出现第二条宽度来源。 */
const SHEET_OWNED_GEOMETRY = /sheet-sidebar-width|workspace-sidebar-track-width|workspace-sidebar-collapsed-width|titlebar-sidebar-width|\bw-\[|\bbasis-\[|\bborder-r\b/

describe('#154 Sheet 左栏只出内容，几何归布局层', () => {
  for (const [kind, Component, selector] of cases) {
    it(`${kind}：左栏挂共享几何类 .sidebar`, () => {
      const { container } = render(<Component sheet={sheet(kind)} ctx={ctx(false)} />)
      const sidebar = container.querySelector(selector) as HTMLElement
      expect(sidebar).not.toBeNull()
      expect(sidebar).toHaveClass('sidebar')
    })

    it(`${kind}：左栏不再自带宽度 / flex 基准 / 竖边框`, () => {
      const { container } = render(<Component sheet={sheet(kind)} ctx={ctx(false)} />)
      const sidebar = container.querySelector(selector) as HTMLElement
      expect(sidebar.className).not.toMatch(SHEET_OWNED_GEOMETRY)
    })

    it(`${kind}：折叠时左栏仍在 DOM，可见性交给布局层状态`, () => {
      const { container, rerender } = render(<Component sheet={sheet(kind)} ctx={ctx(false)} />)
      expect(container.querySelector(selector)).not.toBeNull()
      rerender(<Component sheet={sheet(kind)} ctx={ctx(true)} />)
      // 布局层用 .layout[data-sidebar="collapsed"] .sidebar { visibility:hidden } 负责不可见，
      // 因此这里必须仍然存在——Sheet 再自行摘节点就会与布局状态脱钩。
      expect(container.querySelector(selector)).not.toBeNull()
    })
  }
})
