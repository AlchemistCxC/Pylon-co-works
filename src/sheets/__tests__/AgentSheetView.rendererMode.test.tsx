// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { resetStores } from '../../test/resetStores.ts'
import AgentSheetView from '../AgentSheetView.tsx'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'

vi.mock('../../components/chat/ChatView.tsx', () => ({
  default: (props: { sessionId: string | null; workspaceKind?: string; workspaceMode?: string; agentId?: string }) => (
    <div
      data-testid="chat-view-props"
      data-session={props.sessionId ?? ''}
      data-workspace-kind={props.workspaceKind ?? ''}
      data-workspace-mode={props.workspaceMode ?? ''}
      data-agent={props.agentId ?? ''}
    />
  ),
}))
vi.mock('../../components/ControlCenter.tsx', () => ({ default: () => null }))
vi.mock('../../components/PetCompanion.tsx', () => ({ default: () => null }))

const ctx: SheetContext = {
  openSheet: () => 'x', focusSheet() {}, closeSheet() {},
  activeSession: 'session-1', selectSession() {},
  openProfileEdit() {}, openSessionSettings() {},
  sidebarCollapsed: false, rightInset: 0, ccEditMode: false,
  sessionSource: () => 'local:s1', sessionBySource: () => undefined,
}

function sheet(state: unknown): SheetRecord {
  return {
    id: 'agent-sheet', kind: 'agent', title: 'Peri', agentId: 'peri',
    createdAt: 1, lastFocusedAt: 1, state,
  }
}

describe('AgentSheetView renderer mode context', () => {
  beforeEach(resetStores)

  it('把 Agent Workspace state 的 sidebarMode 传给 ChatView，损坏值回退 work', () => {
    const { rerender } = render(<AgentSheetView sheet={sheet({ sidebarMode: 'chat' })} ctx={ctx} />)
    const chat = screen.getByTestId('chat-view-props')
    expect(chat).toHaveAttribute('data-session', 'session-1')
    expect(chat).toHaveAttribute('data-workspace-kind', 'agent')
    expect(chat).toHaveAttribute('data-workspace-mode', 'chat')
    expect(chat).toHaveAttribute('data-agent', 'peri')

    rerender(<AgentSheetView sheet={sheet({ sidebarMode: 'broken' })} ctx={ctx} />)
    expect(screen.getByTestId('chat-view-props')).toHaveAttribute('data-workspace-mode', 'work')
  })

  it('按 Interface Mode 在现代工作台与冻结的终端工作台之间切换', () => {
    const { container, rerender } = render(<AgentSheetView sheet={sheet({ sidebarMode: 'work' })} ctx={ctx} />)
    expect(container.querySelector('[data-pylon-workbench="modern-gui"]')).not.toBeNull()
    expect(screen.getByText('AGENT WORKSPACE')).toBeTruthy()

    useInterfaceModeStore.setState({ interfaceMode: 'terminal-like' })
    rerender(<AgentSheetView sheet={sheet({ sidebarMode: 'work' })} ctx={ctx} />)
    expect(container.querySelector('[data-pylon-workbench="terminal-like"]')).not.toBeNull()
    expect(screen.queryByText('AGENT WORKSPACE')).toBeNull()
  })
})
