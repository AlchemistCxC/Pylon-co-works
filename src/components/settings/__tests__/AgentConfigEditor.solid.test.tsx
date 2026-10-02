// @vitest-environment jsdom
// #515：迁移自 AgentConfigEditor.test.tsx（React RTL → Solid 实体直连）。
// 断言改写点登记：
// 1. fireEvent.change（textarea）→ fireEvent.input（Solid onInput 等价 React
//    onChange 的即时输入流；原生 change 在 Solid 下仅 blur 触发）。
// 2. cleanup 由 afterEach(cleanup) 显式执行（同其余 solid 测试）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import AgentConfigEditor from '../AgentConfigEditor.solid.tsx'

afterEach(() => cleanup())

describe('AgentConfigEditor validation presentation', () => {
  it('keeps local validation text assertive and does not claim a missing tray entry', () => {
    render(() => <AgentConfigEditor agentId="peri" />)

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))

    expect(screen.getByRole('alert')).toHaveTextContent('配置不能为空')
    expect(screen.queryByText('保存失败，详情见右下角错误中心')).toBeNull()
  })
})

// ── #422：后端凭证门禁（config_verification_required）的自动补测重试 ──

const tauriInvoke = vi.fn()

vi.mock('../../../infrastructure/acp/tauriTransport.ts', () => ({
  tauriInvokeTransport: (cmd: string, args?: unknown) => tauriInvoke(cmd, args),
}))

// jsdom 无应用装配层：identityCrossDomainPort 未注册会让 setAgents 抛错，
// 与本组测试的凭证重试焦点无关，替换为空实现（实体经 getState() 消费）。
vi.mock('../../../domains/identity/identityStore.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../domains/identity/identityStore.ts')>()
  return {
    ...original,
    useIdentityStore: Object.assign(
      () => ({ setAgents: vi.fn() }),
      { getState: () => ({ setAgents: vi.fn() }) },
    ),
  }
})

const VALID_YAML = 'name: Peri\ntransport: subprocess\nexe: peri\n'

function enterConfig() {
  fireEvent.input(screen.getByRole('textbox', { name: 'Agent 配置' }), {
    target: { value: VALID_YAML },
  })
}

describe('AgentConfigEditor voucher retry (#422)', () => {
  beforeEach(() => {
    tauriInvoke.mockReset()
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'agent_config_snapshot') {
        return Promise.resolve({ revision: 'rev-1', agents: [], diagnostics: [] })
      }
      if (cmd === 'list_agents') return Promise.resolve([])
      return Promise.resolve(null)
    })
  })

  it('retries save after a successful connection probe when the gate demands a voucher', async () => {
    const updates = vi.fn()
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'update_agents_config') {
        updates()
        if (updates.mock.calls.length === 1) {
          return Promise.reject({ code: 'config_verification_required', message: 'config_verification_required: launch 变更需连接测试凭证' })
        }
        return Promise.resolve({ applied: true, revision: 'rev-2' })
      }
      if (cmd === 'test_agent_candidate') {
        return Promise.resolve({ ok: true, agentId: 'peri', durationMs: 5, error: null, launchPlan: {} })
      }
      if (cmd === 'agent_config_snapshot') {
        return Promise.resolve({ revision: 'rev-1', agents: [], diagnostics: [] })
      }
      if (cmd === 'list_agents') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(() => <AgentConfigEditor agentId="peri" />)
    enterConfig()
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(screen.getByText('配置已保存，Agent 列表已刷新')).toBeInTheDocument())
    expect(updates).toHaveBeenCalledTimes(2)
    // 补测必须走 agentYaml 整块通道（后端按整块替换语义签发凭证）
    expect(tauriInvoke).toHaveBeenCalledWith('test_agent_candidate', expect.objectContaining({
      agentId: 'peri',
      agentYaml: VALID_YAML,
    }))
  })

  it('does not retry and reports failure when the probe fails', async () => {
    const updates = vi.fn()
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'update_agents_config') {
        updates()
        return Promise.reject({ code: 'config_verification_required', message: 'config_verification_required: launch 变更需连接测试凭证' })
      }
      if (cmd === 'test_agent_candidate') {
        return Promise.resolve({ ok: false, agentId: 'peri', durationMs: 3, error: { code: 'agent_initialize_failed', message: '握手失败' }, launchPlan: {} })
      }
      if (cmd === 'agent_config_snapshot') {
        return Promise.resolve({ revision: 'rev-1', agents: [], diagnostics: [] })
      }
      if (cmd === 'list_agents') return Promise.resolve([])
      return Promise.resolve(null)
    })

    render(() => <AgentConfigEditor agentId="peri" />)
    enterConfig()
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(screen.getByText('保存失败，详情见右下角错误中心')).toBeInTheDocument())
    expect(updates).toHaveBeenCalledTimes(1)
    expect(tauriInvoke).toHaveBeenCalledWith('test_agent_candidate', expect.objectContaining({ agentYaml: VALID_YAML }))
  })

  it('surfaces non-gate errors without probing', async () => {
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'update_agents_config') {
        return Promise.reject({ code: 'config_revision_conflict', message: 'config_revision_conflict: 期望 rev-1，实际 rev-9' })
      }
      if (cmd === 'agent_config_snapshot') {
        return Promise.resolve({ revision: 'rev-1', agents: [], diagnostics: [] })
      }
      return Promise.resolve(null)
    })

    render(() => <AgentConfigEditor agentId="peri" />)
    enterConfig()
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => expect(screen.getByText('保存失败，详情见右下角错误中心')).toBeInTheDocument())
    expect(tauriInvoke).not.toHaveBeenCalledWith('test_agent_candidate', expect.anything())
  })
})
