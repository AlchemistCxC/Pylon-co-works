// @vitest-environment jsdom
// #515 W1：迁移自 useAgentDetection.test.tsx（React renderHook → Solid 实体直连）。
// 断言改写点登记（断言集零缩减）：
// 1. renderHook → Harness 组件直连 createAgentDetection（Solid 无 renderHook）；
//    hook 句柄在组件体捕获，断言读访问器（candidates()/detecting()/…）。
// 2. act 包装移除——Solid 信号写入同步传播；异步续延用 waitFor / 宏任务冲刷。
// 3. 显式 afterEach(cleanup())（solid testing library 不自动清理）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import { createAgentDetection } from '../useAgentDetection.solid.ts'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})

function report(id: string) {
  return { candidates: [{ candidateId: id, detectorId: 'd', provider: id, suggestedAgentId: id, name: id, executable: id + '.exe', args: [], evidence: [], identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [] }], diagnostics: [], elapsedMs: 10, truncated: false }
}

function mount() {
  let state: ReturnType<typeof createAgentDetection> | undefined
  const Harness = () => {
    state = createAgentDetection({ reportPanelError: vi.fn(), resolvePanelError: vi.fn(), setFeedback: vi.fn() })
    return null
  }
  const ui = render(() => <Harness />)
  return {
    get state() {
      if (!state) throw new Error('createAgentDetection has not been captured')
      return state
    },
    unmount: ui.unmount,
  }
}

const flushTask = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('Agent 探测生命周期', () => {
  beforeEach(() => { invoke.mockReset() })

  afterEach(() => cleanup())

  it('同一轮同步重复请求只启动一次探测', async () => {
    invoke.mockImplementation(() => new Promise(() => {}))
    const h = mount()
    void h.state.detectRuntimes(true)
    void h.state.detectRuntimes(true)
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(invoke.mock.calls.filter(([command]) => command === 'detect_agent_runtimes')).toHaveLength(1)
    h.unmount()
  })

  it('取消后可重探测，旧结果不得覆盖新结果', async () => {
    let finishOld: ((value: unknown) => void) | undefined
    let calls = 0
    invoke.mockImplementation((command: string) => {
      if (command === 'detect_agent_runtimes' && calls++ === 0) return new Promise(resolve => { finishOld = resolve })
      return Promise.resolve(command === 'detect_agent_runtimes' ? report('new') : true)
    })
    const h = mount()
    await waitFor(() => expect(finishOld).toBeDefined())
    h.state.cancelDetection()
    await h.state.detectRuntimes(true)
    finishOld?.(report('old'))
    await flushTask()
    expect(h.state.candidates().map(candidate => candidate.candidateId)).toEqual(['new'])
    expect(h.state.detecting()).toBe(false)
    expect(invoke).toHaveBeenCalledWith('cancel_detection_refresh', undefined)
  })

  it('重新探测须等待旧扫描的取消命令完成', async () => {
    let finishCancel: (() => void) | undefined
    invoke.mockImplementation((command: string) => command === 'cancel_detection_refresh'
      ? new Promise<void>(resolve => { finishCancel = resolve }) : new Promise(() => {}))
    const h = mount()
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'detect_agent_runtimes')).toHaveLength(1))
    h.state.cancelDetection()
    void h.state.detectRuntimes(true)
    expect(invoke.mock.calls.filter(([command]) => command === 'detect_agent_runtimes')).toHaveLength(1)
    finishCancel?.()
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'detect_agent_runtimes')).toHaveLength(2))
    h.unmount()
  })
})
