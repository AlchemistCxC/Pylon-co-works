import { afterEach, describe, expect, it } from 'vitest'
import {
  type HookPhase,
  type HookRunner,
} from '../../../contracts/agentHook'
import { registerHookPhaseRunner } from '../../../plugin-runtime/hooks/hookPhaseAdapter.ts'
import { getPluginRuntime } from '../../../plugin-runtime/pluginCompositionRoot'
import { getHookRuntime } from '../../../plugin-runtime/runtimeServices.ts'
import { runSessionBoundaryHook, runUserMessageBeforeHook } from '../hookRuntime'

const temporaryPlugins = new Set<string>()

function installHook(id: string, phases: readonly HookPhase[], run: HookRunner['run']): void {
  getPluginRuntime().activateBuiltinSync({
    id,
    activate: ({ identity, scope }) => registerHookPhaseRunner(
      getHookRuntime(), identity, scope, `${id}.hook`, { phases, run }, 10,
    ),
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

describe('hookRuntime 接线（M3）', () => {
  it('未启用 hook 时 user.message.before 返回原文（同步路径语义）', async () => {
    const result = await runUserMessageBeforeHook(session(), 'hello')
    expect(result).toEqual({ blocked: false, content: 'hello' })
  })

  it('user.message.before：transform 改写发送文本', async () => {
    installHook('test.upper', ['user.message.before'], ctx => ({
      effect: 'transform',
      message: (ctx.message ?? '').toUpperCase(),
    }))
    const result = await runUserMessageBeforeHook(session(['test.upper']), 'hello')
    expect(result.blocked).toBe(false)
    expect(result.content).toBe('HELLO')
  })

  it('user.message.before：gate 阻断并带 reason', async () => {
    installHook('test.blocker', ['user.message.before'], () => ({
      effect: 'gate', block: true, reason: '禁止发送',
    }))
    const result = await runUserMessageBeforeHook(session(['test.blocker']), 'hello')
    expect(result).toMatchObject({ blocked: true, reason: '禁止发送' })
  })

  it('session.start / session.end 只对声明 phase 的启用 hook 触发', async () => {
    const calls: string[] = []
    installHook('test.boundary', ['session.start', 'session.end'], ctx => {
      calls.push(ctx.phase)
      return { effect: 'observe' }
    })
    await runSessionBoundaryHook('session.start', session(['test.boundary']))
    await runSessionBoundaryHook('session.end', session(['test.boundary']))
    expect(calls).toEqual(['session.start', 'session.end'])
  })
})
