// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../Settings.tsx'
import { resetStores } from '../../test/resetStores.ts'
import { useIdentityStore } from '../../identityStore.ts'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({
  default: ({ initialAgentId }: { initialAgentId?: string }) => <div data-testid="agent-runtime-panel" data-agent-id={initialAgentId}>runtime onboarding</div>,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))

describe('Settings Agent onboarding', () => {
  beforeEach(() => {
    resetStores()
    useIdentityStore.setState({
      activeAgent: 'peri',
      agents: [{ id: 'peri', name: 'Peri', exe: '<PERI_EXE_PATH>', default: true }],
    })
  })

  it('进入 Agent 设置即挂载运行时发现入口，无需先展开高级组', () => {
    render(<Settings initialDomain="agents-connections" initialSection="agent" />)

    expect(screen.getByTestId('agent-runtime-panel')).toBeInTheDocument()
  })

  it('错误恢复入口把目标 Agent 传给运行时管理面板', () => {
    render(<Settings initialDomain="agents-connections" initialSection="agent" initialAgentId="peri" />)

    expect(screen.getByTestId('agent-runtime-panel')).toHaveAttribute('data-agent-id', 'peri')
  })
})
