/** @jsxImportSource solid-js */
// @vitest-environment jsdom
/**
 * #520 回归钉：SheetSidebarSlot 切 kind 时侧栏组件必须切换。
 *
 * 缺陷复盘：非键控 Show 只认真值翻转——「组件+state」包成对象当 when，agent→settings
 * 切换时两侧皆有侧栏（truthy→truthy），子级不重跑，首次捕获的 Sidebar 组件滞留
 * （实测：打开设置页左栏仍为 agent 侧栏）。修复 = 组件身份单独作 keyed Show 的
 * when（组件引用按 kind 稳定 ⇒ 只在 kind/注册表变化时重挂），state 走响应式 prop。
 *
 * 本测试用真实注册表 kinds（agent=workspace 级 Sidebar.solid / settings=sheet 级
 * SettingsSheetSidebar.solid），断言两侧 DOM 锚点互斥切换。
 */
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import SheetSidebarSlot from '../SheetSidebarSlot.solid.tsx'
import type { SheetContext, SheetRecord } from '../sheetTypes'
import { resetStores } from '../../test/resetStores'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'

afterEach(() => cleanup())

const agentSheet: SheetRecord = {
  id: 'agent.peri',
  kind: 'agent',
  title: 'Peri',
  createdAt: 0,
  lastFocusedAt: 0,
  agentId: 'peri',
}
const settingsSheet: SheetRecord = {
  id: 'settings',
  kind: 'settings',
  title: '设置',
  createdAt: 0,
  lastFocusedAt: 0,
}

const ctx: SheetContext = {
  openSheet: () => null,
  focusSheet: () => {},
  closeSheet: () => {},
  activeSession: null,
  selectSession: () => {},
  openProfileEdit: () => {},
  openSessionSettings: () => {},
  sidebarCollapsed: false,
  rightInset: 0,
  sessionSource: () => null,
  sessionBySource: () => undefined,
}

describe('SheetSidebarSlot 切 kind 侧栏切换（#520 回归钉）', () => {
  it('agent → settings：侧栏组件随 kind 切换（旧侧栏卸载、新侧栏挂载）', async () => {
    resetStores()
    const [sheet, setSheet] = createSignal<SheetRecord>(agentSheet)
    render(() => <SheetSidebarSlot sheet={sheet()} ctx={ctx} />)

    await waitFor(() => expect(document.querySelector('.agent-sidebar')).toBeTruthy())
    expect(document.querySelector('.settings-sheet-nav')).toBeNull()

    setSheet(settingsSheet)
    await waitFor(() => expect(document.querySelector('.settings-sheet-nav')).toBeTruthy())
    expect(document.querySelector('.agent-sidebar')).toBeNull()

    // 切回 agent：侧栏换回（双向都不滞留）
    setSheet(agentSheet)
    await waitFor(() => expect(document.querySelector('.agent-sidebar')).toBeTruthy())
    expect(document.querySelector('.settings-sheet-nav')).toBeNull()
  })
})
