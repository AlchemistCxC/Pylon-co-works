/**
 * resumePersistedSessionTransaction 行为测试（报告阶段 3.3 / FE-AUD-010）：
 * 命中复用、未命中创建并纠正 source/periId/updatedAt、返回 id 不靠数组长度。
 */
import { describe, expect, it } from 'vitest'
import { resumePersistedSessionTransaction } from '../resumePersistedSessionTransaction'
import type { Session } from '../../../identityStore'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', name: '会话一', source: 'local:一', profileId: 'p', createdAt: 0,
    lastActiveAt: 0, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '', ...overrides,
  }
}

function createDeps(sessions: Session[]) {
  const created: Array<{ id: string; partial: Partial<Session> }> = []
  return {
    deps: {
      sessions,
      addSession: (_name: string) => {
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
})
