/**
 * switchAgentTransaction 行为测试（报告阶段 3.1）：
 * 成功提交顺序、失败不改变 activeAgent、openAgentSheet 可选。
 */
import { describe, expect, it, vi } from 'vitest'
import { switchAgentTransaction } from '../switchAgentTransaction'

function createDeps() {
  const calls: string[] = []
  const deps = {
    switchAgent: async (id: string) => { calls.push(`switch:${id}`) },
    resetRuntime: () => { calls.push('reset') },
    setActiveAgent: (id: string) => { calls.push(`setActive:${id}`) },
    fetchAgentStatus: async () => { calls.push('fetchStatus'); return { status: 'connected', generation: 4 } },
    applyAgentStatus: (id: string, status: { status: string }) => { calls.push(`applyStatus:${id}:${status.status}`) },
    reportError: vi.fn(),
    dispatchSwitched: () => { calls.push('dispatch') },
    openAgentSheet: (id: string, name: string) => { calls.push(`open:${id}:${name}`) },
  }
  return { deps, calls }
}

describe('switchAgentTransaction', () => {
  it('成功：switch → reset → setActive → fetch/apply 快照 → dispatch → openAgentSheet，返回 ok', async () => {
    const { deps, calls } = createDeps()
    const result = await switchAgentTransaction('peri', 'Peri', deps)
    expect(result).toEqual({ ok: true, value: 'peri' })
    expect(calls).toEqual(['switch:peri', 'reset', 'setActive:peri', 'fetchStatus', 'applyStatus:peri:connected', 'dispatch', 'open:peri:Peri'])
  })

  it('失败：不 setActive/dispatch/open，返回 transport 并报告错误', async () => {
    const { deps, calls } = createDeps()
    deps.switchAgent = async () => { throw new Error('连接失败') }
    const result = await switchAgentTransaction('peri', 'Peri', deps)
    expect(result).toEqual({ ok: false, kind: 'transport', message: '连接失败', cause: expect.any(Error) })
    expect(calls).toEqual([])
    expect(deps.reportError).toHaveBeenCalledWith('切换 Agent', expect.any(Error))
  })

  it('openAgentSheet 可选（Settings 场景）', async () => {
    const { deps, calls } = createDeps()
    const { openAgentSheet: _omitted, ...withoutOpen } = deps
    const result = await switchAgentTransaction('peri', 'Peri', withoutOpen)
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['switch:peri', 'reset', 'setActive:peri', 'fetchStatus', 'applyStatus:peri:connected', 'dispatch'])
  })

  it('快照查询失败不伪造 connected，切换仍成功并报告对账错误', async () => {
    const { deps, calls } = createDeps()
    deps.fetchAgentStatus = async () => { calls.push('fetchStatus'); throw new Error('status unavailable') }

    const result = await switchAgentTransaction('peri', 'Peri', deps)

    expect(result).toEqual({ ok: true, value: 'peri' })
    expect(calls).toEqual(['switch:peri', 'reset', 'setActive:peri', 'fetchStatus', 'dispatch', 'open:peri:Peri'])
    expect(deps.reportError).toHaveBeenCalledWith('对账 Agent 状态', expect.any(Error))
  })
})
