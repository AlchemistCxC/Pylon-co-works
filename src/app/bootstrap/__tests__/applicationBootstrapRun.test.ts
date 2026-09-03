// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { startApplicationBootstrap } from '../applicationBootstrapRun'
import type { BootstrapDeps } from '../bootstrapApplication'

function createDeps(registerListeners: BootstrapDeps['registerListeners']): Omit<BootstrapDeps, 'cancelled'> {
  return {
    isTauri: true,
    hydrateDomains: () => {},
    fetchAgents: async () => [{ id: 'peri', name: 'Peri' }],
    applyAgents: () => {},
    registerListeners,
    reportError: vi.fn(),
    resolveError: vi.fn(),
    setStatus: vi.fn(),
  }
}

describe('Kernel/Application 边界 bootstrap harness', () => {
  it('浏览器 mock 模式可完成挂载，不读取 Tauri Agent 或注册 listener', async () => {
    const fetchAgents = vi.fn(async () => [{ id: 'peri', name: 'Peri' }])
    const registerListeners = vi.fn(async () => () => {})
    const run = startApplicationBootstrap({
      ...createDeps(registerListeners),
      isTauri: false,
      fetchAgents,
    })

    await expect(run.result).resolves.toBe('ready')
    expect(fetchAgents).not.toHaveBeenCalled()
    expect(registerListeners).not.toHaveBeenCalled()
    run.dispose()
  })

  it('Application 卸载时释放已注册 listener，重复 dispose 不重复释放', async () => {
    const disposeListener = vi.fn()
    const run = startApplicationBootstrap(createDeps(async () => disposeListener))

    await expect(run.result).resolves.toBe('ready')
    expect(disposeListener).not.toHaveBeenCalled()

    run.dispose()
    run.dispose()
    expect(disposeListener).toHaveBeenCalledTimes(1)
  })

  it('listener 注册迟于 Application 卸载时，迟到 handle 仍被释放', async () => {
    let resolveListener!: (dispose: () => void) => void
    const disposeListener = vi.fn()
    const run = startApplicationBootstrap(createDeps(
      () => new Promise(resolve => { resolveListener = resolve }),
    ))

    while (!resolveListener) await Promise.resolve()
    run.dispose()
    resolveListener(disposeListener)

    await expect(run.result).resolves.toBe('cancelled')
    expect(disposeListener).toHaveBeenCalledTimes(1)
  })

  it('重新挂载会创建新 listener，旧 listener 已释放且无重复存活', async () => {
    const activeListeners = new Set<number>()
    let nextListenerId = 0
    const registerListeners = vi.fn(async () => {
      const id = ++nextListenerId
      activeListeners.add(id)
      return () => { activeListeners.delete(id) }
    })

    const first = startApplicationBootstrap(createDeps(registerListeners))
    await expect(first.result).resolves.toBe('ready')
    expect(activeListeners.size).toBe(1)
    first.dispose()
    expect(activeListeners.size).toBe(0)

    const second = startApplicationBootstrap(createDeps(registerListeners))
    await expect(second.result).resolves.toBe('ready')
    expect(activeListeners.size).toBe(1)
    expect(registerListeners).toHaveBeenCalledTimes(2)
    second.dispose()
    expect(activeListeners.size).toBe(0)
  })
})
