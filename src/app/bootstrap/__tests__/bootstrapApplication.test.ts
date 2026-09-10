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
    fetchToolDictionary: async () => ({}),
    applyToolDictionary: () => {},
    fetchAgentStatus: async () => { calls.push('status'); return { agentId: 'peri', agent: 'Peri', status: 'connected' } },
    applyAgentStatus: (payload) => { calls.push(`applyStatus:${(payload as { status?: string }).status}`) },
    registerListeners: async () => { calls.push('listen'); return () => { calls.push('dispose') } },
    reportError: vi.fn(),
    resolveError: vi.fn(),
    setStatus: vi.fn(),
    cancelled: () => false,
  }
  return { deps: { ...base, ...overrides }, calls }
}

describe('bootstrapApplication', () => {
  it('成功路径：loading→ready，顺序 hydrate→fetch→apply→status→listen', async () => {
    const { deps, calls } = createDeps()
    expect(await bootstrapApplication(deps)).toBe('ready')
    expect(calls).toEqual(['hydrate', 'fetch', 'apply:1', 'status', 'applyStatus:connected', 'listen'])
    const setStatus = deps.setStatus as ReturnType<typeof vi.fn>
    const statuses = setStatus.mock.calls.map((call: Array<unknown>) => call[0])
    expect(statuses[0]).toBe('loading')
    expect(statuses[statuses.length - 1]).toBe('ready')
    expect(deps.resolveError).toHaveBeenCalledWith('恢复本地数据')
    expect(deps.resolveError).toHaveBeenCalledWith('读取 Agent 列表')
    expect(deps.resolveError).toHaveBeenCalledWith('应用 Agent 列表')
    expect(deps.resolveError).toHaveBeenCalledWith('应用工具归一化字典')
    expect(deps.resolveError).toHaveBeenCalledWith('读取 Agent 状态')
    expect(deps.resolveError).toHaveBeenCalledWith('注册事件监听')
  })

  it('Agent 列表失败 → degraded：applyAgents 不调用、本地工作区保留、可重试计数', async () => {
    const { deps, calls } = createDeps({ fetchAgents: async () => { throw new Error('list_agents down') } })
    expect(await bootstrapApplication(deps)).toBe('degraded')
    expect(calls).toEqual(['hydrate'])
    expect(deps.reportError).toHaveBeenCalledWith('读取 Agent 列表', expect.any(Error))
    expect(deps.setStatus).toHaveBeenLastCalledWith('degraded', expect.any(String))
  })

  it('必需 Agent sink 不可用时进入可重试 degraded，而不是卡在 loading', async () => {
    const error = Object.assign(new Error('必需插件服务不可用'), {
      code: 'plugin_service_unavailable',
    })
    const { deps, calls } = createDeps({ applyAgents: () => { throw error } })

    expect(await bootstrapApplication(deps)).toBe('degraded')
    expect(calls).toEqual(['hydrate', 'fetch'])
    expect(deps.reportError).toHaveBeenCalledWith('应用 Agent 列表', error)
    expect(deps.setStatus).toHaveBeenLastCalledWith('degraded', 'Agent 插件服务不可用')
  })

  it('sink implementation failure is degraded without being mislabeled unavailable', async () => {
    const { deps } = createDeps({ applyAgents: () => { throw new Error('projection rejected') } })

    expect(await bootstrapApplication(deps)).toBe('degraded')
    expect(deps.setStatus).toHaveBeenLastCalledWith('degraded', '应用 Agent 列表失败')
  })

  it('字典已读取但必需 dictionary sink 不可用时进入可重试 degraded', async () => {
    const error = Object.assign(new Error('必需插件服务不可用'), {
      code: 'plugin_service_unavailable',
    })
    const { deps, calls } = createDeps({ applyToolDictionary: () => { throw error } })

    expect(await bootstrapApplication(deps)).toBe('degraded')
    expect(calls).toEqual(['hydrate', 'fetch', 'apply:1'])
    expect(deps.reportError).toHaveBeenCalledWith('应用工具归一化字典', error)
    expect(deps.setStatus).toHaveBeenLastCalledWith('degraded', '工具字典插件服务不可用')
  })

  it('hydrateDomains 抛错 → degraded（单域损坏不拖垮全局）', async () => {
    const { deps } = createDeps({ hydrateDomains: () => { throw new Error('corrupt storage') } })
    expect(await bootstrapApplication(deps)).toBe('degraded')
    expect(deps.setStatus).toHaveBeenLastCalledWith('degraded', expect.any(String))
  })

  it('listener 注册失败 → degraded（但 agents 已应用、状态快照已写入）', async () => {
    const { deps, calls } = createDeps({ registerListeners: async () => { throw new Error('listen fail') } })
    expect(await bootstrapApplication(deps)).toBe('degraded')
    expect(calls).toEqual(['hydrate', 'fetch', 'apply:1', 'status', 'applyStatus:connected'])
  })

  it('非 Tauri（浏览器 demo）不 fetch，直接 ready', async () => {
    const { deps, calls } = createDeps({ isTauri: false })
    expect(await bootstrapApplication(deps)).toBe('ready')
    expect(calls).toEqual(['hydrate'])
  })

  it('fetch 返回前已取消（StrictMode 双挂载晚到）→ 不应用 agents', async () => {
    let resolveFetch!: (value: Array<{ id: string; name: string }>) => void
    const applyAgents = vi.fn()
    let cancelled = false
    const deps: Required<BootstrapDeps> = {
      isTauri: true,
      hydrateDomains: () => {},
      fetchAgents: () => new Promise(res => { resolveFetch = value => { cancelled = true; res(value) } }),
      applyAgents,
      fetchToolDictionary: async () => ({}),
      applyToolDictionary: () => {},
      fetchAgentStatus: async () => ({ agentId: 'peri', status: 'connected' }),
      applyAgentStatus: vi.fn(),
      registerListeners: async () => () => {},
      reportError: vi.fn(),
      resolveError: vi.fn(),
      setStatus: vi.fn(),
      cancelled: () => cancelled,
    }
    const pending = bootstrapApplication(deps)
    // I14-W6：hydrateDomains 可为 async，bootstrap 经 await——fetchAgents 在下一
    // 微任务才被调用；先让出当前微任务再 resolve，保持"fetch resolve 前已取消"语义
    await Promise.resolve()
    resolveFetch([{ id: 'peri', name: 'Peri' }])
    expect(await pending).toBe('cancelled')
    expect(applyAgents).not.toHaveBeenCalled()
  })

  it('状态快照查询失败 → 不降级（仍 ready，listener 正常注册，错误已报告）', async () => {
    const reportError = vi.fn()
    const { deps, calls } = createDeps({
      fetchAgentStatus: async () => { calls.push('status'); throw new Error('agent_status down') },
      reportError,
    })
    expect(await bootstrapApplication(deps)).toBe('ready')
    expect(calls).toEqual(['hydrate', 'fetch', 'apply:1', 'status', 'listen'])
    expect(reportError).toHaveBeenCalledWith('读取 Agent 状态', expect.any(Error))
    const setStatus = deps.setStatus as ReturnType<typeof vi.fn>
    const statuses = setStatus.mock.calls.map((call: Array<unknown>) => call[0])
    expect(statuses[statuses.length - 1]).toBe('ready')
  })

  it('未提供 fetchAgentStatus（浏览器/旧调用方）→ 跳过快照步骤，流程不受影响', async () => {
    const { deps, calls } = createDeps({
      fetchAgentStatus: undefined,
      applyAgentStatus: undefined,
    })
    expect(await bootstrapApplication(deps)).toBe('ready')
    expect(calls).toEqual(['hydrate', 'fetch', 'apply:1', 'listen'])
  })

  it('卸载后 hydrate 的迟到失败不创建新的错误通知', async () => {
    let rejectHydrate!: (error: unknown) => void
    let cancelled = false
    const reportError = vi.fn()
    const { deps } = createDeps({
      hydrateDomains: () => new Promise<void>((_resolve, reject) => { rejectHydrate = reject }),
      reportError,
      cancelled: () => cancelled,
    })
    const pending = bootstrapApplication(deps)
    cancelled = true
    rejectHydrate(new Error('old mount failed'))
    await expect(pending).resolves.toBe('cancelled')
    expect(reportError).not.toHaveBeenCalled()
  })
})
