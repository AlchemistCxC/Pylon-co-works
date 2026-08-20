import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity'
import { PluginScope } from '../../pluginScope'
import { HookRuntime } from '../hookRuntime'
import { createPluginHookApi } from '../pluginHookApi'

describe('HookRuntime v2', () => {
  it('pipeline 按优先级 transform，并在 cancel 时短路', async () => {
    const runtime = new HookRuntime()
    const first = createPluginIdentity('p.first', 'run-1')
    const gate = createPluginIdentity('p.gate', 'run-1')
    const later = vi.fn()

    runtime.registry.register(first, 'message.user.beforeSend', {
      id: 'transform',
      mode: 'pipeline',
      priority: 10,
      handler: ({ event }) => ({ action: 'continue', event: { ...(event as { text: string }), text: `${(event as { text: string }).text}+a` } }),
    })
    runtime.registry.register(gate, 'message.user.beforeSend', {
      id: 'gate',
      mode: 'pipeline',
      priority: 20,
      handler: () => ({ action: 'cancel', reason: 'blocked' }),
    })
    runtime.registry.register(first, 'message.user.beforeSend', {
      id: 'later',
      mode: 'pipeline',
      priority: 30,
      handler: later,
    })

    const result = await runtime.invoke('message.user.beforeSend', { text: 'hello' })
    expect(result).toMatchObject({ action: 'cancel', reason: 'blocked', event: { text: 'hello+a' }, executed: 2 })
    expect(later).not.toHaveBeenCalled()
    expect(runtime.traceSnapshot().entries.map(trace => trace.outcome)).toEqual(['transformed', 'cancelled'])
  })

  it('tool beforeCall 支持 respond，跳过后续 handler', async () => {
    const runtime = new HookRuntime()
    const owner = createPluginIdentity('p.cache', 'run-1')
    const later = vi.fn()
    runtime.registry.register(owner, 'tool.beforeCall', {
      id: 'cache-hit',
      mode: 'pipeline',
      priority: 1,
      handler: () => ({ action: 'respond', output: { cached: true } }),
    })
    runtime.registry.register(owner, 'tool.beforeCall', {
      id: 'later',
      mode: 'pipeline',
      priority: 2,
      handler: later,
    })

    await expect(runtime.invoke('tool.beforeCall', { input: 1 })).resolves.toMatchObject({
      action: 'respond', output: { cached: true }, executed: 1,
    })
    expect(later).not.toHaveBeenCalled()
  })

  it('timeout + failure policy abort/disable-hook/circuit', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new HookRuntime(undefined, { failureLimit: 2 })
      const abortOwner = createPluginIdentity('p.abort', 'run-1')
      runtime.registry.register(abortOwner, 'message.user.beforeSend', {
        id: 'slow', mode: 'pipeline', timeoutMs: 50, failurePolicy: 'abort', handler: () => new Promise(() => undefined),
      })
      const promise = runtime.invoke('message.user.beforeSend', { text: 'x' })
      await vi.advanceTimersByTimeAsync(50)
      await expect(promise).resolves.toMatchObject({ action: 'cancel' })
      expect(runtime.traceSnapshot().entries.at(-1)?.outcome).toBe('timed-out')

      const disableOwner = createPluginIdentity('p.disable', 'run-1')
      let calls = 0
      runtime.registry.register(disableOwner, 'session.created', {
        id: 'bad', mode: 'notification', failurePolicy: 'disable-hook', handler: () => { calls += 1; throw new Error('boom') },
      })
      await runtime.invoke('session.created', {})
      await runtime.invoke('session.created', {})
      expect(calls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('background handler 不阻塞主调用，trace 在完成后更新', async () => {
    const runtime = new HookRuntime()
    const owner = createPluginIdentity('p.background', 'run-1')
    let resolveHandler!: () => void
    runtime.registry.register(owner, 'message.user.sent', {
      id: 'audit', mode: 'notification', execution: 'background', handler: () => new Promise<void>(resolve => { resolveHandler = resolve }),
    })

    await expect(runtime.invoke('message.user.sent', { id: 'm1' })).resolves.toMatchObject({ action: 'continue', executed: 1 })
    expect(runtime.traceSnapshot().entries).toEqual([])
    resolveHandler()
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.traceSnapshot().entries.at(-1)?.outcome).toBe('continued')
  })

  it('PluginHookApi 自动纳入 Scope，dispose 后 registration 消失', async () => {
    const runtime = new HookRuntime()
    const owner = createPluginIdentity('p.scope-hook', 'run-1')
    const scope = new PluginScope(owner.key)
    const api = createPluginHookApi(runtime, owner, scope)
    api.register('session.closed', { id: 'cleanup', mode: 'notification', handler: () => undefined })
    expect(runtime.hasEnabledHooks('session.closed')).toBe(true)
    await scope.dispose()
    expect(runtime.hasEnabledHooks('session.closed')).toBe(false)
  })

  it('drain 超时会 abort active invocation signal', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new HookRuntime()
      const owner = createPluginIdentity('p.drain', 'run-1')
      const aborted = vi.fn()
      runtime.registry.register(owner, 'context.beforeBuild', {
        id: 'long', mode: 'pipeline', timeoutMs: 60_000,
        handler: ({ signal }) => new Promise<void>(() => signal.addEventListener('abort', aborted)),
      })
      void runtime.invoke('context.beforeBuild', {})
      const draining = runtime.drain(owner.key, 100)
      await vi.advanceTimersByTimeAsync(100)
      await draining
      expect(aborted).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
