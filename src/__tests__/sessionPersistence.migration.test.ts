/**
 * ISSUE-01（W1）Session owner schema 与会话创建快照迁移/水合行为测试。
 *
 * 目标行为：
 * - v3 envelope roundtrip：agentId 与 creationSnapshot 往返不失真；
 * - v1 遗留数据 owner 推断（强度从强到弱）：唯一 Agent 的 periId →
 *   workspace sheet 对 sessionId 的显式引用 → 唯一 Agent 的 source；
 * - 无法唯一确定 → needs-owner-resolution（绝不静默归 activeAgent）；
 * - corrupt 与裸数组兼容；
 * - loadSessions 存储纪律：ready 写回当前 v3；needs-owner-resolution/corrupt 不写回（保留现场）；
 *   legacy key 仅在 ready 时迁移并删除；
 * - persistSessionsWithUnresolved（CR-001）：mutation 持久化把 unresolved（不补 agentId）
 *   并入当前 envelope 写盘，重载重推断不丢数据；
 * - identityStore hydrateSessions 集成：sessionHydration 状态可见，unresolved 不静默归 owner。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  SESSION_STORAGE_KEY,
  LEGACY_SESSION_STORAGE_KEY,
  serializeSessions,
  parseSessions,
  loadSessions,
  persistSessions,
  persistSessionsWithUnresolved,
  type OwnerHints,
  type LegacySession,
} from '../sessionPersistence'
import type { PersistedProfile } from '../profilePersistence'
import type { Session } from '../identityStore'
import { useIdentityStore } from '../identityStore'
import { useWorkspaceStore } from '../workspaceStore'
import { resetStores } from '../test/resetStores'

const PROFILES: PersistedProfile[] = [{ id: 'profile-a', name: 'Profile A', persona: 'p', model: 'm' }]

/** v1 遗留会话记录（无 agentId 的原始形状） */
function v1Record(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 's1', name: '会话一', source: 'qq:group:1', profileId: 'profile-a', createdAt: 100,
    lastActiveAt: 200, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [],
    autoName: '', ...overrides,
  }
}

const v1Envelope = (sessions: unknown[]) => JSON.stringify({ version: 1, sessions })

const readySession: Session = {
  id: 's1', agentId: 'peri', name: '会话一', source: 'qq:group:1', profileId: 'profile-a',
  createdAt: 100, lastActiveAt: 200, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '', metadata: {}, context: {},
}

function parsePersisted(): { version: number; sessions: Array<Record<string, unknown>> } {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY)
  expect(raw).not.toBeNull()
  return JSON.parse(raw!)
}

describe('ISSUE-01 Session owner schema v2', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  describe('schema roundtrip', () => {
    it('v3 serialize → parse 保持 agentId 与 creationSnapshot 往返', () => {
      const withSnapshot: Session = {
        ...readySession,
        creationSnapshot: {
          version: 1, createdAt: 99, registryRevision: 3, diagnostics: [],
          artifacts: [{
            id: 'plugin.bootstrap/default#0', phase: 'plugin.bootstrap/preflight', kind: 'plugin.bootstrap/data',
            ownerPluginId: 'plugin.bootstrap', ownerRuntimeInstanceId: 'plugin.bootstrap#one',
            sourceContributionId: 'plugin.bootstrap/default', order: 10, failurePolicy: 'required',
            payload: { enabled: true },
          }],
        },
      }
      const raw = serializeSessions([withSnapshot])
      const result = parseSessions(raw, PROFILES)
      expect(result.kind).toBe('ready')
      if (result.kind === 'ready') {
        expect(result.sessions).toEqual([withSnapshot])
      }
    })

    it('v3 落盘 envelope.version = 3 且包含 agentId', () => {
      persistSessions(localStorage, [readySession])
      const persisted = parsePersisted()
      expect(persisted.version).toBe(3)
      expect(persisted.sessions[0].agentId).toBe('peri')
    })

    it('裸数组旧格式兼容（旧版 sessionInput 曾允许）', () => {
      const raw = JSON.stringify([v1Record({ agentId: 'peri' })])
      const result = parseSessions(raw, PROFILES)
      expect(result.kind).toBe('ready')
      if (result.kind === 'ready') expect(result.sessions[0].agentId).toBe('peri')
    })

    it('未知 envelope → corrupt，不静默降级为空', () => {
      const result = parseSessions(JSON.stringify({ version: 99, sessions: [] }), PROFILES)
      expect(result.kind).toBe('corrupt')
    })

    it('非法 JSON → corrupt', () => {
      const result = parseSessions('{broken', PROFILES)
      expect(result.kind).toBe('corrupt')
    })
  })

  describe('owner 推断（强度从强到弱）', () => {
    it('Tier 1：唯一 Agent 的 periId → 反查归属', () => {
      const hints: OwnerHints = { activeSessionByAgent: { peri: 's1' } }
      // s1 已带 periId；s2 无 agentId 但共享同一 periId → 唯一归属 peri
      const raw = v1Envelope([
        v1Record({ id: 's1', agentId: 'peri', periId: 'peri-9' }),
        v1Record({ id: 's2', periId: 'peri-9' }),
      ])
      const result = parseSessions(raw, PROFILES, hints)
      expect(result.kind).toBe('ready')
      if (result.kind === 'ready') {
        expect(result.sessions.find(session => session.id === 's2')?.agentId).toBe('peri')
      }
    })

    it('Tier 2：workspace sheet 对 sessionId 的显式引用', () => {
      const hints: OwnerHints = { activeSessionByAgent: { peri: 's1' } }
      const raw = v1Envelope([v1Record({ id: 's1' })])
      const result = parseSessions(raw, PROFILES, hints)
      expect(result.kind).toBe('ready')
      if (result.kind === 'ready') expect(result.sessions[0].agentId).toBe('peri')
    })

    it('Tier 3：唯一 Agent 的 runtime source', () => {
      const hints: OwnerHints = { activeSessionByAgent: {}, sourcesByAgent: { peri: ['qq:group:1'] } }
      const raw = v1Envelope([v1Record({ id: 's1' })])
      const result = parseSessions(raw, PROFILES, hints)
      expect(result.kind).toBe('ready')
      if (result.kind === 'ready') expect(result.sessions[0].agentId).toBe('peri')
    })

    it('v1 已带 agentId 的记录直接保留，不重推断', () => {
      const raw = v1Envelope([v1Record({ agentId: 'vega' })])
      const result = parseSessions(raw, PROFILES, { activeSessionByAgent: { peri: 's1' } })
      expect(result.kind).toBe('ready')
      if (result.kind === 'ready') expect(result.sessions[0].agentId).toBe('vega')
    })
  })

  describe('无法唯一确定 → needs-owner-resolution', () => {
    it('多个 Agent 引用不同 periId 且无唯一 source → 进入 unresolved，不静默归 owner', () => {
      const hints: OwnerHints = {
        activeSessionByAgent: { peri: 's1', vega: 's9' },
        sourcesByAgent: { peri: ['qq:group:1'], vega: ['qq:group:9'] },
      }
      // s3 的 source 在两个 Agent 的 sources 中都存在 → 无法唯一确定
      const raw = v1Envelope([
        v1Record({ id: 's1', agentId: 'peri', periId: 'peri-1' }),
        v1Record({ id: 's9', agentId: 'vega', periId: 'peri-9' }),
        v1Record({ id: 's3', source: 'shared:1', periId: 'shared-peri' }),
      ])
      const hintsShared: OwnerHints = {
        ...hints,
        sourcesByAgent: { peri: ['qq:group:1', 'shared:1'], vega: ['qq:group:9', 'shared:1'] },
      }
      const result = parseSessions(raw, PROFILES, hintsShared)
      expect(result.kind).toBe('needs-owner-resolution')
      if (result.kind === 'needs-owner-resolution') {
        expect(result.sessions.map(session => session.id)).toEqual(['s1', 's9'])
        expect(result.unresolved.map(session => session.id)).toEqual(['s3'])
      }
    })

    it('无 hints 且无 agentId → 全部 unresolved', () => {
      const raw = v1Envelope([v1Record({ id: 's1' })])
      const result = parseSessions(raw, PROFILES, { activeSessionByAgent: {} })
      expect(result.kind).toBe('needs-owner-resolution')
      if (result.kind === 'needs-owner-resolution') expect(result.unresolved).toHaveLength(1)
    })

    it('重复 id 去重（以首次出现为准）', () => {
      const raw = v1Envelope([
        v1Record({ id: 's1', agentId: 'peri' }),
        v1Record({ id: 's1', agentId: 'vega', name: '重复' }),
      ])
      const result = parseSessions(raw, PROFILES, { activeSessionByAgent: {} })
      expect(result.kind).toBe('ready')
      if (result.kind === 'ready') expect(result.sessions).toHaveLength(1)
    })
  })

  describe('loadSessions 存储纪律', () => {
    it('ready → 写回 v3 envelope', () => {
      localStorage.setItem(SESSION_STORAGE_KEY, v1Envelope([v1Record({ agentId: 'peri' })]))
      const result = loadSessions(localStorage, PROFILES, { activeSessionByAgent: {} })
      expect(result.kind).toBe('ready')
      expect(parsePersisted().version).toBe(3)
    })

    it('needs-owner-resolution → 不写回（保留原始 v1 现场供恢复选择）', () => {
      const raw = v1Envelope([v1Record({ id: 's1' })])
      localStorage.setItem(SESSION_STORAGE_KEY, raw)
      const result = loadSessions(localStorage, PROFILES, { activeSessionByAgent: {} })
      expect(result.kind).toBe('needs-owner-resolution')
      expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(raw)
    })

    it('corrupt → 不写回（保留现场供诊断）', () => {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ version: 99 }))
      const result = loadSessions(localStorage, PROFILES, { activeSessionByAgent: {} })
      expect(result.kind).toBe('corrupt')
      expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe(JSON.stringify({ version: 99 }))
    })

    it('当前 key 损坏 → 回退旧 key 迁移（损坏数据被迁移结果覆盖）', () => {
      localStorage.setItem(SESSION_STORAGE_KEY, '{broken')
      localStorage.setItem(LEGACY_SESSION_STORAGE_KEY, v1Envelope([v1Record({ agentId: 'peri' })]))
      const result = loadSessions(localStorage, PROFILES, { activeSessionByAgent: {} })
      expect(result.kind).toBe('ready')
      expect(parsePersisted().version).toBe(3)
      expect(localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)).toBeNull()
    })

    it('legacy key 仅在 ready 时迁移写 v3 并删除旧 key', () => {
      localStorage.setItem(LEGACY_SESSION_STORAGE_KEY, v1Envelope([v1Record({ agentId: 'peri' })]))
      const result = loadSessions(localStorage, PROFILES, { activeSessionByAgent: {} })
      expect(result.kind).toBe('ready')
      expect(parsePersisted().version).toBe(3)
      expect(localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)).toBeNull()
    })

    it('legacy key 含 unresolved 时不迁移不删除', () => {
      localStorage.setItem(LEGACY_SESSION_STORAGE_KEY, v1Envelope([v1Record({ id: 's1' })]))
      const result = loadSessions(localStorage, PROFILES, { activeSessionByAgent: {} })
      expect(result.kind).toBe('needs-owner-resolution')
      expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
      expect(localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)).not.toBeNull()
    })

    it('无数据 → ready 空列表', () => {
      const result = loadSessions(localStorage, PROFILES, { activeSessionByAgent: {} })
      expect(result).toEqual({ kind: 'ready', sessions: [] })
    })
  })

  describe('persistSessionsWithUnresolved（CR-001 保留 unresolved 现场）', () => {
    const unresolved: LegacySession[] = [{
      id: 's9', name: '未决会话', source: 'qq:group:9', profileId: 'profile-a', createdAt: 300,
      lastActiveAt: 400, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [],
      autoName: '',
    }]

    it('resolved + unresolved 合并写 v3 envelope，unresolved 原样不补 agentId', () => {
      persistSessionsWithUnresolved(localStorage, [readySession], unresolved)
      const persisted = parsePersisted()
      expect(persisted.version).toBe(3)
      expect(persisted.sessions).toHaveLength(2)
      expect(persisted.sessions[0].agentId).toBe('peri')
      expect(persisted.sessions[1]).not.toHaveProperty('agentId')
    })

    it('合并写回后 load 重新推断：sheet hint 唯一 → 全部 ready 不丢', () => {
      persistSessionsWithUnresolved(localStorage, [readySession], unresolved)
      const result = loadSessions(localStorage, PROFILES, { activeSessionByAgent: { peri: 's9' } })
      expect(result.kind).toBe('ready')
      if (result.kind === 'ready') {
        expect(result.sessions.map(session => session.id).sort()).toEqual(['s1', 's9'])
        expect(result.sessions.find(session => session.id === 's9')?.agentId).toBe('peri')
      }
    })

    it('合并写回后 load 仍无法唯一确定 → 仍 needs-owner-resolution，现场保留', () => {
      persistSessionsWithUnresolved(localStorage, [], unresolved)
      const result = loadSessions(localStorage, PROFILES, { activeSessionByAgent: {} })
      expect(result.kind).toBe('needs-owner-resolution')
      if (result.kind === 'needs-owner-resolution') {
        expect(result.unresolved.map(session => session.id)).toEqual(['s9'])
      }
      // 不写回：envelope 仍含未决记录（不被覆盖丢失）
      expect(parsePersisted().sessions.map(session => session.id)).toEqual(['s9'])
    })

    it('存储不可用 → 返回 false 不抛异常', () => {
      const failing = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
      expect(persistSessionsWithUnresolved(failing, [], [])).toBe(false)
    })
  })

  describe('identityStore hydrateSessions 集成', () => {
    it('ready：sessions 带 agentId，sessionHydration.kind = ready', () => {
      localStorage.setItem(SESSION_STORAGE_KEY, v1Envelope([v1Record({ agentId: 'peri' })]))
      useIdentityStore.getState().hydrateSessions()
      const state = useIdentityStore.getState()
      expect(state.sessionsHydrated).toBe(true)
      expect(state.sessionHydration).toEqual({ kind: 'ready' })
      expect(state.sessions[0].agentId).toBe('peri')
    })

    it('needs-owner-resolution：sessionHydration 暴露 unresolved，sessions 不含未决项且不归 activeAgent', () => {
      localStorage.setItem(SESSION_STORAGE_KEY, v1Envelope([v1Record({ id: 's1' })]))
      useIdentityStore.getState().hydrateSessions()
      const state = useIdentityStore.getState()
      expect(state.sessionHydration?.kind).toBe('needs-owner-resolution')
      if (state.sessionHydration?.kind === 'needs-owner-resolution') {
        expect(state.sessionHydration.unresolved.map(session => session.id)).toEqual(['s1'])
      }
      expect(state.sessions).toEqual([])
      expect(state.sessions.some(session => session.agentId === state.activeAgent)).toBe(false)
    })

    it('corrupt：sessionHydration.corrupt 可见，sessions 空', () => {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ version: 99 }))
      useIdentityStore.getState().hydrateSessions()
      const state = useIdentityStore.getState()
      expect(state.sessionHydration?.kind).toBe('corrupt')
      expect(state.sessions).toEqual([])
    })

    it('sheet 状态作为 hint：hydrateSessions 解析到唯一 Agent', () => {
      useWorkspaceStore.setState({ sheetAgentStates: { peri: { activeSessionId: 's1' } } })
      localStorage.setItem(SESSION_STORAGE_KEY, v1Envelope([v1Record({ id: 's1' })]))
      useIdentityStore.getState().hydrateSessions()
      const state = useIdentityStore.getState()
      expect(state.sessionHydration?.kind).toBe('ready')
      expect(state.sessions[0].agentId).toBe('peri')
    })
  })

  describe('addSession owner', () => {
    it('不传 agentId 时取 activeAgent，持久化含 agentId', () => {
      const id = useIdentityStore.getState().addSession('默认归属')
      const state = useIdentityStore.getState()
      const session = state.sessions.find(item => item.id === id)
      expect(session?.agentId).toBe(state.activeAgent)
      expect(parsePersisted().sessions[0].agentId).toBe(state.activeAgent)
    })

    it('显式传 agentId 时以此为准（不取 activeAgent）', () => {
      useIdentityStore.getState().setActiveAgent('peri')
      const id = useIdentityStore.getState().addSession('显式归属', 'vega')
      expect(useIdentityStore.getState().sessions.find(item => item.id === id)?.agentId).toBe('vega')
    })

    it('owner 在 update/remove 后保持（updateSession/removeSession 不改归属）', () => {
      const id = useIdentityStore.getState().addSession('归属保持', 'vega')
      useIdentityStore.getState().updateSession(id, { name: '改名' })
      expect(useIdentityStore.getState().sessions.find(item => item.id === id)?.agentId).toBe('vega')
      useIdentityStore.getState().removeSession(id)
      expect(useIdentityStore.getState().sessions.some(item => item.id === id)).toBe(false)
    })
  })
})
