/**
 * bootstrapApplication 纯函数测试（报告阶段 2 测试门）：
 * 顺序固定、agents 失败 degraded、listener 失败 degraded、浏览器直通 ready、
 * StrictMode 双挂载晚到结果不应用。
 */
import { describe, expect, it, vi } from 'vitest'
import { bootstrapApplication, type BootstrapDeps } from '../bootstrapApplication'

function createDeps(overrides: Partial<BootstrapDeps> = {}): { deps: Required<BootstrapDeps>; calls: string[] } {
  const calls: string[] = []
  const base: Required<BootstrapDeps> = {
    isTauri: true,
    hydrateDomains: () => { calls.push('hydrate') },
    fetchAgents: async () => { calls.push('fetch'); return [{ id: 'peri', name: 'Peri' }] },
    applyAgents: (agents) => { calls.push(`apply:${agents.length}`) },
    registerListeners: async () => { calls.push('listen'); return () => { calls.push('dispose') } },
    reportError: vi.fn(),
    setStatus: vi.fn(),
    cancelled: () => false,
  }
  return { deps: { ...base, ...overrides }, calls }
}

describe('bootstrapApplication', () => {
  it('成功路径：loading→ready，顺序 hydrate→fetch→apply→listen', async () => {
    const { deps, calls } = createDeps()
    expect(await bootstrapApplication(deps)).toBe('ready')
    expect(calls).toEqual(['hydrate', 'fetch', 'apply:1', 'listen'])
    const setStatus = deps.setStatus as ReturnType<typeof vi.fn>
    const statuses = setStatus.mock.calls.map((call: Array<unknown>) => call[0])
    expect(statuses[0]).toBe('loading')
    expect(statuses[statuses.length - 1]).toBe('ready')
  })

  it('Agent 列表失败 → degraded：applyAgents 不调用、本地工作区保留、可重试计数', async () => {
    const { deps, calls } = createDeps({ fetchAgents: async () => { throw new Error('list_agents down') } })
    expect(await bootstrapApplication(deps)).toBe('degraded')
    expect(calls).toEqual(['hydrate'])
    expect(deps.reportError).toHaveBeenCalledWith('读取 Agent 列表', expect.any(Error))
    expect(deps.setStatus).toHaveBeenLastCalledWith('degraded', expect.any(String))
  })

  it('hydrateDomains 抛错 → degraded（单域损坏不拖垮全局）', async () => {
    const { deps } = createDeps({ hydrateDomains: () => { throw new Error('corrupt storage') } })
    expect(await bootstrapApplication(deps)).toBe('degraded')
    expect(deps.setStatus).toHaveBeenLastCalledWith('degraded', expect.any(String))
  })

  it('listener 注册失败 → degraded（但 agents 已应用）', async () => {
    const { deps, calls } = createDeps({ registerListeners: async () => { throw new Error('listen fail') } })
    expect(await bootstrapApplication(deps)).toBe('degraded')
    expect(calls).toEqual(['hydrate', 'fetch', 'apply:1'])
  })

  it('非 Tauri（浏览器 demo）不 fetch，直接 ready', async () => {
    const { deps, calls } = createDeps({ isTauri: false })
    expect(await bootstrapApplication(deps)).toBe('ready')
    expect(calls).toEqual(['hydrate'])
  })

  it('fetch 返回前已取消（StrictMode 双挂载晚到）→ 不应用 agents', async () => {
    let resolveFetch!: (value: Array<{ id: string; name: string }>) => void
    const applyAgents = vi.fn()
    const deps: Required<BootstrapDeps> = {
      isTauri: true,
      hydrateDomains: () => {},
      fetchAgents: () => new Promise(res => { resolveFetch = res }),
      applyAgents,
      registerListeners: async () => () => {},
      reportError: vi.fn(),
      setStatus: vi.fn(),
      cancelled: () => true,
    }
    const pending = bootstrapApplication(deps)
    resolveFetch([{ id: 'peri', name: 'Peri' }])
    expect(await pending).toBe('cancelled')
    expect(applyAgents).not.toHaveBeenCalled()
  })
})
