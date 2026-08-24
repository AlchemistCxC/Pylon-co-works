// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ContextPanelHost from '../ContextPanelHost.tsx'
import { getContextPanelRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import type { AsyncDisposable } from '../../../plugin-runtime/registry/types.ts'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes.ts'
import AgentContextPanel from '../AgentContextPanel.tsx'
import { createPreviewWorkbenchServices } from '../../../renderers/solid-workbench/__fixtures__/previewWorkbenchServices.ts'
import { createWorkbenchHostPort } from '../../../renderers/solid-workbench/workbenchHostPort.ts'
import { publishActiveWorkbenchHostPort } from '../../../sheets/agent-workbench/activeWorkbenchHostPort.ts'
import { useStore } from '../../../store.ts'

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
  useStore.setState({ rightWidth: 260 })
  vi.restoreAllMocks()
})

describe('ContextPanelHost', () => {
  it('同 ID 插件热替换后重置旧错误边界并渲染健康实现', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = getContextPanelRegistry()
    const oldIdentity = createPluginIdentity('test.context.hot', 'old')
    const nextIdentity = createPluginIdentity('test.context.hot', 'next')
    const BrokenPanel = () => { throw new Error('old broken panel') }
    const HealthyPanel = () => <div>热替换后的健康面板</div>
    registrations.push(registry.register(oldIdentity, {
      id: 'hot-panel', workspaceKind: sheet.kind, label: '热替换', order: 100,
      renderKind: 'first-party-react', component: BrokenPanel,
    }))
    render(<ContextPanelHost sheet={sheet} ctx={ctx} />)
    expect(screen.getByRole('alert')).toHaveTextContent('此插件面板暂时不可用')

    const transaction = registry.beginShadowTransaction(nextIdentity, oldIdentity.key)
    transaction.register({
      id: 'hot-panel', workspaceKind: sheet.kind, label: '热替换', order: 100,
      renderKind: 'first-party-react', component: HealthyPanel,
    }, { contributionId: 'hot-panel', priority: 100 })
    act(() => { registrations.push(...transaction.commit()) })

    expect(screen.getByText('热替换后的健康面板')).toBeInTheDocument()
  })

  it('把生产主题中的右栏宽度注入布局 CSS 变量', () => {
    const registry = getContextPanelRegistry()
    const identity = createPluginIdentity('test.context.width', 'run-1')
    registrations.push(registry.register(identity, {
      id: 'width-panel', workspaceKind: sheet.kind, label: '宽度', order: 100,
      renderKind: 'first-party-react', component: () => <div>宽度内容</div>,
    }))
    useStore.setState({ rightWidth: 347 })

    render(<ContextPanelHost sheet={sheet} ctx={ctx} />)

    expect(screen.getByRole('complementary')).toHaveStyle({ '--right-width': '347px' })
  })

  it('agent 搜索消费当前 Suite Host Port 的 document 与会话 UI 状态', () => {
    const services = createPreviewWorkbenchServices()
    const agentSheet = { ...sheet, kind: 'agent' }
    const agentCtx = { ...ctx, activeSession: 'preview-session' }
    const hostPort = createWorkbenchHostPort({
      ...services,
      suiteId: 'builtin.solid',
      sheetId: agentSheet.id,
      sessionOwnerKey: 'owner-preview',
      sessionId: 'preview-session',
    })
    const release = publishActiveWorkbenchHostPort(agentSheet.id, hostPort)

    render(<AgentContextPanel sheet={agentSheet} ctx={agentCtx} />)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索消息' }), { target: { value: '迁移结果' } })

    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(hostPort.sessionUi.get('search-query', '')).toBe('迁移结果')
    release()
    services.destroy()
  })

  it('会话 owner 切换后重新订阅 Host Port namespace，不串搜索状态', async () => {
    const services = createPreviewWorkbenchServices()
    const agentSheet = { ...sheet, kind: 'agent' }
    let binding = {
      suiteId: 'builtin.solid', sheetId: agentSheet.id,
      sessionOwnerKey: 'owner-a', sessionId: 'session-a',
    }
    const hostPort = createWorkbenchHostPort({
      ...services, ...binding, binding: () => binding,
    })
    const release = publishActiveWorkbenchHostPort(agentSheet.id, hostPort)
    const view = render(<AgentContextPanel sheet={agentSheet} ctx={{ ...ctx, activeSession: 'session-a' }} />)

    fireEvent.change(screen.getByRole('textbox', { name: '搜索消息' }), { target: { value: 'first query' } })
    binding = { ...binding, sessionOwnerKey: 'owner-b', sessionId: 'session-b' }
    view.rerender(<AgentContextPanel sheet={agentSheet} ctx={{ ...ctx, activeSession: 'session-b' }} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: '搜索消息' })).toHaveValue(''))
    fireEvent.change(screen.getByRole('textbox', { name: '搜索消息' }), { target: { value: 'second query' } })

    binding = { ...binding, sessionOwnerKey: 'owner-a', sessionId: 'session-a' }
    view.rerender(<AgentContextPanel sheet={agentSheet} ctx={{ ...ctx, activeSession: 'session-a' }} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: '搜索消息' })).toHaveValue('first query'))
    release()
    services.destroy()
  })

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
