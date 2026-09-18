// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { useWorkspaceStore } from '../workspaceStore.ts'
import { openOrFocusSettingsSheet, SETTINGS_SHEET_KIND } from '../sheets/settingsSheetNavigation.ts'
import { resolveWorkspace } from '../workspace-sheets/workspaceRegistry.ts'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes.ts'
import type { SettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'
import Settings from '../components/Settings.tsx'
import SettingsSheetSidebar from '../sheets/SettingsSheetSidebar.tsx'
import '../plugin-runtime/testing/productPluginTestBootstrap.ts'

/**
 * Settings sheet 化（#154 阶段 4）的共享测试挂载助手。
 *
 * 与生产装配同构：openOrFocusSettingsSheet 在真实 workspaceStore 建 singleton sheet
 * （codec 归一 + 持久化），组件树按 SheetHost/SidebarSlot 的方式从 store 反应式读取
 * state——侧栏 patch 后主区跟手。旧覆盖层时代的 `<Settings initialDomain/>` 挂载由此退役。
 */
export function createSheetContext(overrides: Partial<SheetContext> = {}): SheetContext {
  return {
    openSheet: vi.fn(() => null),
    focusSheet: vi.fn(),
    closeSheet: vi.fn(),
    activeSession: null,
    selectSession: vi.fn(),
    openProfileEdit: vi.fn(),
    openSessionSettings: vi.fn(),
    sidebarCollapsed: false,
    rightInset: 0,
    ccEditMode: false,
    sessionSource: vi.fn(() => null),
    sessionBySource: vi.fn(() => undefined),
    ...overrides,
  }
}

function SettingsSheetHarness({ id, ctx }: { id: string; ctx: SheetContext }) {
  const sheet: SheetRecord | undefined = useWorkspaceStore(s => s.workspaceSheets.sheets.find(item => item.id === id))
  if (!sheet) return null
  const definition = resolveWorkspace(sheet.kind)
  if (!definition) return null
  const state = definition.deserialize(sheet.state) as SettingsSheetState
  // 生产里主区（SheetHost）与左栏（SheetSidebarSlot）分属两棵树；测试同文档并置。
  return (
    <>
      <SettingsSheetSidebar sheet={sheet} ctx={ctx} state={state} />
      <Settings sheet={sheet} ctx={ctx} state={state} />
    </>
  )
}

export function mountSettingsSheet(intent: { domain?: string; section?: string; agentId?: string } = {}) {
  const id = openOrFocusSettingsSheet(intent)
  if (!id) throw new Error(`settings sheet 打开失败（kind=${SETTINGS_SHEET_KIND} 未注册？）`)
  const ctx = createSheetContext()
  const ui = render(<SettingsSheetHarness id={id} ctx={ctx} />)
  return {
    ...ui,
    id,
    ctx,
    /** 读取 store 里该 sheet 的当前（已归一）导航态。 */
    sheetState: (): SettingsSheetState => {
      const sheet = useWorkspaceStore.getState().workspaceSheets.sheets.find(item => item.id === id)!
      return resolveWorkspace(sheet.kind)!.deserialize(sheet.state) as SettingsSheetState
    },
  }
}
