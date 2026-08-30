// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from '../Sidebar'
import { useIdentityStore } from '../../identityStore'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore'
import { resetStores } from '../../test/resetStores'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import ChatSessionsPanel from '../sidebar/ChatSessionsPanel.tsx'
import WorkspacesPanel from '../sidebar/WorkspacesPanel.tsx'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

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
  ccEditMode: false,
  sessionSource: () => null,
  sessionBySource: () => undefined,
}

describe('AgentSheet 左栏双分区', () => {
  const registrations: Array<{ dispose(): void | Promise<void> }> = []
  beforeAll(() => {
    const registry = getAgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar-sections', 'run-1')
    registrations.push(registry.register(identity, { id: 'test.work', mode: 'work', label: '工作', renderKind: 'first-party-react', component: WorkspacesPanel }))
    registrations.push(registry.register(identity, { id: 'test.chat', mode: 'chat', label: '聊天', renderKind: 'first-party-react', component: ChatSessionsPanel }))
  })
  afterAll(() => { for (const registration of registrations) void registration.dispose() })
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    useIdentityStore.setState({
      activeAgent: 'peri',
      activeProfileId: 'default',
      profiles: [{ id: 'default', name: 'Default', persona: '', model: '' }],
      sessions: [],
    })
    useWorkspaceEntityStore.setState({
      workspaces: [{
        id: 'workspace-1',
        agentId: 'peri',
        name: 'Pylon',
        rootPath: 'G:/Project/Pylon',
        createdAt: 1,
        lastActiveAt: 1,
        skills: [],
        mcpServerIds: [],
        hookPluginIds: [],
      }],
      hydrated: true,
    })
  })

  it('工作/聊天互斥切换，两个 contribution 都派发宿主新建事件', async () => {
    const { rerender } = render(<Sidebar ctx={ctx} state={{ sidebarMode: 'work' }} />)

    const events: CustomEvent[] = []
    const onNewSession = (event: Event) => events.push(event as CustomEvent)
    window.addEventListener('pylon:new-session', onNewSession)

    const work = await screen.findByRole('region', { name: '工作会话' })
    expect(useIdentityStore.getState().sessions).toHaveLength(0)
    fireEvent.click(within(work).getByRole('button', { name: '在 Pylon 中新建会话' }))
    expect(events[0]?.detail).toEqual({ workspaceId: 'workspace-1' })
    expect(useIdentityStore.getState().sessions).toHaveLength(0)

    rerender(<Sidebar ctx={ctx} state={{ sidebarMode: 'chat' }} />)
    const chat = await screen.findByRole('region', { name: '聊天会话' })
    fireEvent.click(within(chat).getByRole('button', { name: '新建聊天会话' }))
    expect(events[1]?.detail).toBeNull()
    expect(useIdentityStore.getState().sessions).toHaveLength(0)
    window.removeEventListener('pylon:new-session', onNewSession)
  })
})
