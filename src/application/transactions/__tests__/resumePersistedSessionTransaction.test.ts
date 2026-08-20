/**
 * resumePersistedSessionTransaction 行为测试（报告阶段 3.3 / FE-AUD-010）：
 * 命中复用、未命中创建并纠正 source/periId/updatedAt、返回 id 不靠数组长度。
 * ISSUE-01：agentId 传入时仅在 owner 内匹配（不同 Agent 同 source 各自成行）；
 * source 与 periId 同时命中但指向不同 Session → conflict。
 */
import { describe, expect, it } from 'vitest'
import { resumePersistedSessionTransaction } from '../resumePersistedSessionTransaction'
import type { Session } from '../../../identityStore'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', agentId: 'peri', name: '会话一', source: 'local:一', profileId: 'p', createdAt: 0,
    lastActiveAt: 0, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '', ...overrides,
  }
}

function createDeps(sessions: Session[]) {
  const created: Array<{ id: string; partial: Partial<Session> }> = []
  return {
    deps: {
      sessions,
      addSession: (_name: string, _agentId?: string) => {
        const id = `created-${created.length}`
        created.push({ id, partial: {} })
        return id
      },
      updateSession: (id: string, partial: Partial<Session>) => {
        created.push({ id, partial })
      },
    },
    created,
  }
}

describe('resumePersistedSessionTransaction', () => {
  it('命中 source：复用现有会话 id，不创建', () => {
    const existing = makeSession({ id: 's1', source: 'qq:group:1' })
    const { deps, created } = createDeps([existing])
    const result = resumePersistedSessionTransaction('qq:group:1', undefined, '会话', 0, deps)
    expect(result).toEqual({ ok: true, value: 's1' })
    expect(created).toEqual([])
  })

  it('命中 periId：复用现有会话 id', () => {
    const existing = makeSession({ id: 's9', periId: 'peri-9' })
    const { deps, created } = createDeps([existing])
    const result = resumePersistedSessionTransaction(undefined, 'peri-9', '会话', 0, deps)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('s9')
    expect(created).toEqual([])
  })

  it('未命中：addSession 返回 id 并纠正 source/periId/updatedAt（不靠数组长度）', () => {
    const { deps, created } = createDeps([])
    const result = resumePersistedSessionTransaction('qq:group:5', 'peri-5', '存档名', 123456, deps)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('created-0')
    expect(created).toHaveLength(2)
    expect(created[1]).toEqual({
      id: 'created-0',
      partial: { source: 'qq:group:5', periId: 'peri-5', lastActiveAt: 123456 },
    })
  })

  it('无 source/periId 时创建纯本地会话', () => {
    const { deps, created } = createDeps([])
    const result = resumePersistedSessionTransaction(undefined, undefined, '标题', undefined, deps)
    expect(result.ok).toBe(true)
    expect(created[1].partial).not.toHaveProperty('source')
    expect(created[1].partial).toHaveProperty('lastActiveAt')
  })

  it('agentId 传入：只命中同 owner 会话，异 owner 同 source 不串用', () => {
    // 同一 source 在另一 Agent（s2）下已存在——调用方 owner=peri 时不得命中 s2
    const other = makeSession({ id: 's2', agentId: 'vega', source: 'qq:group:1' })
    const { deps, created } = createDeps([other])
    const result = resumePersistedSessionTransaction('qq:group:1', undefined, '会话', 0, deps, 'peri')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('created-0')
    // 创建路径透传 owner
    expect(created[0]).toEqual({ id: 'created-0', partial: {} })
    expect(created[1].partial).toMatchObject({ source: 'qq:group:1' })
  })

  it('agentId 传入：同 owner 命中复用，不创建', () => {
    const mine = makeSession({ id: 's1', agentId: 'peri', source: 'qq:group:1' })
    const { deps, created } = createDeps([mine])
    const result = resumePersistedSessionTransaction('qq:group:1', undefined, '会话', 0, deps, 'peri')
    expect(result).toEqual({ ok: true, value: 's1' })
    expect(created).toEqual([])
  })

  it('source 与 periId 分别命中不同 Session → conflict（不静默合并）', () => {
    const bySource = makeSession({ id: 's1', agentId: 'peri', source: 'qq:group:1', periId: undefined })
    const byPeriId = makeSession({ id: 's2', agentId: 'peri', periId: 'peri-9' })
    const { deps, created } = createDeps([bySource, byPeriId])
    const result = resumePersistedSessionTransaction('qq:group:1', 'peri-9', '会话', 0, deps, 'peri')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('conflict')
    expect(created).toEqual([])
  })

  it('source 与 periId 命中同一 Session → 复用（非冲突）', () => {
    const same = makeSession({ id: 's1', agentId: 'peri', source: 'qq:group:1', periId: 'peri-9' })
    const { deps, created } = createDeps([same])
    const result = resumePersistedSessionTransaction('qq:group:1', 'peri-9', '会话', 0, deps, 'peri')
    expect(result).toEqual({ ok: true, value: 's1' })
    expect(created).toEqual([])
  })
})
