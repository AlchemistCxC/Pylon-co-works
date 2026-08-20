import { describe, expect, it } from 'vitest'
import { archivedOwnerResultToTransaction, resolveArchivedSessionOwner } from '../archiveOwnerResolver'
import type { Session } from '../../../identityStore'

function session(id: string, agentId: string, source: string, periId?: string): Session {
  return { id, agentId, source, periId, name: id, profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' }
}

describe('resolveArchivedSessionOwner', () => {
  it('source 唯一命中时 resolved', () => {
    expect(resolveArchivedSessionOwner({ source: 'qq:1' }, [session('s1', 'peri', 'qq:1')])).toEqual({ kind: 'resolved', agentId: 'peri', sessionId: 's1' })
  })

  it('periId 唯一命中时 resolved', () => {
    expect(resolveArchivedSessionOwner({ periId: 'p1' }, [session('s1', 'peri', 'other', 'p1')])).toEqual({ kind: 'resolved', agentId: 'peri', sessionId: 's1' })
  })

  it('source/periId 命中同一 Session 时 resolved', () => {
    expect(resolveArchivedSessionOwner({ source: 'qq:1', periId: 'p1' }, [session('s1', 'peri', 'qq:1', 'p1')])).toEqual({ kind: 'resolved', agentId: 'peri', sessionId: 's1' })
  })

  it('source/periId 命中不同 Session 时 conflict', () => {
    expect(resolveArchivedSessionOwner({ source: 'qq:1', periId: 'p1' }, [
      session('s1', 'peri', 'qq:1'), session('s2', 'peri', 'other', 'p1'),
    ])).toEqual({ kind: 'conflict', sessionIds: ['s1', 's2'] })
  })

  it('同一 key 多次命中不同 Session 时 conflict', () => {
    expect(resolveArchivedSessionOwner({ source: 'qq:1' }, [session('s1', 'peri', 'qq:1'), session('s2', 'vega', 'qq:1')])).toEqual({ kind: 'conflict', sessionIds: ['s1', 's2'] })
  })

  it('owner scope 限定后只解析目标 Agent', () => {
    expect(resolveArchivedSessionOwner({ source: 'qq:1', ownerAgentId: 'peri' }, [
      session('s1', 'peri', 'qq:1'), session('s2', 'vega', 'qq:1'),
    ])).toEqual({ kind: 'resolved', agentId: 'peri', sessionId: 's1' })
  })

  it('无命中返回 missing，并转换为 validation', () => {
    const result = resolveArchivedSessionOwner({ source: 'missing' }, [])
    expect(result).toEqual({ kind: 'missing' })
    expect(archivedOwnerResultToTransaction(result)).toMatchObject({ ok: false, kind: 'validation' })
  })
})
