/**
 * I14-W6 identity hydration（Tauri 后端读回）测试：
 * - Tauri 模式 hydrateProfiles/hydrateSessions 从后端 user store 读回（权威源），
 *   后端明确无数据时只允许 CAS=0 冷启动导入；不可用时本地缓存只读且重试后 SQLite 胜出；
 * - 旧 response 不覆盖新 mutation：hydrate 期间发生 mutation → 读回丢弃；
 * - 读回后 baseline 供写穿使用（串行链）。
 *
 * 通过 vi.mock 强制 IS_TAURI=true（env 模块）模拟 Tauri 运行时；invoke 经
 * @tauri-apps/api/core mock。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../test/fakeInvoke'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
vi.mock('../infrastructure/tauri/env', () => ({ IS_TAURI: true, isBrowserMockRuntime: () => false }))

import { flushIdentityBackend, IDENTITY_CACHE_META_KEY, useIdentityStore } from '../identityStore'
import { PROFILE_STORAGE_KEY } from '../profilePersistence'
import { SESSION_STORAGE_KEY } from '../sessionPersistence'

/** 未注册命令 resolve undefined（对齐 mockReset 后 vi.fn 的默认行为） */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

/** once 队列：thunk 依次出队执行（可返回值或可 await 的 Promise） */
function onceThunks(...thunks: Array<() => unknown>): () => unknown {
  const pending = [...thunks]
  return () => pending.shift()?.()
}

let fakeInvoke: TolerantFakeInvoke

const backendProfiles = (id: string, name: string) => ({
  version: 1,
  revision: 2,
  payload: {
    version: 1,
    profiles: [{ id, name, persona: 'p', model: 'm' }],
    activeProfileId: id,
  },
})

const backendSessions = () => ({
  version: 2,
  revision: 1,
  payload: {
    version: 2,
    sessions: [{ id: 's1', agentId: 'peri', name: 'S1', source: 'qq:g:1', profileId: 'p1' }],
  },
})

describe('identity hydration（Tauri 后端读回）', () => {
  beforeEach(async () => {
    // 先等待上一用例遗留的 fire-and-forget 写穿链落定（写穿 save 走基线 handler），
    // 再换新 FakeInvoke 实例：避免在飞 invoke 跨用例污染 handler 队列。
    const drain = new TolerantFakeInvoke().register('user_data_save', () => ({ revision: 1 }))
    invokeRef.current = (cmd, args) => drain.invoke(cmd, args)
    await flushIdentityBackend().catch(() => undefined)
    fakeInvoke = new TolerantFakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
    localStorage.clear()
    useIdentityStore.setState({
      profiles: [],
      activeProfileId: '',
      sessions: [],
      sessionsHydrated: false,
      sessionHydration: null,
      lastPersistError: null,
      identityPersistence: { profiles: 'unknown', sessions: 'unknown' },
    })
  })

  it('后端有数据 → profiles/sessions 读回应用（后端为权威源）', async () => {
    fakeInvoke.register('user_data_load', onceThunks(
      () => backendProfiles('p1', 'P1'),
      () => backendSessions(),
    ))
    await useIdentityStore.getState().hydrateProfiles()
    await useIdentityStore.getState().hydrateSessions()
    const state = useIdentityStore.getState()
    expect(state.profiles).toEqual([{ id: 'p1', name: 'P1', persona: 'p', model: 'm' }])
    expect(state.activeProfileId).toBe('p1')
    expect(state.sessions[0]?.id).toBe('s1')
    expect(state.sessionsHydrated).toBe(true)
    expect(state.identityPersistence).toEqual({ profiles: 'ready', sessions: 'ready' })
    expect(JSON.parse(localStorage.getItem(IDENTITY_CACHE_META_KEY)!)).toMatchObject({
      profiles: { revision: 2, state: 'clean' },
      sessions: { revision: 1, state: 'clean' },
    })
    // 读回只走 load（不写回）
    expect(fakeInvoke.calls.map(call => call.cmd)).toEqual(['user_data_load', 'user_data_load'])
  })

  it('后端明确无数据 → 以 expected=0 冷启动导入本地缓存', async () => {
    localStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify({ version: 1, profiles: [{ id: 'local', name: 'L', persona: 'p', model: 'm' }], activeProfileId: 'local' }),
    )
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ version: 2, sessions: [{ id: 'sl', agentId: 'peri', name: 'SL', source: 'local:x', profileId: 'local' }] }))
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    await useIdentityStore.getState().hydrateProfiles()
    await useIdentityStore.getState().hydrateSessions()
    expect(useIdentityStore.getState().profiles[0]?.id).toBe('local')
    expect(useIdentityStore.getState().sessions[0]?.id).toBe('sl')
    await flushIdentityBackend()
    const saves = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    expect(saves.every(call => (call.args as { expectedRevision: number }).expectedRevision === 0)).toBe(true)
    expect(JSON.parse(localStorage.getItem(IDENTITY_CACHE_META_KEY)!)).toMatchObject({
      profiles: { revision: 1, state: 'clean' },
      sessions: { revision: 1, state: 'clean' },
    })
  })

  it('hydrate 期间发生 mutation → 读回丢弃（旧 response 不覆盖新 mutation）', async () => {
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    fakeInvoke.register('user_data_load', onceThunks(() => loadGate.then(() => ({
      version: 1,
      revision: 0,
      payload: { version: 1, profiles: [], activeProfileId: '' },
    }))))
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))   // addProfile 的写穿 save
    const hydrating = useIdentityStore.getState().hydrateProfiles()
    useIdentityStore.getState().addProfile({ id: 'new', name: 'New', persona: 'p', model: 'm' })
    releaseLoad()
    await hydrating
    // 读回（空 profiles）被 seq 守卫丢弃——内存保留新 mutation
    const profiles = useIdentityStore.getState().profiles
    expect(profiles.some(p => p.id === 'new')).toBe(true)
    expect(profiles.length).toBeGreaterThan(0)
  })

  it('读回失败 → 本地缓存只读；mutation 不反写；重试后 SQLite 覆盖缓存', async () => {
    localStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify({ version: 1, profiles: [{ id: 'local', name: 'L', persona: 'p', model: 'm' }], activeProfileId: 'local' }),
    )
    fakeInvoke.register('user_data_load', onceThunks(
      () => { throw { code: 'user_data_unavailable', message: 'db down' } },
      () => backendProfiles('sqlite', 'SQLite'),
    ))
    await expect(useIdentityStore.getState().hydrateProfiles()).rejects.toMatchObject({
      code: 'user_data_unavailable',
    })
    expect(useIdentityStore.getState().profiles[0]?.id).toBe('local')
    expect(useIdentityStore.getState().identityPersistence.profiles).toBe('degraded-readonly')
    expect(JSON.parse(localStorage.getItem(IDENTITY_CACHE_META_KEY)!).profiles.state).toBe('stale')

    const callsAfterFailure = fakeInvoke.calls.length
    expect(useIdentityStore.getState().addProfile({ id: 'stale', name: 'Stale', persona: '', model: '' })).toBe('')
    await Promise.resolve()
    expect(fakeInvoke.calls).toHaveLength(callsAfterFailure)

    await useIdentityStore.getState().hydrateProfiles()
    expect(useIdentityStore.getState().profiles[0]?.id).toBe('sqlite')
    expect(useIdentityStore.getState().identityPersistence.profiles).toBe('ready')
    expect(useIdentityStore.getState().lastPersistError).toBeNull()
    expect(JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)!).profiles[0].id).toBe('sqlite')
    expect(JSON.parse(localStorage.getItem(IDENTITY_CACHE_META_KEY)!).profiles).toEqual({
      revision: 2,
      state: 'clean',
    })
  })

  it('CR-01 hydrateFromLocal：强制本地读回（导入值）并写穿后端', async () => {
    // 后端有陈旧数据也不影响——导入路径强制本地读回 + 写穿后端（Tauri 权威源同步）
    localStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify({ version: 1, profiles: [{ id: 'imported', name: 'I', persona: 'p', model: 'm' }], activeProfileId: 'imported' }),
    )
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ version: 2, sessions: [] }))
    fakeInvoke.register('user_data_load', () => null)
    fakeInvoke.register('user_data_save', () => ({ revision: 1 }))
    await useIdentityStore.getState().hydrateFromLocal()
    // 写穿是 fire-and-forget（per-key 串行链）——显式 flush 后确定性断言
    await flushIdentityBackend()
    // 内存 = 导入值（本地读回）
    expect(useIdentityStore.getState().profiles[0]?.id).toBe('imported')
    expect(useIdentityStore.getState().activeProfileId).toBe('imported')
    // 写穿已触发（profiles + sessions 各一次）
    const saves = fakeInvoke.calls.filter(call => call.cmd === 'user_data_save')
    expect(saves).toHaveLength(2)
    const profilesPayload = (saves[0]!.args as { payload: { profiles: Array<{ id: string }> } }).payload
    expect(profilesPayload.profiles[0].id).toBe('imported')
  })

  it('CR-05 hydrateFromLocal 递增 seq——在飞 hydration 读回被丢弃（不覆盖导入值）', async () => {
    let releaseLoad!: () => void
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
    // 本地导入值 + 在飞的后端陈旧读回
    localStorage.setItem(
      PROFILE_STORAGE_KEY,
      JSON.stringify({ version: 1, profiles: [{ id: 'imported', name: 'I', persona: 'p', model: 'm' }], activeProfileId: 'imported' }),
    )
    fakeInvoke.register('user_data_load', onceThunks(() => loadGate.then(() => ({
      version: 1,
      revision: 5,
      payload: { version: 1, profiles: [{ id: 'backend', name: 'B', persona: 'p', model: 'm' }], activeProfileId: 'backend' },
    }))))   // 在飞 load（后端陈旧）
    fakeInvoke.register('user_data_save', () => ({ revision: 6 }))
    const inFlight = useIdentityStore.getState().hydrateProfiles()
    await useIdentityStore.getState().hydrateFromLocal()
    releaseLoad()
    await inFlight
    // 写穿链可能仍在飞：flush 后结束，避免跨用例污染 mock 队列
    await flushIdentityBackend()
    // 在飞读回（backend）被 seq 守卫丢弃——内存保留导入值
    expect(useIdentityStore.getState().profiles[0]?.id).toBe('imported')
  })

  it('I14-W7 removeProfile 走后端原子删除并重读权威状态', async () => {
    useIdentityStore.setState({
      profiles: [
        { id: 'profile-a', name: 'R', persona: 'p', model: 'm' },
        { id: 'profile-b', name: 'S', persona: 'p', model: 'm' },
      ],
      activeProfileId: 'profile-a',
    })
    fakeInvoke.register('user_profile_delete', () => ({ fallback: 'profile-b', profilesRevision: 2, sessionsRevision: 2 }))
    fakeInvoke.register('user_data_load', onceThunks(
      () => ({ version: 1, revision: 2, payload: { version: 1, profiles: [{ id: 'profile-b', name: 'S', persona: 'p', model: 'm' }], activeProfileId: 'profile-b' } }),  // load profiles
      () => ({ version: 2, revision: 2, payload: { version: 2, sessions: [] } }),  // load sessions
    ))
    await useIdentityStore.getState().removeProfile('profile-a')
    const state = useIdentityStore.getState()
    expect(state.profiles).toEqual([{ id: 'profile-b', name: 'S', persona: 'p', model: 'm' }])
    expect(state.activeProfileId).toBe('profile-b')
    expect(fakeInvoke.calls[0]?.cmd).toBe('user_profile_delete')
    expect(fakeInvoke.calls[0]?.args).toEqual({ profileId: 'profile-a' })
  })

  it('I14-W7 removeProfile 后端失败：状态不变（可见上报）', async () => {
    useIdentityStore.setState({
      profiles: [
        { id: 'a', name: 'A', persona: 'p', model: 'm' },
        { id: 'b', name: 'B', persona: 'p', model: 'm' },
      ],
      activeProfileId: 'a',
    })
    fakeInvoke.register('user_profile_delete', () => {
      throw { code: 'user_data_unavailable', message: 'db down' }
    })
    await useIdentityStore.getState().removeProfile('a')
    // 状态不变（删除失败不产生半删除态）
    expect(useIdentityStore.getState().profiles.some(p => p.id === 'a')).toBe(true)
    expect(useIdentityStore.getState().activeProfileId).toBe('a')
  })

  it('I14-W7 CR-03 最后 profile 不可删（Tauri 与 browser 语义一致）', async () => {
    useIdentityStore.setState({
      profiles: [{ id: 'only', name: 'O', persona: 'p', model: 'm' }],
      activeProfileId: 'only',
    })
    await useIdentityStore.getState().removeProfile('only')
    expect(useIdentityStore.getState().profiles.some(p => p.id === 'only')).toBe(true)
    expect(fakeInvoke.calls).toHaveLength(0)
  })
})
