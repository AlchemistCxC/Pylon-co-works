// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ContextPanelHost from '../ContextPanelHost.tsx'
import { getContextPanelRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes.ts'

const registrations: AsyncDisposable[] = []

const sheet: SheetRecord = {
  id: 'test-sheet',
  kind: 'test-context-host',
  title: '测试工作区',
  createdAt: 1,
  lastFocusedAt: 1,
}

const ctx: SheetContext = {
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
}

afterEach(async () => {
  await Promise.all(registrations.splice(0).map(registration => registration.dispose()))
  vi.restoreAllMocks()
})

describe('ContextPanelHost', () => {
  it('按 order 渲染贡献标签并隔离单个贡献的渲染错误', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = getContextPanelRegistry()
    const identity = createPluginIdentity('test.context.host', 'run-1')
    const BrokenPanel = () => { throw new Error('broken contribution') }
    const HealthyPanel = () => <div>健康面板内容</div>

    registrations.push(registry.register(identity, {
      id: 'broken',
      workspaceKind: sheet.kind,
      label: '故障',
      order: 100,
      renderKind: 'first-party-react',
      component: BrokenPanel,
    }))
    registrations.push(registry.register(identity, {
      id: 'healthy',
      workspaceKind: sheet.kind,
      label: '正常',
      order: 200,
      renderKind: 'first-party-react',
      component: HealthyPanel,
    }))

    render(<ContextPanelHost sheet={sheet} ctx={ctx} />)

    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['故障', '正常'])
    expect(screen.getByRole('alert')).toHaveTextContent('此插件面板暂时不可用')
    fireEvent.click(screen.getByRole('tab', { name: '正常' }))
    expect(screen.getByText('健康面板内容')).toBeInTheDocument()
  })
})
