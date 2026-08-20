/**
 * TS-WI02：identityStore unresolved owner 提交集成。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SESSION_STORAGE_KEY } from '../sessionPersistence'
import { useIdentityStore } from '../identityStore'
import { resetStores } from '../test/resetStores'

const legacy = {
  id: 'legacy-1', name: '遗留会话', source: 'qq:group:1', profileId: 'profile-a', createdAt: 1,
  lastActiveAt: 2, platform: 'qq', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
}

describe('TS-WI02 resolveSessionOwner store integration', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ version: 2, sessions: [legacy] }))
    useIdentityStore.setState({ agents: [{ id: 'peri', name: 'Peri' }], profiles: [{ id: 'profile-a', name: 'Profile A', persona: 'p', model: 'm' }, { id: 'profile-b', name: 'Profile B', persona: 'p', model: 'm' }] })
    useIdentityStore.getState().hydrateSessionsLocal()
  })

  it('成功后写回当前 schema owner 并进入 ready', async () => {
    expect(useIdentityStore.getState().sessionHydration?.kind).toBe('needs-owner-resolution')
    await expect(useIdentityStore.getState().resolveSessionOwner('legacy-1', 'peri')).resolves.toBe(true)

    const state = useIdentityStore.getState()
    expect(state.sessionHydration).toEqual({ kind: 'ready' })
    expect(state.sessions).toEqual([expect.objectContaining({ id: 'legacy-1', agentId: 'peri' })])
    const persisted = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!) as { version: number; sessions: Array<Record<string, unknown>> }
    expect(persisted.version).toBe(3)
    expect(persisted.sessions).toEqual([expect.objectContaining({ id: 'legacy-1', agentId: 'peri' })])
  })

  it('无效 Agent 时保留原始 unresolved envelope', async () => {
    const before = localStorage.getItem(SESSION_STORAGE_KEY)
    await expect(useIdentityStore.getState().resolveSessionOwner('legacy-1', 'missing')).resolves.toBe(false)
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(before)
    expect(useIdentityStore.getState().sessionHydration).toEqual({ kind: 'needs-owner-resolution', unresolved: [legacy] })
  })
})
