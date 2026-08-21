/**
 * A1-c P1：canonicalEventRepository typed adapter 测试。
 * - append/revision/list/loadAll 的 invoke 参数映射与分页
 * - 结构化错误 { code, message } 透传与归一
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import {
  asCanonicalEventRepositoryError,
  loadCanonicalEventRange,
  tauriCanonicalEventRepository,
  type CanonicalEventRow,
} from '../canonicalEventRepository'
import type { CanonicalEventType } from '../../../domains/events/eventSchema'

const OWNER_KEY = '["p1","peri","local:s1"]'

function event(sequence: number, eventType: CanonicalEventType = 'user.message'): CanonicalEventRow {
  return {
    eventId: `${OWNER_KEY}#${sequence}`,
    owner: { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' },
    clientGeneration: 1,
    sequence,
    occurredAt: '2026-08-14T00:00:00.000Z',
    receivedAt: '2026-08-14T00:00:00.000Z',
    eventType,
    payloadVersion: 1,
    rawPayload: { text: 'hi' },
  }
}

describe('tauriCanonicalEventRepository', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('append 经 evt_append 映射 events/expectedRevision 并返回 revision', async () => {
    invokeMock.mockResolvedValueOnce({ events: [], revision: 4 })
    const repo = tauriCanonicalEventRepository()
    const revision = await repo.append([event(1), event(2)], 3)
    expect(revision).toBe(4)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    const [command, args] = invokeMock.mock.calls[0]
    expect(command).toBe('evt_append')
    expect(args.expectedRevision).toBe(3)
    expect(args.events).toHaveLength(2)
    expect(args.events[0].eventId).toBe(`${OWNER_KEY}#1`)
  })

  it('append 透传 event_revision_conflict（code 分支依据）', async () => {
    invokeMock.mockRejectedValueOnce({ code: 'event_revision_conflict', message: '事件仓库 revision 冲突：期望 3，实际 5' })
    const repo = tauriCanonicalEventRepository()
    const error = await repo.append([event(1)], 3).then(
      () => { throw new Error('append 应当 reject') },
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ code: 'event_revision_conflict' })
    const normalized = asCanonicalEventRepositoryError(error)
    expect(normalized).toBeInstanceOf(Error)
    expect(normalized.message).toContain('revision 冲突')
  })

  it('结构化错误 code 逐类透传（前端可区分诊断/重试）', async () => {
    const repo = tauriCanonicalEventRepository()
    for (const [code, message] of [
      ['event_repo_corrupt', '事件仓库损坏：db corrupt'],
      ['event_repo_constraint', '事件仓库约束冲突：dup'],
      ['event_repo_conflict', '事件仓库并发锁冲突：busy'],
      ['event_db_unavailable', '事件仓库不可用：closed'],
      ['event_invalid', '事件输入非法：eventId 不一致'],
      ['event_session_deleted', '会话已删除（tombstone）：["p1","peri","s1"]（tombstone state=deleted）'],
    ] as const) {
      invokeMock.mockRejectedValueOnce({ code, message })
      const error = await repo.append([event(1)], 1).then(
        () => { throw new Error('append 应当 reject') },
        (e: unknown) => e,
      )
      expect(error).toMatchObject({ code })
      expect(asCanonicalEventRepositoryError(error).code).toBe(code)
    }
  })

  it('revision / list 走对应命令', async () => {
    invokeMock.mockResolvedValueOnce(7)
    const repo = tauriCanonicalEventRepository()
    expect(await repo.revision(OWNER_KEY)).toBe(7)
    expect(invokeMock).toHaveBeenCalledWith('evt_revision', { ownerKey: OWNER_KEY })

    invokeMock.mockResolvedValueOnce({ events: [event(7)], nextBeforeSequence: 7 })
    const page = await repo.list(OWNER_KEY, null, 100)
    expect(page.events[0].sequence).toBe(7)
    expect(page.nextBeforeSequence).toBe(7)
    expect(invokeMock).toHaveBeenLastCalledWith('evt_list', { ownerKey: OWNER_KEY, beforeSequence: null, limit: 100 })
  })

  it('loadAll 游标翻到底并按 sequence 升序返回', async () => {
    invokeMock
      .mockResolvedValueOnce({ events: [event(3), event(4)], nextBeforeSequence: 3 })
      .mockResolvedValueOnce({ events: [event(2)], nextBeforeSequence: 2 })
      .mockResolvedValueOnce({ events: [event(1)], nextBeforeSequence: null })
    const repo = tauriCanonicalEventRepository()
    const rows = await repo.loadAll(OWNER_KEY)
    expect(rows.map(row => row.sequence)).toEqual([1, 2, 3, 4])
    expect(invokeMock).toHaveBeenCalledTimes(3)
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'evt_list', { ownerKey: OWNER_KEY, beforeSequence: null, limit: 1000 })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'evt_list', { ownerKey: OWNER_KEY, beforeSequence: 3, limit: 1000 })
  })

  it('loadAll 空流返回 []', async () => {
    invokeMock.mockResolvedValueOnce({ events: [], nextBeforeSequence: null })
    const repo = tauriCanonicalEventRepository()
    expect(await repo.loadAll(OWNER_KEY)).toEqual([])
  })

  it('exportRaw bypasses canonical decoding for one forensic row', async () => {
    const raw = {
      eventId: `${OWNER_KEY}#2`,
      ownerKey: OWNER_KEY,
      sequence: 2,
      eventType: 'user.message',
      identityJson: '{broken',
      typedPayloadJson: null,
      rawPayloadJson: '{"kept":true}',
    }
    invokeMock.mockResolvedValueOnce(raw)
    const repo = tauriCanonicalEventRepository()
    expect(await repo.exportRaw(raw.eventId)).toEqual(raw)
    expect(invokeMock).toHaveBeenCalledWith('evt_export_raw', { eventId: raw.eventId })
  })

  it('loadCanonicalEventRange 复用 backward cursor 定向读取并升序去重', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ events: [event(1003), event(1004)], nextBeforeSequence: 1003 })
      .mockResolvedValueOnce({ events: [event(3), event(4)], nextBeforeSequence: 3 })
      .mockResolvedValueOnce({ events: [event(2), event(3)], nextBeforeSequence: 2 })
    const rows = await loadCanonicalEventRange({ list }, OWNER_KEY, 1, 1004)
    expect(rows.map(row => row.sequence)).toEqual([2, 3, 4, 1003, 1004])
    expect(list).toHaveBeenNthCalledWith(1, OWNER_KEY, 1005, 1000)
    expect(list).toHaveBeenNthCalledWith(2, OWNER_KEY, 1003, 1000)
    expect(list).toHaveBeenNthCalledWith(3, OWNER_KEY, 3, 1)
  })

  it('searchOwners 走 evt_search 命令并返回候选 owner', async () => {
    invokeMock.mockResolvedValueOnce([{
      profileId: 'p1',
      agentId: 'peri',
      localSessionId: 'local:s1',
      remoteSessionId: 'remote-1',
    }])
    const repo = tauriCanonicalEventRepository()
    const owners = await repo.searchOwners('needle', 50)
    expect(owners).toEqual([{
      profileId: 'p1',
      agentId: 'peri',
      localSessionId: 'local:s1',
      remoteSessionId: 'remote-1',
    }])
    expect(invokeMock).toHaveBeenCalledWith('evt_search', { query: 'needle', limit: 50 })
  })

  it('evt_list 返回后端扁平行（EVT-02 wire）时归一为嵌套 owner 的 canonical 事件', async () => {
    // 后端 canonical_events 表为扁平列（profile_id/agent_id/local_session_id），
    // evt_list 经 serde camelCase 返回扁平行；前端投影需要嵌套 owner。
    invokeMock.mockResolvedValueOnce({
      events: [{
        eventId: `${OWNER_KEY}#1`,
        ownerKey: OWNER_KEY,
        profileId: 'p1',
        agentId: 'peri',
        localSessionId: 'local:s1',
        remoteSessionId: 'remote-1',
        clientGeneration: 2,
        sequence: 1,
        occurredAt: '2026-08-14T00:00:00.000Z',
        receivedAt: '2026-08-14T00:00:00.000Z',
        eventType: 'user.message',
        payloadVersion: 1,
        rawPayload: { text: 'hi' },
        createdAt: 1753065600000,
        schemaVersion: 1,
        provenanceOrigin: 'local-observed',
        provenanceTrust: 'authoritative',
        provenanceProvider: 'peri',
        rawTruncated: true,
        rawOriginalBytes: 90000,
        rawRetainedBytes: 64000,
        rawOmittedBytes: 26000,
        rawTruncationReason: 'size',
      }],
      nextBeforeSequence: null,
    })
    const repo = tauriCanonicalEventRepository()
    const rows = await repo.loadAll(OWNER_KEY)
    expect(rows).toHaveLength(1)
    expect(rows[0].owner).toEqual({
      profileId: 'p1',
      agentId: 'peri',
      localSessionId: 'local:s1',
      remoteSessionId: 'remote-1',
    })
    expect(rows[0].eventId).toBe(`${OWNER_KEY}#1`)
    expect(rows[0].sequence).toBe(1)
    expect(rows[0].eventType).toBe('user.message')
    expect(rows[0].schemaVersion).toBe(1)
    expect(rows[0].provenance).toEqual({ origin: 'local-observed', trust: 'authoritative', provider: 'peri' })
    expect(rows[0].rawMetadata).toEqual({ truncated: true, originalBytes: 90000, retainedBytes: 64000, omittedBytes: 26000, reason: 'size' })
  })

  it('嵌套 owner 行（测试/未来 wire）原样保留', async () => {
    invokeMock.mockResolvedValueOnce({ events: [event(7)], nextBeforeSequence: 7 })
    const repo = tauriCanonicalEventRepository()
    const page = await repo.list(OWNER_KEY, null, 100)
    expect(page.events[0].owner).toEqual({ profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' })
    expect(page.events[0].sequence).toBe(7)
  })
})
