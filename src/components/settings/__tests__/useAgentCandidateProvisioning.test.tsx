// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentCandidateProvisioning } from '../useAgentCandidateProvisioning.ts'
import { reportRuntimeError } from '../../../app/runtimeError.ts'
import { resetStores } from '../../../test/resetStores.ts'
import type { AgentRuntimeCandidate } from '../../../domains/agent/agentDetector.ts'
import { appClients } from '../../../app/appClients.ts'
import type { AgentEntry } from '../../../domains/identity/identityStore.ts'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})

const candidate: AgentRuntimeCandidate = {
  candidateId: 'detected:hermes', detectorId: 'builtin.detector.hermes', provider: 'hermes',
  suggestedAgentId: 'hermes', name: 'Hermes', executable: 'hermes.exe', args: ['acp'],
  evidence: [], identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [],
}

function mount(agents: AgentEntry[] = []) {
  const options = {
    agentClient: appClients.agent(),
    agents, reportPanelError: reportRuntimeError, resolvePanelError: vi.fn(),
    reportConfigMutationError: vi.fn(), setFeedback: vi.fn(), setConfigConflict: vi.fn(),
    notify: vi.fn(),
  }
  return { ...renderHook(() => useAgentCandidateProvisioning(options)), options }
}

describe('候选验证与导入生命周期', () => {
  beforeEach(() => {
    resetStores()
    invoke.mockReset()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'test_agent_candidate') return { ok: true, agentId: 'hermes', durationMs: 10 }
      if (command === 'agent_config_snapshot') return { revision: 'rev-1', agents: [] }
      if (command === 'update_agents_config') return { applied: true, revision: 'rev-2' }
      if (command === 'list_agents') return [{ id: 'hermes', name: 'Hermes', transport: 'subprocess', exe: 'hermes.exe', args: ['acp'] }]
      return null
    })
  })

  it('导入只保存配置，使用动作才切换运行时', async () => {
    const { result, options } = mount()
    await act(() => result.current.validateAndImportCandidate(candidate))
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([command]) => command === 'switch_agent')).toHaveLength(0)
    expect(options.notify).toHaveBeenCalledWith(expect.stringContaining('已导入'))
  })

  it('不同提供方的标识冲突提示修改标识，不误报已导入', async () => {
    const { result } = mount([{ id: 'hermes', name: 'Another', provider: 'peri' }])
    await act(() => result.current.validateAndImportCandidate(candidate))
    expect(result.current.candidateErrors[candidate.candidateId]).toContain('请调整标识')
    expect(result.current.importedCandidateIds[candidate.candidateId]).toBeUndefined()
    expect(invoke.mock.calls.filter(([command]) => command === 'test_agent_candidate')).toHaveLength(0)
  })

  it('已配置相同提供方时展示可使用状态，不创建重复实例', async () => {
    const { result } = mount([{ id: 'existing-hermes', name: 'Hermes', provider: 'hermes' }])
    await act(() => result.current.validateAndImportCandidate(candidate))
    expect(result.current.importedCandidateIds[candidate.candidateId]).toBe('existing-hermes')
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(0)
  })

  it('验证期间编辑草稿，迟到成功不得落盘', async () => {
    let finish: ((value: unknown) => void) | undefined
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((command: string, args?: unknown) => command === 'test_agent_candidate'
      ? new Promise(resolve => { finish = resolve }) : original(command, args))
    const { result } = mount()
    let operation: Promise<void> | undefined
    act(() => { operation = result.current.validateAndImportCandidate(candidate) })
    await waitFor(() => expect(finish).toBeDefined())
    act(() => result.current.updateCandidateDraft(candidate, { executable: 'other.exe' }))
    await act(async () => { finish?.({ ok: true, agentId: 'hermes', durationMs: 10 }); await operation })
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(0)
    expect(result.current.candidateValidation[candidate.candidateId]).toBeUndefined()
  })

  it('卸载后的成功验证不得继续保存配置', async () => {
    let finish: ((value: unknown) => void) | undefined
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((command: string, args?: unknown) => command === 'test_agent_candidate'
      ? new Promise(resolve => { finish = resolve }) : original(command, args))
    const { result, unmount } = mount()
    let operation: Promise<void> | undefined
    act(() => { operation = result.current.validateAndImportCandidate(candidate) })
    unmount()
    await act(async () => { finish?.({ ok: true, agentId: 'hermes', durationMs: 10 }); await operation })
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(0)
  })

  it('保存失败后重试复用同一草稿的成功握手', async () => {
    const original = invoke.getMockImplementation()!
    let writes = 0
    invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'update_agents_config' && writes++ === 0) throw new Error('disk full')
      return original(command, args)
    })
    const { result } = mount()
    await act(() => result.current.validateAndImportCandidate(candidate))
    await act(() => result.current.validateAndImportCandidate(candidate))
    expect(invoke.mock.calls.filter(([command]) => command === 'test_agent_candidate')).toHaveLength(1)
    expect(writes).toBe(2)
  })

  it('取消验证后的迟到成功不会落盘，也不覆盖下一次验证', async () => {
    let finishOld: ((value: unknown) => void) | undefined
    const original = invoke.getMockImplementation()!
    let tests = 0
    invoke.mockImplementation((command: string, args?: unknown) => command === 'test_agent_candidate' && tests++ === 0
      ? new Promise(resolve => { finishOld = resolve }) : original(command, args))
    const { result } = mount()
    let oldOperation: Promise<void> | undefined
    act(() => { oldOperation = result.current.validateAndImportCandidate(candidate) })
    act(() => result.current.cancelCandidateValidation())
    await act(() => result.current.validateAndImportCandidate(candidate))
    await act(async () => { finishOld?.({ ok: true, agentId: 'hermes', durationMs: 10 }); await oldOperation })
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(1)
    expect(result.current.importedCandidateIds[candidate.candidateId]).toBe('hermes')
  })

  it('写盘成功但列表刷新失败，仍记住已导入，重试不创建第二份配置', async () => {
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'list_agents') throw new Error('list unavailable')
      return original(command, args)
    })
    const { result } = mount()
    await act(() => result.current.validateAndImportCandidate(candidate))
    expect(result.current.candidateErrors[candidate.candidateId]).toContain('配置已保存')
    await act(() => result.current.validateAndImportCandidate(candidate))
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(1)
  })

  it('配置重载删除已导入 Agent 后可以重新导入', async () => {
    const { result, options, rerender } = mount()
    await act(() => result.current.validateAndImportCandidate(candidate))
    options.agents = [{ id: 'hermes', name: 'Hermes', transport: 'subprocess', exe: 'hermes.exe', args: ['acp'] }]
    rerender()
    options.agents = []
    rerender()
    expect(result.current.importedCandidateIds[candidate.candidateId]).toBeUndefined()
    await act(() => result.current.validateAndImportCandidate({ ...candidate, alreadyImportedAgentId: 'hermes' }))
    expect(invoke.mock.calls.filter(([command]) => command === 'update_agents_config')).toHaveLength(2)
  })
})
