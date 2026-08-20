// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { useIdentityStore, type Session } from '../../../identityStore.ts'
import { parseSessions, SESSION_STORAGE_KEY } from '../../../sessionPersistence.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { createPluginSessionDataApis } from '../pluginSessionDataApi.ts'

const session: Session = {
  id: 's1', agentId: 'peri', name: 'Session', source: 'local:s1', profileId: 'p1',
  createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '', metadata: {}, context: {},
}

beforeEach(() => {
  localStorage.clear()
  useIdentityStore.setState({
    profiles: [{ id: 'p1', name: 'P1', persona: '', model: '' }],
    sessions: [session],
    turns: [],
    sessionHydration: { kind: 'ready' },
    sessionsHydrated: true,
    lastPersistError: null,
  })
})

describe('Session/Turn plugin namespace API', () => {
  it('按 owner plugin 隔离 metadata/context，并把 Session 与 Turn 一起持久化恢复', () => {
    const pluginA = createPluginSessionDataApis(createPluginIdentity('plugin.a', 'a-1'))
    const pluginB = createPluginSessionDataApis(createPluginIdentity('plugin.b', 'b-1'))

    expect(pluginA.sessions.setPluginMetadata('s1', { count: 1 })).toBe(true)
    expect(pluginA.sessions.setPluginMetadata('s1', { label: 'A' })).toBe(true)
    expect(pluginA.sessions.setPluginContext('s1', { selection: ['x'] })).toBe(true)
    expect(pluginB.sessions.setPluginMetadata('s1', { count: 2 })).toBe(true)

    expect(pluginA.turns.ensure({ id: 't1', sessionId: 's1', startedAt: 10 })).toBe(true)
    expect(pluginA.turns.setPluginMetadata('t1', { tokens: 12 })).toBe(true)
    expect(pluginB.turns.setPluginContext('t1', { trace: 'b' })).toBe(true)

    expect(pluginA.sessions.getPluginMetadata('s1')).toEqual({ count: 1, label: 'A' })
    expect(pluginB.sessions.getPluginMetadata('s1')).toEqual({ count: 2 })
    expect(pluginA.sessions.getPluginContext('s1')).toEqual({ selection: ['x'] })
    expect(pluginA.turns.getPluginMetadata('t1')).toEqual({ tokens: 12 })
    expect(pluginB.turns.getPluginContext('t1')).toEqual({ trace: 'b' })

    const restored = parseSessions(localStorage.getItem(SESSION_STORAGE_KEY), useIdentityStore.getState().profiles)
    expect(restored.kind).toBe('ready')
    if (restored.kind !== 'ready') throw new Error('unexpected hydration')
    expect(restored.sessions[0].metadata).toEqual({
      'plugin.a': { count: 1, label: 'A' },
      'plugin.b': { count: 2 },
    })
    expect(restored.turns).toEqual([expect.objectContaining({
      id: 't1', sessionId: 's1', metadata: { 'plugin.a': { tokens: 12 } },
      context: { 'plugin.b': { trace: 'b' } },
    })])
  })

  it('拒绝不存在实体、非 JSON/循环数据和超过 64KiB 的单插件命名空间', () => {
    const plugin = createPluginSessionDataApis(createPluginIdentity('plugin.safe', 'safe-1'))
    expect(plugin.sessions.setPluginMetadata('missing', { ok: true })).toBe(false)
    expect(plugin.turns.ensure({ id: 't-missing', sessionId: 'missing', startedAt: 1 })).toBe(false)

    expect(() => plugin.sessions.setPluginMetadata('s1', { fn: () => true })).toThrow(/JSON/)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => plugin.sessions.setPluginMetadata('s1', cyclic)).toThrow(/循环引用/)
    expect(() => plugin.sessions.setPluginContext('s1', { huge: 'x'.repeat(70 * 1024) })).toThrow(/65536/)
    expect(plugin.sessions.getPluginMetadata('s1')).toEqual({})
    expect(plugin.sessions.getPluginContext('s1')).toEqual({})
  })

  it('getter 返回副本，插件不能绕过写 API 篡改 store', () => {
    const plugin = createPluginSessionDataApis(createPluginIdentity('plugin.copy', 'copy-1'))
    plugin.sessions.setPluginMetadata('s1', { nested: { value: 1 } })
    const copy = plugin.sessions.getPluginMetadata('s1') as { nested: { value: number } }
    copy.nested.value = 999
    expect(plugin.sessions.getPluginMetadata('s1')).toEqual({ nested: { value: 1 } })
  })
})
