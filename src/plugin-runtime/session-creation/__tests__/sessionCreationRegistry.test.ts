import { describe, expect, it } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { compileSessionCreationSnapshot } from '../compileSessionCreationSnapshot.ts'
import { createPluginSessionCreationApi } from '../pluginSessionCreationApi.ts'
import { SessionCreationRegistry } from '../sessionCreationRegistry.ts'
import { runSessionCreationPhase } from '../runSessionCreationPhase.ts'

const context = {
  sessionId: 's1', source: 'local:s1', title: 'Session', agentId: 'peri',
  profile: { id: 'p1', name: 'P1', persona: 'Persona', model: 'm1' },
  platform: 'local', workdir: 'G:/work', workspaceId: 'w1',
} as const

describe('SessionCreationRegistry', () => {
  it('用开放 kind 编译确定性、不可变、可持久化的 artifact 快照', async () => {
    const registry = new SessionCreationRegistry()
    const owner = createPluginIdentity('plugin.pylon-skill', 'one')
    registry.registerCompiler(owner, {
      id: 'plugin.pylon-skill/compiler',
      kind: 'plugin.pylon-skill/bootstrap',
      compile: contribution => [{
        phase: 'pylon/first-message',
        kind: 'plugin.pylon-skill/instruction',
        payload: { text: (contribution.payload as { text: string }).text },
      }],
    })
    registry.registerContribution(owner, {
      id: 'plugin.pylon-skill/default',
      kind: 'plugin.pylon-skill/bootstrap',
      payload: current => ({ text: `${current.profile.name}:${current.workspaceId}` }),
      failurePolicy: 'required',
    })
    registry.registerArtifactHandler(owner, {
      id: 'plugin.pylon-skill/instruction-handler',
      phase: 'pylon/first-message',
      kind: 'plugin.pylon-skill/instruction',
      run: artifact => [{ kind: 'plugin.pylon-skill/ready', payload: artifact.payload }],
    })

    const snapshot = compileSessionCreationSnapshot(registry.getSnapshot(), context, 123)
    expect(snapshot).toMatchObject({ version: 1, createdAt: 123, diagnostics: [] })
    expect(snapshot.artifacts).toEqual([expect.objectContaining({
      phase: 'pylon/first-message',
      kind: 'plugin.pylon-skill/instruction',
      payload: { text: 'P1:w1' },
      ownerPluginId: 'plugin.pylon-skill',
    })])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(JSON.parse(JSON.stringify(snapshot))).toMatchObject({ version: 1, createdAt: 123 })
    const phase = await runSessionCreationPhase(registry.getSnapshot(), snapshot, 'pylon/first-message', {
      session: {
        id: context.sessionId,
        agentId: context.agentId,
        source: context.source,
        profileId: context.profile.id,
        workdir: context.workdir,
        workspaceId: context.workspaceId,
      },
      signal: new AbortController().signal,
    })
    expect(phase.effects).toEqual([{ kind: 'plugin.pylon-skill/ready', payload: { text: 'P1:w1' } }])
  })

  it('optional 编译失败记诊断，required 失败阻止创建', () => {
    const registry = new SessionCreationRegistry()
    const owner = createPluginIdentity('plugin.broken', 'one')
    registry.registerContribution(owner, {
      id: 'plugin.broken/optional', kind: 'plugin.broken/missing', payload: {},
    })
    expect(compileSessionCreationSnapshot(registry.getSnapshot(), context).diagnostics[0].message).toMatch(/没有 compiler/)
    registry.registerContribution(owner, {
      id: 'plugin.broken/required', kind: 'plugin.broken/required', payload: {}, failurePolicy: 'required',
    })
    expect(() => compileSessionCreationSnapshot(registry.getSnapshot(), context)).toThrow(/没有 compiler/)
  })

  it('API 绑定 scope，shadow transaction 可原子替换并 revert', async () => {
    const registry = new SessionCreationRegistry()
    const oldOwner = createPluginIdentity('plugin.bootstrap', 'old')
    const scope = new PluginScope(oldOwner.key)
    const api = createPluginSessionCreationApi(registry, oldOwner, scope)
    api.registerContribution({ id: 'plugin.bootstrap/default', kind: 'plugin.bootstrap/data', payload: { version: 'old' } })
    api.registerCompiler({ id: 'plugin.bootstrap/compiler', kind: 'plugin.bootstrap/data', compile: value => [{ phase: 'plugin.bootstrap/preflight', kind: 'plugin.bootstrap/data', payload: value.payload }] })

    const nextOwner = createPluginIdentity('plugin.bootstrap', 'next')
    const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    transaction.registerContribution({ id: 'plugin.bootstrap/default', kind: 'plugin.bootstrap/data', payload: { version: 'next' } })
    transaction.registerCompiler({ id: 'plugin.bootstrap/compiler', kind: 'plugin.bootstrap/data', compile: value => [{ phase: 'plugin.bootstrap/preflight', kind: 'plugin.bootstrap/data', payload: value.payload }] })
    transaction.commit()
    expect(compileSessionCreationSnapshot(registry.getSnapshot(), context).artifacts[0].payload).toEqual({ version: 'next' })
    transaction.revert()
    expect(compileSessionCreationSnapshot(registry.getSnapshot(), context).artifacts[0].payload).toEqual({ version: 'old' })

    await scope.dispose()
    expect(registry.getSnapshot().contributions.entries).toEqual([])
    expect(registry.getSnapshot().compilers.entries).toEqual([])
    expect(registry.getSnapshot().handlers.entries).toEqual([])
  })

  it('拒绝未命名空间 kind 与不可持久化 payload', () => {
    const registry = new SessionCreationRegistry()
    const owner = createPluginIdentity('plugin.invalid', 'one')
    expect(() => registry.registerContribution(owner, { id: 'bad', kind: 'prompt', payload: {} })).toThrow(/namespaced/)
    registry.registerCompiler(owner, { id: 'plugin.invalid/compiler', kind: 'plugin.invalid/data', compile: value => [{ phase: 'plugin.invalid/preflight', kind: 'plugin.invalid/data', payload: value.payload }] })
    registry.registerContribution(owner, { id: 'plugin.invalid/value', kind: 'plugin.invalid/data', payload: { bad: new Date() } as never, failurePolicy: 'required' })
    expect(() => compileSessionCreationSnapshot(registry.getSnapshot(), context)).toThrow(/可持久化 JSON/)
  })
})
