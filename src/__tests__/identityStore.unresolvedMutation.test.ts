/**
 * CR-001（玉衡 finding）：mutation 持久化不得用 resolved 子集覆盖存储、丢弃 unresolved。
 *
 * 修复前：hydrate 得 needs-owner-resolution 后，state.sessions 只含已解析子集，
 * addSession/updateSession/removeSession/setSessionPeriId/removeProfile 经 persistSessions
 * 把（仅 resolved 的）sessions 覆盖写回 pylon-sessions → 未决 legacy 会话永久丢失。
 * 本文件断言：任一 mutation 之后，存储 envelope 仍保留 unresolved 记录（不补 agentId）。
 * 修复前 RED：persistedIds() 不含未决 id；修复后 GREEN。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { SESSION_STORAGE_KEY } from '../sessionPersistence'
import { useIdentityStore } from '../identityStore'
import { useWorkspaceStore } from '../workspaceStore'
import { resetStores } from '../test/resetStores'
import type { PersistedProfile } from '../profilePersistence'

const PROFILES: PersistedProfile[] = [{ id: 'profile-a', name: 'Profile A', persona: 'p', model: 'm' }]

/** v1 遗留记录（无 agentId）：无唯一 owner hint → 水合进 unresolved */
function v1Record(id: string, source: string): Record<string, unknown> {
  return {
    id, name: `会话-${id}`, source, profileId: 'profile-a', createdAt: 100,
    lastActiveAt: 200, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [],
    autoName: '',
  }
}

function seedUnresolved(id = 's9', source = 'qq:group:9'): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ version: 2, sessions: [v1Record(id, source)] }))
  useWorkspaceStore.setState({ sheetAgentStates: {} })
  useIdentityStore.getState().hydrateSessions()
  const hydration = useIdentityStore.getState().sessionHydration
  expect(hydration?.kind).toBe('needs-owner-resolution')
}

function persistedIds(): string[] {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY)
  if (!raw) return []
  const parsed = JSON.parse(raw) as { sessions: Array<Record<string, unknown>> }
  return parsed.sessions.map(session => session.id as string)
}

function persistedHasAgentId(id: string): boolean {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY)
  if (!raw) return false
  const parsed = JSON.parse(raw) as { sessions: Array<Record<string, unknown>> }
  const record = parsed.sessions.find(session => session.id === id)
  return record ? Object.prototype.hasOwnProperty.call(record, 'agentId') : false
}

beforeEach(() => {
  localStorage.clear()
  resetStores()
})

describe('CR-001 mutation 持久化保留 unresolved 现场', () => {
  it('addSession 后存储仍含 unresolved 记录且不补 agentId', () => {
    seedUnresolved()
    useIdentityStore.getState().addSession('新会话', 'peri')
    expect(persistedIds()).toContain('s9')
    expect(persistedHasAgentId('s9')).toBe(false)
  })

  it('updateSession 后存储仍含 unresolved 记录', () => {
    seedUnresolved()
    const id = useIdentityStore.getState().addSession('新会话', 'peri')
    useIdentityStore.getState().updateSession(id, { name: '改名' })
    expect(persistedIds()).toContain('s9')
    expect(persistedHasAgentId('s9')).toBe(false)
  })

  it('removeSession 后存储仍含 unresolved 记录', () => {
    seedUnresolved()
    const id = useIdentityStore.getState().addSession('新会话', 'peri')
    useIdentityStore.getState().removeSession(id)
    expect(persistedIds()).toContain('s9')
    expect(persistedHasAgentId('s9')).toBe(false)
  })

  it('setSessionPeriId 后存储仍含 unresolved 记录', () => {
    seedUnresolved()
    const id = useIdentityStore.getState().addSession('新会话', 'peri')
    useIdentityStore.getState().setSessionPeriId(id, 'peri-9')
    expect(persistedIds()).toContain('s9')
    expect(persistedHasAgentId('s9')).toBe(false)
  })

  it('removeProfile 后存储仍含 unresolved 记录（profileId fallback 不影响未决项）', () => {
    seedUnresolved()
    useIdentityStore.setState({
      profiles: [...PROFILES, { id: 'profile-b', name: 'Profile B', persona: 'p2', model: 'm' }],
    })
    useIdentityStore.getState().removeProfile('profile-b')
    expect(persistedIds()).toContain('s9')
    expect(persistedHasAgentId('s9')).toBe(false)
  })

  it('合并写回后再次 hydrate 可重推断（幂等，不丢数据）', () => {
    seedUnresolved()
    const addedId = useIdentityStore.getState().addSession('新会话', 'peri')
    // 补 sheet hint 使 s9 唯一归属 peri → 重水合全部 ready
    useWorkspaceStore.setState({ sheetAgentStates: { peri: { activeSessionId: 's9' } } })
    useIdentityStore.getState().hydrateSessions()
    const state = useIdentityStore.getState()
    expect(state.sessionHydration?.kind).toBe('ready')
    expect(state.sessions.map(session => session.id).sort()).toEqual([addedId, 's9'].sort())
    expect(state.sessions.find(session => session.id === 's9')?.agentId).toBe('peri')
  })
})
