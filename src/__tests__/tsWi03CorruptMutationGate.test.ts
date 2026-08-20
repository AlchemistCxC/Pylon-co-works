/**
 * TS-WI03 RED：corrupt Session envelope 在用户确认修复前必须只读，普通 mutation 不得覆盖现场。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SESSION_STORAGE_KEY } from '../sessionPersistence'
import { useIdentityStore } from '../identityStore'
import { resetStores } from '../test/resetStores'

const corruptRaw = JSON.stringify({ version: 99, sessions: [{ id: 'diagnostic-original' }] })

describe('TS-WI03 corrupt mutation write gate', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    localStorage.setItem(SESSION_STORAGE_KEY, corruptRaw)
    useIdentityStore.getState().hydrateSessionsLocal()
    expect(useIdentityStore.getState().sessionHydration?.kind).toBe('corrupt')
  })

  it('addSession 被拒绝且不覆盖 corrupt envelope', () => {
    const id = useIdentityStore.getState().addSession('禁止创建', 'peri')
    expect(id).toBe('')
    expect(useIdentityStore.getState().sessions).toEqual([])
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(corruptRaw)
  })

  it('update/remove/setPeriId 被拒绝且不覆盖 corrupt envelope', () => {
    useIdentityStore.setState({
      sessions: [{ id: 'memory', agentId: 'peri', name: 'M', source: 'local:m', profileId: 'profile-a', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' }],
    })
    useIdentityStore.getState().updateSession('memory', { name: 'changed' })
    useIdentityStore.getState().setSessionPeriId('memory', 'peri-x')
    useIdentityStore.getState().removeSession('memory')
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(corruptRaw)
    expect(useIdentityStore.getState().sessions[0]).toMatchObject({ id: 'memory', name: 'M' })
    expect(useIdentityStore.getState().sessions[0]).not.toHaveProperty('periId')
  })
})
