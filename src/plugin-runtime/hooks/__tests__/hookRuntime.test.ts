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

  it('disable-plugin policy delegates plugin shutdown to the runtime owner', async () => {
    const disablePlugin = vi.fn(async () => undefined)
    const runtime = new HookRuntime(undefined, { onDisablePlugin: disablePlugin })
    const owner = createPluginIdentity('p.unhealthy', 'run-1')
    runtime.registry.register(owner, 'turn.failed', {
      id: 'always-fails',
      mode: 'notification',
      failurePolicy: 'disable-plugin',
      handler: () => { throw new Error('hook exploded') },
    })

    await expect(runtime.invoke('turn.failed', {})).resolves.toMatchObject({ action: 'continue' })
    expect(disablePlugin).toHaveBeenCalledOnce()
    expect(disablePlugin).toHaveBeenCalledWith('p.unhealthy')
  })

  it('P55-D1：externalSignal abort 传播到 handler 内部 signal，且不传时行为不变', async () => {
    const runtime = new HookRuntime()
    const owner = createPluginIdentity('p.external', 'run-1')
    const handlerSignals: AbortSignal[] = []
    runtime.registry.register(owner, 'message.user.beforeSend', {
      id: 'waits-abort',
      mode: 'pipeline',
      timeoutMs: 5_000,
      failurePolicy: 'continue',
      handler: ({ signal }) => new Promise<never>((_resolve, reject) => {
        handlerSignals.push(signal)
        signal.addEventListener('abort', () => reject(new Error(`aborted: ${String(signal.reason)}`)))
      }),
    })

    // externalSignal abort → handler 内部 controller.abort → invoke 按 continue 失败策略收口。
    const external = new AbortController()
    const invocation = runtime.invoke('message.user.beforeSend', { text: 'x' }, undefined, external.signal)
    await vi.waitFor(() => expect(handlerSignals).toHaveLength(1))
    external.abort('bridge timeout')
    await expect(invocation).resolves.toMatchObject({ action: 'continue', event: { text: 'x' } })
    expect(handlerSignals[0]?.aborted).toBe(true)

    // 不传 externalSignal：invoke 行为等价（handler 正常返回仍生效）。
    const runtime2 = new HookRuntime()
    const owner2 = createPluginIdentity('p.no-signal', 'run-1')
    runtime2.registry.register(owner2, 'message.user.beforeSend', {
      id: 'plain',
      mode: 'pipeline',
      handler: ({ event }) => ({ action: 'continue', event: { ...(event as { text: string }), text: `${(event as { text: string }).text}!` } }),
    })
    await expect(runtime2.invoke('message.user.beforeSend', { text: 'ok' })).resolves.toMatchObject({
      action: 'continue', event: { text: 'ok!' }, executed: 1,
    })
  })

  it('records a stable diagnostic when disable-plugin cleanup cannot complete', async () => {
    const runtime = new HookRuntime(undefined, {
      onDisablePlugin: async () => { throw new Error('scope resource cleanup failed') },
    })
    const owner = createPluginIdentity('p.cleanup-failed', 'run-1')
    runtime.registry.register(owner, 'turn.failed', {
      id: 'always-fails',
      mode: 'notification',
      failurePolicy: 'disable-plugin',
      handler: () => { throw new Error('hook exploded') },
    })

    await expect(runtime.invoke('turn.failed', {})).resolves.toMatchObject({ action: 'continue' })
    expect(runtime.traceSnapshot().entries.at(-1)).toMatchObject({
      pluginId: 'p.cleanup-failed',
      handlerId: 'always-fails',
      outcome: 'plugin-disable-failed',
      error: 'scope resource cleanup failed',
    })
  })

  it('short-circuits on trigger send and ignores actions from notifications', async () => {
    const runtime = new HookRuntime()
    const owner = createPluginIdentity('p.trigger', 'run-1')
    runtime.registry.register(owner, 'turn.completed', {
      id: 'send', mode: 'pipeline', handler: () => ({ action: 'send', message: 'follow up' }),
    })
    await expect(runtime.invoke('turn.completed', {})).resolves.toMatchObject({ action: 'send', message: 'follow up' })
    const notify = new HookRuntime()
    notify.registry.register(owner, 'turn.completed', {
      id: 'observe', mode: 'notification', handler: () => ({ action: 'cancel', reason: 'ignored' }),
    })
    await expect(notify.invoke('turn.completed', {})).resolves.toMatchObject({ action: 'continue' })
  })
})
