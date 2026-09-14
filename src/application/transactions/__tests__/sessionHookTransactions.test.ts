import { afterEach, describe, expect, it } from 'vitest'
import type { MessageUserBeforeSendEvent } from '../../../plugin-runtime/hooks/hookTypes.ts'
import type { PluginHookApi } from '../../../plugin-runtime/hooks/pluginHookApi.ts'
import { getPluginRuntime } from '../../../plugin-runtime/pluginCompositionRoot'
import { runSessionBoundaryHook, runUserMessageBeforeHook } from '../sessionHookTransactions'

const temporaryPlugins = new Set<string>()

function installSendHook(id: string, register: (hooks: PluginHookApi) => void): void {
  getPluginRuntime().activateBuiltinSync({
    id,
    activate: ({ hooks }) => register(hooks),
  })
  temporaryPlugins.add(id)
}

afterEach(async () => {
  for (const id of [...temporaryPlugins]) {
    await getPluginRuntime().disable(id)
    temporaryPlugins.delete(id)
  }
})

const session = (hooks?: string[]) => ({
  id: 's1',
  agentId: 'peri',
  source: 'local:s1',
  hooks: hooks ?? [],
})

describe('sessionHookTransactions(API 1.3 单层契约)', () => {
  it('会话未 opt-in(hooks 空)时零派发,fail-closed 返回原文', async () => {
    const result = await runUserMessageBeforeHook(session(), 'hello')
    expect(result).toEqual({ blocked: false, content: 'hello' })
  })

  it('beforeSend:transform 协议改写 event.content(统一方言)', async () => {
    installSendHook('test.upper', hooks => {
      hooks.register<MessageUserBeforeSendEvent>('message.user.beforeSend', {
        id: 'upper',
        mode: 'pipeline',
        priority: 10,
        handler: ({ event }) => ({ action: 'continue', event: { ...event, content: event.content.toUpperCase() } }),
      })
    })
    const result = await runUserMessageBeforeHook(session(['test.upper']), 'hello')
    expect(result.blocked).toBe(false)
    expect(result.content).toBe('HELLO')
  })

  it('beforeSend:gate(cancel)阻断并带 reason', async () => {
    installSendHook('test.blocker', hooks => {
      hooks.register('message.user.beforeSend', {
        id: 'blocker',
        mode: 'pipeline',
        handler: () => ({ action: 'cancel', reason: '禁止发送' }),
      })
    })
    const result = await runUserMessageBeforeHook(session(['test.blocker']), 'hello')
    expect(result).toMatchObject({ blocked: true, reason: '禁止发送' })
  })

  it('session.created / session.closed 只对 opt-in 会话触发', async () => {
    const calls: string[] = []
    installSendHook('test.boundary', hooks => {
      for (const anchor of ['session.created', 'session.closed'] as const) {
        hooks.register(anchor, {
          id: `observe:${anchor}`,
          mode: 'notification',
          handler: ({ hookName }) => { calls.push(hookName) },
        })
      }
    })
    await runSessionBoundaryHook('session.created', session(['test.boundary']))
    await runSessionBoundaryHook('session.closed', session(['test.boundary']))
    // 未 opt-in 的会话完全不触发。
    await runSessionBoundaryHook('session.created', session([]))
    expect(calls).toEqual(['session.created', 'session.closed'])
  })
})
