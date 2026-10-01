// @vitest-environment jsdom
import { cleanup, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SheetTabStrip from '../SheetTabStrip.solid.tsx'
import { selectAgentStatus, type AgentStatus } from '../../contracts/agentTypes'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { resetStores } from '../../test/resetStores'
import type { SheetRecord } from '../sheetTypes'

// #498：React 死桥随 #484 删除后，tab 状态矩阵（原 agentStatusConsumerMatrix.test.tsx 的
// SheetTabStrip 小节）由 Solid 实体承接。消费方一致性语义（ISSUE-03 §6.4 L1）不变：
// active agent 无快照 → unknown；快照到达 → connected 同帧；非 active → inactive。
// Settings/titlebar 两个消费方矩阵仍留在 agentStatusConsumerMatrix.test.tsx，此处不重复。

const sheets: SheetRecord[] = [
  { id: 'peri-sheet', kind: 'agent', title: 'Peri', agentId: 'peri', createdAt: 1, lastFocusedAt: 1 },
  { id: 'hermes-sheet', kind: 'agent', title: 'Hermes', agentId: 'hermes', createdAt: 2, lastFocusedAt: 2 },
]

const status = (agentId: string, lifecycle: AgentStatus['status']): AgentStatus => ({
  agent: agentId,
  agentId,
  status: lifecycle,
})

function renderStrip(agentStatuses: Record<string, AgentStatus> = {}) {
  // agentStatuses 走测试侧信号，模拟生产中 titlebar 经 latest() 投喂的运行时快照流。
  const [statuses, setStatuses] = createSignal(agentStatuses)
  const result = render(() => <SheetTabStrip latest={() => ({
    sheets,
    activeSheetId: 'peri-sheet',
    activeAgent: 'peri',
    agentStatuses: statuses(),
    onFocus: vi.fn(),
    onClose: vi.fn(),
    menuActions: { onTogglePin: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onReopen: vi.fn() },
    canReopen: false,
  })} />)
  return { ...result, setStatuses }
}

const tabOf = (name: string | RegExp) => screen.getByRole('tab', { name }).closest('.sheet-tab') as HTMLElement

describe('SheetTabStrip tab 状态矩阵（全消费方一致性 ISSUE-03 §6.4 L1）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useIdentityStore.setState({
      agents: [
        { id: 'peri', name: 'Peri' },
        { id: 'hermes', name: 'Hermes' },
      ],
      activeAgent: 'peri',
    })
  })

  afterEach(cleanup)

  it('active agent 无快照 → tab 状态 unknown，不出现假绿 connected / 明确断开 disconnected', () => {
    renderStrip()

    expect(tabOf(/Peri/).dataset.agentState).toBe('unknown')
    expect(screen.getByLabelText('Agent 状态：unknown')).toBeTruthy()
    expect(screen.queryByLabelText('Agent 状态：connected')).toBeNull()
    expect(screen.queryByLabelText('Agent 状态：disconnected')).toBeNull()
  })

  it('快照在挂载时已在 → 同帧渲染为 connected', () => {
    renderStrip({ peri: status('peri', 'connected') })

    expect(tabOf(/Peri/).dataset.agentState).toBe('connected')
    expect(screen.getByLabelText('Agent 状态：connected')).toBeTruthy()
  })

  it('快照在挂载后到达 → 状态同步级联为 connected（不丢帧）', () => {
    const { setStatuses } = renderStrip()
    expect(tabOf(/Peri/).dataset.agentState).toBe('unknown')

    setStatuses({ peri: status('peri', 'connected') })

    // Solid 信号同步传播：latest() 投喂的新快照当帧落到 data-agent-state。
    expect(tabOf(/Peri/).dataset.agentState).toBe('connected')
    expect(screen.getByLabelText('Agent 状态：connected')).toBeTruthy()
  })

  it('非 active agent（即使有快照）→ tab 状态 inactive', () => {
    renderStrip({ hermes: status('hermes', 'error') })

    expect(tabOf(/Hermes/).dataset.agentState).toBe('inactive')
    // 矩阵语义自检：同一输入在 selectAgentStatus 的裁决与消费方一致。
    expect(selectAgentStatus('hermes', 'peri', { hermes: status('hermes', 'error') }).status).toBe('inactive')
  })
})
