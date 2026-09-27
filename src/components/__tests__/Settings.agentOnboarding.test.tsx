// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../test/fakeInvoke'
import { mountSettingsSheet } from '../../test/settingsSheetHarness'
import { resetStores } from '../../test/resetStores.ts'
import { useIdentityStore } from '../../domains/identity/identityStore.ts'

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

  // #326：零 Agent 是合法首跑状态。此前该卡片回落硬编码 'peri'，会在没有这个 Agent 时
  // 显示一个不存在的名字/ID（与「预置必然失败的占位 Agent」同一类病）。
  it('零 Agent 时当前 Agent 概况如实空态，不伪造 Agent', () => {
    // 走生产路径：list_agents 返回空表 → store 清空 activeAgent（不是直接塞 ''）
    useIdentityStore.getState().setAgents([])
    expect(useIdentityStore.getState().activeAgent).toBe('')
    mountSettingsSheet({ domain: 'agents-connections', section: 'agent' })

    expect(screen.getByText('尚未配置 Agent')).toBeInTheDocument()
    expect(screen.queryByText('peri')).toBeNull()
    expect(screen.getByText('状态：未配置')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新连接' })).toBeDisabled()
    // 结构化新建入口照常可用（引导落点）
    expect(screen.getByTestId('agent-runtime-panel')).toBeInTheDocument()
  })
})
