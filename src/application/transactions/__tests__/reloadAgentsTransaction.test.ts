import { describe, expect, it, vi } from 'vitest'
import { reloadAgentsTransaction, type ReloadAgentsDeps } from '../reloadAgentsTransaction.ts'

// 下沉自 scripts/test-agent-reload-transaction.mts（P91 A2）：
// 原脚本在测试内复刻 Settings 内联事务 + 源码 token 断言；本文件改为对抽出的
// 纯事务模块做行为锁（原「测试内复刻」即施工书点名的抽取对象）。

function createDeps(overrides: Partial<ReloadAgentsDeps> = {}) {
  const calls: string[] = []
  let reloading = false
  const applied: unknown[] = []
  const deps: ReloadAgentsDeps = {
    isReloading: () => reloading,
    setReloading: value => {
      reloading = value
      calls.push(value ? 'reloading:on' : 'reloading:off')
    },
    reloadAgents: async () => {
      calls.push('reload_agents')
    },
    listAgents: async () => {
      calls.push('list_agents')
      return [
        { id: 'peri', name: 'Peri' },
        { id: 'worker', name: 'Worker' },
      ]
    },
    setAgents: agents => {
      calls.push('setAgents')
      applied.push(agents)
    },
    loadToolDictionary: async () => {
      calls.push('tool_dictionary')
    },
    reportError: vi.fn(),
    ...overrides,
  }
  return { deps, calls, applied }
}

describe('reloadAgentsTransaction 成功路径', () => {
  it('按序 reload → list → 应用列表 → 字典，清理 loading 并 resolve 通知', async () => {
    const { deps, calls, applied } = createDeps({
      resolveError: vi.fn(),
    })
    const ok = await reloadAgentsTransaction(deps)
    expect(ok).toBe(true)
    expect(calls).toEqual([
      'reloading:on',
      'reload_agents',
      'list_agents',
      'setAgents',
      'tool_dictionary',
      'reloading:off',
    ])
    expect(applied[0]).toEqual([
      { id: 'peri', name: 'Peri' },
      { id: 'worker', name: 'Worker' },
    ])
    expect(vi.mocked(deps.reportError)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.resolveError!)).toHaveBeenCalledWith('重载 Agent 配置')
    // finally 在 resolveError 之后仍执行：loading 必须已清
    expect(deps.isReloading()).toBe(false)
  })
})

describe('reloadAgentsTransaction 失败路径', () => {
  it('reload 失败：不查询列表、不应用，报告错误并清理 loading', async () => {
    const { deps, calls, applied } = createDeps({
      reloadAgents: async () => {
        calls.push('reload_agents')
        throw new Error('reload failed')
      },
    })
    const ok = await reloadAgentsTransaction(deps)
    expect(ok).toBe(false)
    expect(calls).not.toContain('list_agents')
    expect(calls).not.toContain('setAgents')
    expect(applied).toHaveLength(0)
    expect(deps.reportError).toHaveBeenCalledWith('重载 Agent 配置', expect.any(Error))
    expect(deps.isReloading()).toBe(false)
  })

  it('list 失败：不应用列表，保留既有状态', async () => {
    const { deps, calls, applied } = createDeps({
      listAgents: async () => {
        calls.push('list_agents')
        throw new Error('list failed')
      },
    })
    const ok = await reloadAgentsTransaction(deps)
    expect(ok).toBe(false)
    expect(calls).not.toContain('setAgents')
    expect(applied).toHaveLength(0)
    expect(deps.reportError).toHaveBeenCalledWith('重载 Agent 配置', expect.any(Error))
    expect(deps.isReloading()).toBe(false)
  })

  it('字典失败：列表已应用但事务报错，loading 仍清理', async () => {
    const { deps, applied } = createDeps({
      loadToolDictionary: async () => {
        throw new Error('dictionary failed')
      },
    })
    const ok = await reloadAgentsTransaction(deps)
    expect(ok).toBe(false)
    expect(applied).toHaveLength(1)
    expect(deps.reportError).toHaveBeenCalledWith('重载 Agent 配置', expect.any(Error))
    expect(deps.isReloading()).toBe(false)
  })
})

describe('reloadAgentsTransaction 重入保护', () => {
  it('reloading 期间重入直接忽略，不触碰任何依赖', async () => {
    const reloadAgents = vi.fn()
    const { deps, calls } = createDeps({ reloadAgents })
    const ok = await reloadAgentsTransaction({ ...deps, isReloading: () => true })
    expect(ok).toBe(false)
    expect(reloadAgents).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})
