// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 settingsSheetHarness.tsx，React → Solid 实体直连）：
// - 挂载内核改 solid：`useWorkspaceStore(s => …)` → createZustandSignal（store 通知时
//   重算 sheet 记录），反序列化包 createMemo；子组件 props 经 JSX getter 保持响应式
//   （侧栏 patch 后主区跟手，与 React 版重渲语义一致）。
// - render(() => <X/>) 传函数；消费测试须显式 afterEach(() => cleanup())（solid testing
//   library 不自动清理）。mountSettingsSheet 返回面（getBy*/queryBy*/unmount）与
//   React RTL 同名同形，screen/within/fireEvent 由 @solidjs/testing-library 再导出。
import { render } from '@solidjs/testing-library'
import { createMemo, Show } from 'solid-js'
import { vi } from 'vitest'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore.ts'
import { openOrFocusSettingsSheet, SETTINGS_SHEET_KIND } from '../sheets/settingsSheetNavigation.ts'
import { resolveWorkspace } from '../plugin-runtime/workspaces/workspaceRegistry.ts'
import type { SheetContext } from '../workspace-sheets/sheetTypes.ts'
import type { SettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'
import Settings from '../components/Settings.solid.tsx'
import SettingsSheetSidebar from '../sheets/SettingsSheetSidebar.solid.tsx'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import '../plugin-runtime/testing/productPluginTestBootstrap.ts'

/**
 * Settings sheet 化（#154 阶段 4）的共享测试挂载助手。
 *
 * 与生产装配同构：openOrFocusSettingsSheet 在真实 workspaceStore 建 singleton sheet
 * （codec 归一 + 持久化），组件树按 SheetHost/SidebarSlot 的方式从 store 反应式读取
 * state——侧栏 patch 后主区跟手。旧覆盖层时代的 `<Settings initialDomain/>` 挂载由此退役。
 * #515：React 版退役，实体（Settings/SettingsSheetSidebar .solid.tsx）直连。
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
    sessionSource: vi.fn(() => null),
    sessionBySource: vi.fn(() => undefined),
    ...overrides,
  }
}

function SettingsSheetHarness(props: { id: string; ctx: SheetContext }) {
  // ⚠️ createZustandSignal 的 selector 只在 store 通知时重跑；props.id 是挂载期常量，不触发该限制。
  const sheet = createZustandSignal(
    useWorkspaceStore,
    s => s.workspaceSheets.sheets.find(item => item.id === props.id),
  )
  const state = createMemo(() => {
    const current = sheet()
    if (!current) return undefined
    const definition = resolveWorkspace(current.kind)
    return definition ? (definition.deserialize(current.state) as SettingsSheetState) : undefined
  })
  // 生产里主区（SheetHost）与左栏（SheetSidebarSlot）分属两棵树；测试同文档并置。
  return (
    <Show when={state()}>
      {resolved => (
        <>
          <SettingsSheetSidebar sheet={sheet()!} ctx={props.ctx} state={resolved()} />
          <Settings sheet={sheet()!} ctx={props.ctx} state={resolved()} />
        </>
      )}
    </Show>
  )
}

export function mountSettingsSheet(intent: { domain?: string; section?: string; agentId?: string } = {}) {
  const id = openOrFocusSettingsSheet(intent)
  if (!id) throw new Error(`settings sheet 打开失败（kind=${SETTINGS_SHEET_KIND} 未注册？）`)
  const ctx = createSheetContext()
  const ui = render(() => <SettingsSheetHarness id={id} ctx={ctx} />)
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
