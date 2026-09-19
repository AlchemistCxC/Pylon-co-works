// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../test/fakeInvoke'
import { mountSettingsSheet } from '../../test/settingsSheetHarness'
import { resetStores } from '../../test/resetStores.ts'
import { useIdentityStore } from '../../identityStore.ts'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({
  default: ({ initialAgentId }: { initialAgentId?: string }) => <div data-testid="agent-runtime-panel" data-agent-id={initialAgentId}>runtime onboarding</div>,
}))

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
/** 未注册命令 resolve undefined——挂载断言不关心后台 invoke 返回值 */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

const fakeInvoke = new TolerantFakeInvoke()
invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)

describe('Settings Agent onboarding', () => {
  beforeEach(() => {
    resetStores()
    useIdentityStore.setState({
      activeAgent: 'peri',
      agents: [{ id: 'peri', name: 'Peri', exe: '<PERI_EXE_PATH>', default: true }],
    })
  })

  it('进入 Agent 设置即挂载运行时发现入口，无需先展开高级组', () => {
    mountSettingsSheet({ domain: 'agents-connections', section: 'agent' })

    expect(screen.getByTestId('agent-runtime-panel')).toBeInTheDocument()
  })

  it('错误恢复入口把目标 Agent 传给运行时管理面板', () => {
    mountSettingsSheet({ domain: 'agents-connections', section: 'agent', agentId: 'peri' })

    expect(screen.getByTestId('agent-runtime-panel')).toHaveAttribute('data-agent-id', 'peri')
  })
})
