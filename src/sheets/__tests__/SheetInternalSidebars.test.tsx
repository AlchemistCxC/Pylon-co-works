// @vitest-environment jsdom
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

describe('Sheet 内置左栏折叠契约', () => {
  for (const [kind, Component, selector] of cases) {
    it(`${kind} 读取宿主 sidebarCollapsed，但侧栏状态仍由 Sheet 自己持有`, () => {
      const { container, rerender } = render(<Component sheet={sheet(kind)} ctx={ctx(false)} />)
      expect(container.querySelector(selector)).not.toBeNull()

      rerender(<Component sheet={sheet(kind)} ctx={ctx(true)} />)
      expect(container.querySelector(selector)).toBeNull()
    })
  }
})
