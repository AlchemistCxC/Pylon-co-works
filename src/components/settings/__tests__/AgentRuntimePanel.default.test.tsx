// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentRuntimePanel from '../AgentRuntimePanel'
import { useIdentityStore } from '../../../identityStore'
import { resetStores } from '../../../test/resetStores'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('AgentRuntimePanel 默认 Agent', () => {
  beforeEach(() => {
    resetStores()
    useIdentityStore.setState({
      activeAgent: 'peri',
      agents: [
        { id: 'peri', name: 'Peri', transport: 'subprocess', exe: 'peri', args: ['acp', 'work space'], effectiveArgs: ['acp', 'work space', '--model', 'demo'], default: true },
        { id: 'hermes', name: 'Hermes', transport: 'subprocess', exe: 'hermes', args: ['acp'], effectiveArgs: ['acp'], default: false },
      ],
    })
    invoke.mockReset()
    invoke.mockImplementation((command: string) => {
      if (command === 'detect_agent_runtimes') return Promise.resolve({ candidates: [], diagnostics: [], elapsedMs: 0, truncated: false })
      if (command === 'agent_config_snapshot') {
        return Promise.reject({ code: 'config_read_only', message: 'Config error: 当前为嵌入配置' })
      }
      if (command === 'update_agents_config') {
        return Promise.reject({ code: 'config_read_only', message: 'Config error: 当前为嵌入配置' })
      }
      if (command === 'initialize_agents_config') return Promise.resolve({ applied: true })
      if (command === 'list_agents') {
        return Promise.resolve([
          { id: 'peri', name: 'Peri', transport: 'subprocess', exe: 'peri', default: false },
          { id: 'hermes', name: 'Hermes', transport: 'subprocess', exe: 'hermes', default: true },
        ])
      }
      return Promise.resolve(null)
    })
  })

  it('嵌入配置只读时物化当前配置后设置默认 Agent', async () => {
    render(<AgentRuntimePanel />)

    const hermesCard = screen.getByText('Hermes').closest('.agent-runtime-card')
    expect(hermesCard).not.toBeNull()
    fireEvent.click(within(hermesCard as HTMLElement).getByRole('button', { name: '设为默认' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('initialize_agents_config', {
      agentId: 'hermes',
      config: { default: true },
    }))
    expect(await screen.findByRole('status')).toHaveTextContent('已将 hermes 设为默认')
  })

  it('外部配置新建 Agent 时发送结构化单 Agent DTO，而不是嵌套 agents 文档', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_config_snapshot') return Promise.resolve({ revision: 'rev-1', agents: [] })
      if (command === 'update_agents_config') return Promise.resolve({ applied: true, revision: 'rev-2' })
      if (command === 'list_agents') return Promise.resolve([])
      return Promise.resolve(null)
    })
    render(<AgentRuntimePanel />)

    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    fireEvent.change(screen.getByLabelText('新建 Agent id'), { target: { value: 'custom-agent' } })
    fireEvent.change(screen.getByLabelText('新建 Agent name'), { target: { value: 'Agent: #1' } })
    fireEvent.change(screen.getByLabelText('新建 Agent exe'), { target: { value: 'C:\\Program Files\\Agent\\agent.exe' } })
    fireEvent.change(screen.getByLabelText('新建 Agent 参数 1'), { target: { value: '--profile' } })
    const createForm = screen.getByLabelText('新建 Agent 配置')
    fireEvent.click(within(createForm).getByRole('button', { name: '添加参数' }))
    fireEvent.change(screen.getByLabelText('新建 Agent 参数 2'), { target: { value: 'work space' } })
    fireEvent.click(within(createForm).getByRole('button', { name: '添加参数' }))
    fireEvent.change(screen.getByLabelText('新建 Agent 参数 3'), { target: { value: '' } })
    fireEvent.click(within(createForm).getByRole('button', { name: '添加参数' }))
    fireEvent.change(screen.getByLabelText('新建 Agent 参数 4'), { target: { value: 'a"b' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', {
      scope: 'agent_create',
      agentId: 'custom-agent',
      config: {
        name: 'Agent: #1',
        provider: 'custom',
        transport: 'subprocess',
        exe: 'C:\\Program Files\\Agent\\agent.exe',
        args: ['--profile', 'work space', '', 'a"b'],
        default: false,
      },
      expectedRevision: 'rev-1',
    }))
  })

  it('嵌入配置首次新建时使用结构化 whole document 初始化', async () => {
    render(<AgentRuntimePanel />)

    fireEvent.click(screen.getByRole('button', { name: '新建 Agent' }))
    fireEvent.change(screen.getByLabelText('新建 Agent id'), { target: { value: 'new-agent' } })
    fireEvent.change(screen.getByLabelText('新建 Agent name'), { target: { value: 'New: #1' } })
    fireEvent.change(screen.getByLabelText('新建 Agent exe'), { target: { value: 'C:\\Agent Files\\agent.exe' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    const node = {
      name: 'New: #1',
      provider: 'custom',
      transport: 'subprocess',
      exe: 'C:\\Agent Files\\agent.exe',
      args: ['acp'],
      default: false,
    }
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', {
      scope: 'agent_create',
      agentId: 'new-agent',
      config: node,
    }))
    expect(invoke).toHaveBeenCalledWith('initialize_agents_config', {
      agentId: 'new-agent',
      config: { agents: { 'new-agent': node } },
    })
  })

  it('编辑现有 Agent 时保存参数数组并预览后端追加的 effective 参数', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_config_snapshot') return Promise.resolve({ revision: 'rev-1', agents: [] })
      if (command === 'update_agents_config') return Promise.resolve({ applied: true, revision: 'rev-2' })
      if (command === 'list_agents') return Promise.resolve([])
      return Promise.resolve(null)
    })
    render(<AgentRuntimePanel />)

    const periCard = screen.getByText('Peri').closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(periCard).getByRole('button', { name: '编辑' }))

    expect(within(periCard).getByText('peri acp "work space" --model demo')).toBeInTheDocument()
    fireEvent.change(within(periCard).getByLabelText('peri 参数 2'), { target: { value: 'new work space' } })
    fireEvent.click(within(periCard).getByRole('button', { name: '添加参数' }))
    fireEvent.click(within(periCard).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', {
      scope: 'agent_fields',
      agentId: 'peri',
      config: {
        name: 'Peri',
        exe: 'peri',
        provider: null,
        args: ['acp', 'new work space', ''],
      },
      expectedRevision: 'rev-1',
    }))
  })

  it('候选编辑后的参数数组在验证与导入之间保持一致', async () => {
    const candidate = {
      candidateId: 'detected:one',
      detectorId: 'detector.test',
      provider: 'custom',
      suggestedAgentId: 'detected',
      name: 'Detected',
      executable: 'C:\\Agent Files\\agent.exe',
      args: ['--profile', 'work space'],
      evidence: [{ kind: 'version', detail: 'fixture 9.9.9' }],
      identityConfidence: 'high',
      protocolAvailability: 'not_tested',
      warnings: [],
    }
    invoke.mockImplementation((command: string) => {
      if (command === 'detect_agent_runtimes') return Promise.resolve({
        candidates: [candidate],
        diagnostics: [{ code: 'version_probe_timeout', stage: 'version_probe', detectorId: 'detector.test', message: 'version timeout', retryable: true }],
        elapsedMs: 101,
        truncated: false,
      })
      if (command === 'test_agent_candidate') return Promise.resolve({ ok: true, agentId: 'detected', durationMs: 12 })
      if (command === 'agent_config_snapshot') return Promise.resolve({ revision: 'rev-1', agents: [] })
      if (command === 'update_agents_config') return Promise.resolve({ applied: true, revision: 'rev-2' })
      if (command === 'list_agents') return Promise.resolve([])
      return Promise.resolve(null)
    })
    render(<AgentRuntimePanel />)

    fireEvent.click(screen.getByRole('button', { name: '重新探测' }))
    const candidateCard = (await screen.findByText('Detected')).closest('.agent-runtime-card') as HTMLElement
    expect(within(candidateCard).getByText(/ACP：未验证/)).toBeInTheDocument()
    expect(screen.getByText(/version_probe_timeout.*version timeout/)).toBeInTheDocument()
    fireEvent.click(within(candidateCard).getByRole('button', { name: '添加参数' }))
    fireEvent.click(within(candidateCard).getByRole('button', { name: '添加参数' }))
    fireEvent.change(within(candidateCard).getByLabelText('Detected 参数 4'), { target: { value: 'a"b' } })
    fireEvent.click(within(candidateCard).getByRole('button', { name: '验证' }))

    const expectedArgs = ['--profile', 'work space', '', 'a"b']
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('test_agent_candidate', {
      agentId: 'detected',
      agent: {
        name: 'Detected',
        provider: 'custom',
        transport: 'subprocess',
        exe: 'C:\\Agent Files\\agent.exe',
        args: expectedArgs,
      },
    }))
    expect(within(candidateCard).getByText(/ACP：可用/)).toBeInTheDocument()
    fireEvent.click(await within(candidateCard).findByRole('button', { name: '导入' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_agents_config', {
      scope: 'agent_create',
      agentId: 'detected',
      config: {
        name: 'Detected',
        provider: 'custom',
        transport: 'subprocess',
        exe: 'C:\\Agent Files\\agent.exe',
        args: expectedArgs,
        default: false,
      },
      expectedRevision: 'rev-1',
    }))
  })

  it('CAS 冲突保留编辑草稿，并允许显式重新载入 revision', async () => {
    let snapshotCalls = 0
    invoke.mockImplementation((command: string) => {
      if (command === 'agent_config_snapshot') {
        snapshotCalls += 1
        return Promise.resolve({ revision: `rev-${snapshotCalls}`, agents: [] })
      }
      if (command === 'update_agents_config') {
        return Promise.reject({ code: 'config_revision_conflict', message: 'expected rev-1 actual rev-2' })
      }
      if (command === 'list_agents') return Promise.resolve([])
      return Promise.resolve(null)
    })
    render(<AgentRuntimePanel />)

    const periCard = screen.getByText('Peri').closest('.agent-runtime-card') as HTMLElement
    fireEvent.click(within(periCard).getByRole('button', { name: '编辑' }))
    const nameInput = within(periCard).getByLabelText('Agent name') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'Peri draft' } })
    fireEvent.click(within(periCard).getByRole('button', { name: '保存' }))

    expect(await screen.findByText(/配置已被其他进程修改/)).toBeInTheDocument()
    expect((within(periCard).getByLabelText('Agent name') as HTMLInputElement).value).toBe('Peri draft')
    fireEvent.click(screen.getByRole('button', { name: '重新载入配置' }))
    await waitFor(() => expect(snapshotCalls).toBe(2))
    expect(screen.getByText(/配置已重新载入；未提交草稿仍保留/)).toBeInTheDocument()
  })

  it('PendingRestart 显示显式重启按钮，成功后刷新为 Activated', async () => {
    useIdentityStore.setState({
      activeAgent: 'peri',
      agents: [{
        id: 'peri', name: 'Peri', transport: 'subprocess', exe: 'peri', args: ['acp'],
        effectiveArgs: ['acp'], default: true, configActivationState: 'pendingRestart',
      }],
    })
    invoke.mockImplementation((command: string) => {
      if (command === 'restart_agent_runtime') return Promise.resolve({ agentId: 'peri', configActivationState: 'activated' })
      if (command === 'list_agents') return Promise.resolve([{
        id: 'peri', name: 'Peri', transport: 'subprocess', exe: 'peri', args: ['acp'],
        effectiveArgs: ['acp'], default: true, configActivationState: 'activated',
      }])
      return Promise.resolve(null)
    })
    render(<AgentRuntimePanel />)

    expect(screen.getByText(/配置：待重启生效/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '立即重启应用此配置' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('restart_agent_runtime', { agentId: 'peri' }))
    expect(await screen.findByText(/配置：已生效/)).toBeInTheDocument()
  })

  it('runtime 重启失败时保留 PendingRestart', async () => {
    useIdentityStore.setState({
      activeAgent: 'peri',
      agents: [{ id: 'peri', name: 'Peri', exe: 'peri', configActivationState: 'pendingRestart' }],
    })
    invoke.mockImplementation((command: string) => {
      if (command === 'restart_agent_runtime') return Promise.reject({ code: 'agent_initialize_failed', message: 'bad initialize' })
      return Promise.resolve(null)
    })
    render(<AgentRuntimePanel />)
    fireEvent.click(screen.getByRole('button', { name: '立即重启应用此配置' }))

    expect(await screen.findByText(/重启 Agent runtime失败/)).toBeInTheDocument()
    expect(screen.getByText(/配置：待重启生效/)).toBeInTheDocument()
  })
})
