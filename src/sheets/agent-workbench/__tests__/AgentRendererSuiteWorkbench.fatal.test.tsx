// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes.ts'
import { activateBuiltinPlugin, getPluginRuntime } from '../../../plugin-runtime/pluginCompositionRoot.ts'
import { resetStores } from '../../../test/resetStores.ts'
import AgentSheetView from '../../AgentSheetView.tsx'

vi.mock('../../../renderers/solid-workbench/loadSolidWorkbench.ts', () => ({
  loadSolidWorkbench: vi.fn(async () => { throw new Error('builtin solid prepare failed') }),
}))

const ctx: SheetContext = {
  openSheet: () => null, focusSheet: () => {}, closeSheet: () => {},
  activeSession: null, selectSession: () => {}, openProfileEdit: () => {}, openSessionSettings: () => {},
  sidebarCollapsed: false, rightInset: 0, ccEditMode: false,
  sessionSource: () => null, sessionBySource: () => undefined,
}
const sheet: SheetRecord = {
  id: 'agent-fatal', kind: 'agent', title: 'Agent', agentId: 'peri', createdAt: 1, lastFocusedAt: 1,
  state: { sidebarMode: 'work' },
}

beforeAll(async () => {
  await activateBuiltinPlugin('builtin.pylon-renderers')
})

afterAll(async () => {
  const active = getPluginRuntime().snapshot().active.find(item => item.pluginId === 'builtin.pylon-renderers')
  if (active) await getPluginRuntime().deactivate(active.key)
})

describe('Agent Workbench builtin Solid fatal banner', () => {
  beforeEach(resetStores)

  it('fatal 时显示纯错误横幅：仅重试与诊断两个入口，不渲染 document', async () => {
    render(<AgentSheetView sheet={sheet} ctx={ctx} />)
    const banner = await screen.findByLabelText('Renderer suite fatal banner', {}, { timeout: 5_000 })
    expect(banner).toHaveAttribute('data-suite-id', 'builtin.solid')
    // 纯横幅契约：只承载失败事实与两个动作，无 document 交互面
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(banner.textContent).toContain('渲染引擎失败')
    expect(banner.textContent).toContain('builtin solid prepare failed')
    expect(banner.querySelector('[data-document-revision]')).toBeNull()
    expect(screen.queryByLabelText('React Workbench fatal fallback')).toBeNull()
  })

  it('打开诊断走既有 pylon:open-runtime-sheet 语义事件', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    render(<AgentSheetView sheet={sheet} ctx={ctx} />)
    await screen.findByLabelText('Renderer suite fatal banner', {}, { timeout: 5_000 })
    dispatchSpy.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '打开诊断' }))
    const events = dispatchSpy.mock.calls.map(call => call[0]).filter((event): event is CustomEvent =>
      event instanceof CustomEvent && event.type.startsWith('pylon:'))
    expect(events.map(event => event.type)).toContain('pylon:open-runtime-sheet')
  })

  it('手动重试后挂载仍失败则横幅回归（自动重试链路可达）', async () => {
    render(<AgentSheetView sheet={sheet} ctx={ctx} />)
    await screen.findByLabelText('Renderer suite fatal banner', {}, { timeout: 5_000 })

    fireEvent.click(screen.getByRole('button', { name: '重试 Solid' }))

    // 挂载持续失败（mock 恒抛错），自动重试耗尽后横幅必须重新出现
    await waitFor(() => expect(screen.getByLabelText('Renderer suite fatal banner'))
      .toHaveAttribute('data-suite-id', 'builtin.solid'), { timeout: 8_000 })
  })
})
