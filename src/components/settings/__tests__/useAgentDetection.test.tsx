// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentDetection } from '../useAgentDetection.ts'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})

function report(id: string) {
  return { candidates: [{ candidateId: id, detectorId: 'd', provider: id, suggestedAgentId: id, name: id, executable: id + '.exe', args: [], evidence: [], identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [] }], diagnostics: [], elapsedMs: 10, truncated: false }
}
function mount() {
  return renderHook(() => useAgentDetection({ reportPanelError: vi.fn(), resolvePanelError: vi.fn(), setFeedback: vi.fn() }))
}

describe('Agent 探测生命周期', () => {
  beforeEach(() => { invoke.mockReset() })

  it('同一轮同步重复请求只启动一次探测', async () => {
    invoke.mockImplementation(() => new Promise(() => {}))
    const { result, unmount } = mount()
    act(() => { void result.current.detectRuntimes(true); void result.current.detectRuntimes(true) })
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(invoke.mock.calls.filter(([command]) => command === 'detect_agent_runtimes')).toHaveLength(1)
    unmount()
  })

  it('取消后可重探测，旧结果不得覆盖新结果', async () => {
    let finishOld: ((value: unknown) => void) | undefined
    let calls = 0
    invoke.mockImplementation((command: string) => {
      if (command === 'detect_agent_runtimes' && calls++ === 0) return new Promise(resolve => { finishOld = resolve })
      return Promise.resolve(command === 'detect_agent_runtimes' ? report('new') : true)
    })
    const { result } = mount()
    await waitFor(() => expect(finishOld).toBeDefined())
    act(() => result.current.cancelDetection())
    await act(() => result.current.detectRuntimes(true))
    await act(async () => { finishOld?.(report('old')) })
    expect(result.current.candidates.map(candidate => candidate.candidateId)).toEqual(['new'])
    expect(result.current.detecting).toBe(false)
    expect(invoke).toHaveBeenCalledWith('cancel_detection_refresh', undefined)
  })

  it('重新探测须等待旧扫描的取消命令完成', async () => {
    let finishCancel: (() => void) | undefined
    invoke.mockImplementation((command: string) => command === 'cancel_detection_refresh'
      ? new Promise<void>(resolve => { finishCancel = resolve }) : new Promise(() => {}))
    const { result, unmount } = mount()
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'detect_agent_runtimes')).toHaveLength(1))
    act(() => result.current.cancelDetection())
    act(() => { void result.current.detectRuntimes(true) })
    expect(invoke.mock.calls.filter(([command]) => command === 'detect_agent_runtimes')).toHaveLength(1)
    await act(async () => { finishCancel?.() })
    expect(invoke.mock.calls.filter(([command]) => command === 'detect_agent_runtimes')).toHaveLength(2)
    unmount()
  })
})
