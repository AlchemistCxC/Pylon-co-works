// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../../components/Settings'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { resetStores } from '../../test/resetStores'
import SheetTabStrip from '../SheetTabStrip'
import WorkspaceTitlebar from '../WorkspaceTitlebar'
import type { SheetRecord } from '../sheetTypes'
import type { AgentStatus } from '../../components/settings/agentTypes'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const sheets: SheetRecord[] = [
  { id: 'peri-sheet', kind: 'agent', title: 'Peri', agentId: 'peri', createdAt: 1, lastFocusedAt: 1 },
  { id: 'hermes-sheet', kind: 'agent', title: 'Hermes', agentId: 'hermes', createdAt: 2, lastFocusedAt: 2 },
]

const status = (lifecycle: AgentStatus['status']): AgentStatus => ({
  agent: 'peri',
  agentId: 'peri',
  status: lifecycle,
})

function renderTabStrip(agentStatuses: Record<string, AgentStatus> = {}) {
  render(
    <SheetTabStrip
      sheets={sheets}
      activeSheetId="peri-sheet"
      activeAgent="peri"
      agentStatuses={agentStatuses}
      onFocus={vi.fn()}
      onClose={vi.fn()}
      menuActions={{
        onTogglePin: vi.fn(),
        onClose: vi.fn(),
        onCloseOthers: vi.fn(),
        onCloseRight: vi.fn(),
        onReopen: vi.fn(),
      }}
      canReopen={false}
    />,
  )
}

const titlebarActions = {
  onToggleSidebar: vi.fn(),
  onFocusSheet: vi.fn(),
  onCloseSheet: vi.fn(),
  menuActions: {
    onTogglePin: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseRight: vi.fn(),
    onReopen: vi.fn(),
  },
  onOpenSheet: vi.fn(),
  onReopenSheet: vi.fn(),
  onToggleRightPanel: vi.fn(),
  onToggleSettings: vi.fn(),
  onMinimize: vi.fn(),
  onToggleFullscreen: vi.fn(),
  onCloseWindow: vi.fn(),
}

describe('全消费方一致性（ISSUE-03 §6.4 L1：Settings、titlebar、SheetTabStrip 对同一输入得到同一语义）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    Element.prototype.scrollIntoView = vi.fn()
    useIdentityStore.setState({
      agents: [
        { id: 'peri', name: 'Peri' },
        { id: 'hermes', name: 'Hermes' },
      ],
      activeAgent: 'peri',
    })
  })

  describe('SheetTabStrip', () => {
    it('active agent 无快照 → tab 状态 unknown，不出现假绿 connected / 明确断开 disconnected', () => {
      renderTabStrip()

      const periTab = screen.getByRole('tab', { name: /Peri/ }).closest('.sheet-tab') as HTMLElement
      expect(periTab.dataset.agentState).toBe('unknown')
      expect(screen.getByLabelText('Agent 状态：unknown')).toBeInTheDocument()
      expect(screen.queryByLabelText('Agent 状态：connected')).toBeNull()
      expect(screen.queryByLabelText('Agent 状态：disconnected')).toBeNull()
    })

    it('快照到达（connected 事件）→ 同一帧更新为 connected', () => {
      renderTabStrip({ peri: status('connected') })

      const periTab = screen.getByRole('tab', { name: /Peri/ }).closest('.sheet-tab') as HTMLElement
      expect(periTab.dataset.agentState).toBe('connected')
      expect(screen.getByLabelText('Agent 状态：connected')).toBeInTheDocument()
    })

    it('非 active agent（即使有快照）→ tab 状态 inactive', () => {
      renderTabStrip({ hermes: status('error') })

      const hermesTab = screen.getByRole('tab', { name: /Hermes/ }).closest('.sheet-tab') as HTMLElement
      expect(hermesTab.dataset.agentState).toBe('inactive')
    })
  })

  describe('WorkspaceTitlebar（状态灯）', () => {
    it('无快照 → 状态灯全灰（mode none），不出现假绿 ok 灯', () => {
      render(
        <WorkspaceTitlebar
          {...titlebarActions}
          sheets={sheets}
          activeSheetId="peri-sheet"
          activeAgent="peri"
          sidebarCollapsed={false}
          sidebarEnabled={true}
          canReopenSheet={false}
        />,
      )

      const lights = document.querySelector('.agent-status-lights') as HTMLElement
      expect(lights.dataset.mode).toBe('none')
      expect(document.querySelector('.agent-light-ok')).toBeNull()
    })

    it('快照 connected → 状态灯进入 ok（cascade 模式，出现 ok 灯）', () => {
      useRuntimeStore.setState({ agentStatuses: { peri: status('connected') } })
      render(
        <WorkspaceTitlebar
          {...titlebarActions}
          sheets={sheets}
          activeSheetId="peri-sheet"
          activeAgent="peri"
          sidebarCollapsed={false}
          sidebarEnabled={true}
          canReopenSheet={false}
        />,
      )

      const lights = document.querySelector('.agent-status-lights') as HTMLElement
      expect(lights.dataset.mode).toBe('cascade')
      expect(document.querySelector('.agent-light-ok')).not.toBeNull()
    })
  })

  describe('Settings（Agent 状态区）', () => {
    // I13-W1：一级导航 = 稳定设置域——先入 Agent 与连接域，再选中 Agent section
    const openAgentTab = () => {
      fireEvent.click(within(document.querySelector('.settings-domain-rail') as HTMLElement).getByRole('button', { name: 'Agent' }))
      fireEvent.click(within(document.querySelector('.settings-nav') as HTMLElement).getByRole('button', { name: 'Agent' }))
    }

    it('无快照 → 状态显示“状态未知”，不出现假绿“已连接”', () => {
      render(<Settings />)
      openAgentTab()

      expect(screen.getByText('状态：状态未知')).toBeInTheDocument()
      expect(screen.queryByText('状态：已连接')).toBeNull()
    })

    it('快照 connected → 状态显示“已连接”', () => {
      useRuntimeStore.setState({ agentStatuses: { peri: status('connected') } })
      render(<Settings />)
      openAgentTab()

      expect(screen.getByText('状态：已连接')).toBeInTheDocument()
    })

    it('失败事件（error + 诊断）→ 状态错误且显示最近错误', () => {
      useRuntimeStore.setState({
        agentStatuses: {
          peri: { agent: 'peri', agentId: 'peri', status: 'error', recentError: '心跳超时' },
        },
      })
      render(<Settings />)
      openAgentTab()

      expect(screen.getByText('状态：错误')).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent('最近错误：心跳超时')
    })
  })
})
