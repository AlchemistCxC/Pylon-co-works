/**
 * A1-c P2：canonicalEventSink 行为测试。
 * 播种排队/顺序/sequence 分配、seed 失败自愈、pending 清理、
 * revision_conflict 保批重播种、discard 不复活。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCanonicalEventSink,
  type CanonicalEventOfferContext,
} from '../canonicalEventSink'
import {
  CanonicalEventRepositoryError,
  type CanonicalEventRepository,
} from '../canonicalEventRepository'
import type { CanonicalConversationEvent } from '../../../domains/events/eventSchema'

const OWNER_KEY = '["p1","peri","local:s1"]'
const context: CanonicalEventOfferContext = {
  owner: { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' },
  clientGeneration: 3,
}

async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function rawUser(text: string): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}

interface FakeRepo {
  repository: CanonicalEventRepository
  revision: ReturnType<typeof vi.fn>
  append: ReturnType<typeof vi.fn>
}

function fakeRepository(): FakeRepo {
  const revision = vi.fn()
  const append = vi.fn()
  const repository: CanonicalEventRepository = {
    append: (...args) => append(...args),
    revision: (...args) => revision(...args),
    async list() { return { events: [], nextBeforeSequence: null } },
    async loadAll() { return [] },
    async exportRaw() { return null },
    async searchOwners() { return [] },
  }
  return { repository, revision, append }
}

describe('canonicalEventSink', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次 offer 先播种，事件以 revision+1 起连续分配 sequence', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(5)
    fake.append.mockResolvedValue(1)
    const sink = createCanonicalEventSink({ repository: fake.repository, debounceMs: 300 })
    sink.offer(context, rawUser('你好'))
    expect(fake.append).not.toHaveBeenCalled()
    await flushMicrotasks() // seed
    expect(fake.revision).toHaveBeenCalledWith(OWNER_KEY)
    vi.advanceTimersByTime(300)
    expect(fake.append).toHaveBeenCalledTimes(1)
    const [events, expectedRevision] = fake.append.mock.calls[0]
    expect(expectedRevision).toBe(5)
    const persisted = events as CanonicalConversationEvent[]
    expect(persisted).toHaveLength(1)
    expect(persisted[0].sequence).toBe(6)
    expect(persisted[0].eventId).toBe(`${OWNER_KEY}#6`)
    expect(persisted[0].eventType).toBe('user.message')
    sink.dispose()
  })

  it('播种期间的 offer 排队，按到达顺序归一；force 触发整批落盘', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(2)
    const sink = createCanonicalEventSink({ repository: fake.repository, debounceMs: 300 })
    sink.offer(context, rawUser('一'))
    sink.offer(context, rawUser('二'), true)
    expect(fake.append).not.toHaveBeenCalled()
    await flushMicrotasks() // seed → 处理队列：先 debounce 后 force 立即写
    expect(fake.append).toHaveBeenCalledTimes(1)
    const [events] = fake.append.mock.calls[0]
    const persisted = events as CanonicalConversationEvent[]
    expect(persisted.map(event => event.sequence)).toEqual([1, 2])
    expect((persisted[0].typedPayload as { text?: string })?.text).toBe('一')
    expect((persisted[1].typedPayload as { text?: string })?.text).toBe('二')
    sink.dispose()
  })

  it('seed 瞬时失败：保留队列并退避重试，恢复后最终 append', async () => {
    const fake = fakeRepository()
    fake.revision.mockRejectedValueOnce(new Error('event db unavailable')).mockResolvedValueOnce(0)
    fake.append.mockResolvedValue(1)
    const onError = vi.fn()
    const sink = createCanonicalEventSink({ repository: fake.repository, debounceMs: 300, seedRetryMs: 100, onError })
    sink.offer(context, rawUser('x'), true)
    await flushMicrotasks()
    expect(onError).toHaveBeenCalledWith(OWNER_KEY, expect.any(Error))
    expect(fake.append).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(fake.revision).toHaveBeenCalledTimes(2)
    expect(fake.append).toHaveBeenCalledTimes(1)
    sink.dispose()
  })

  it('关闭 drain 对仍失败的 seed 立即再试并传播错误', async () => {
    const fake = fakeRepository()
    fake.revision.mockRejectedValue(new Error('event db unavailable'))
    const sink = createCanonicalEventSink({
      repository: fake.repository,
      seedRetryMs: 5_000,
      onError: vi.fn(),
    })
    sink.offer(context, rawUser('must-stay'))
    await flushMicrotasks()
    await expect(sink.flushAllAsync()).rejects.toThrow('event db unavailable')
    expect(fake.revision).toHaveBeenCalledTimes(2)
    sink.dispose()
  })

  it('写成功后 pending 按 sequence 移除，下一次只写新增事件且 sequence 连续', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(1)
    const sink = createCanonicalEventSink({ repository: fake.repository, debounceMs: 300 })
    sink.offer(context, rawUser('一'), true)
    await flushMicrotasks()
    expect(fake.append).toHaveBeenCalledTimes(1)
    sink.offer(context, rawUser('二'), true)
    await flushMicrotasks()
    expect(fake.append).toHaveBeenCalledTimes(2)
    const second = fake.append.mock.calls[1][0] as CanonicalConversationEvent[]
    expect(second.map(event => event.sequence)).toEqual([2])
    expect((second[0].typedPayload as { text?: string })?.text).toBe('二')
    sink.dispose()
  })

  it('event_revision_conflict：保留冲突批次，重新播种/rebase 后原批与后续事件连续写入', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValueOnce(0).mockResolvedValueOnce(10)
    fake.append.mockRejectedValueOnce(new CanonicalEventRepositoryError('event_revision_conflict', 'revision 冲突'))
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(12)
    const onError = vi.fn()
    const sink = createCanonicalEventSink({ repository: fake.repository, debounceMs: 300, onError })
    sink.offer(context, rawUser('旧基线'), true)
    await flushMicrotasks()
    expect(onError).toHaveBeenCalledWith(OWNER_KEY, expect.any(CanonicalEventRepositoryError))
    await flushMicrotasks()
    expect(fake.revision).toHaveBeenCalledTimes(2)
    expect(fake.append).toHaveBeenCalledTimes(2)
    const retry = fake.append.mock.calls[1][0] as CanonicalConversationEvent[]
    expect(retry.map(event => event.sequence)).toEqual([11])
    expect((retry[0].typedPayload as { text?: string })?.text).toBe('旧基线')
    sink.offer(context, rawUser('新基线'), true)
    await flushMicrotasks()
    const next = fake.append.mock.calls[2][0] as CanonicalConversationEvent[]
    expect(next.map(event => event.sequence)).toEqual([12])
    sink.dispose()
  })

  it('event_session_deleted：DEL-04 tombstone 拒绝后整 owner 停用，不 reseed 不复活', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockRejectedValue(new CanonicalEventRepositoryError('event_session_deleted', '会话已删除（tombstone）'))
    const onError = vi.fn()
    const sink = createCanonicalEventSink({ repository: fake.repository, debounceMs: 300, onError })
    sink.offer(context, rawUser('迟到写'), true)
    await flushMicrotasks()
    expect(onError).toHaveBeenCalledWith(OWNER_KEY, expect.any(CanonicalEventRepositoryError))
    expect(fake.append).toHaveBeenCalledTimes(1)
    const revisionCalls = fake.revision.mock.calls.length
    // 同 owner 后续 offer 不得复活（不重新播种、不重试）
    sink.offer(context, rawUser('复活尝试'), true)
    vi.advanceTimersByTime(300)
    await flushMicrotasks()
    expect(fake.append).toHaveBeenCalledTimes(1)
    expect(fake.revision.mock.calls.length).toBe(revisionCalls)
    sink.dispose()
  })

  it('明确 discard 后在飞写收到 tombstone：不再上报预期删除竞态', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    let rejectAppend!: (error: unknown) => void
    fake.append.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectAppend = reject
    }))
    const onError = vi.fn()
    const sink = createCanonicalEventSink({ repository: fake.repository, onError })

    sink.offer(context, rawUser('in-flight'), true)
    await flushMicrotasks() // seed 完成并启动 append
    expect(fake.append).toHaveBeenCalledTimes(1)

    // 删除事务已写入 tombstone，同时取消本地未落盘 owner；append 仍可能在飞。
    sink.discard(OWNER_KEY)
    rejectAppend(new CanonicalEventRepositoryError('event_session_deleted', '会话已删除（tombstone）'))
    await flushMicrotasks()

    expect(onError).not.toHaveBeenCalled()
    sink.dispose()
  })

  it('dispose 后在飞写迟到失败不再上报或复活 owner', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    let rejectAppend!: (error: unknown) => void
    fake.append.mockImplementation(() => new Promise((_resolve, reject) => { rejectAppend = reject }))
    const onError = vi.fn()
    const sink = createCanonicalEventSink({ repository: fake.repository, onError })

    sink.offer(context, rawUser('in-flight'), true)
    await flushMicrotasks()
    expect(fake.append).toHaveBeenCalledTimes(1)
    const revisionCalls = fake.revision.mock.calls.length

    sink.dispose()
    rejectAppend(new Error('old sink failed late'))
    await flushMicrotasks()
    sink.offer(context, rawUser('must-not-revive'), true)
    await flushMicrotasks()

    expect(onError).not.toHaveBeenCalled()
    expect(fake.revision).toHaveBeenCalledTimes(revisionCalls)
  })

  it('discard：未落盘事件丢弃，之后同 owner offer 不重新播种/不写', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    const sink = createCanonicalEventSink({ repository: fake.repository, debounceMs: 300 })
    sink.offer(context, rawUser('pending'))
    await flushMicrotasks()
    sink.discard(OWNER_KEY)
    const revisionCalls = fake.revision.mock.calls.length
    sink.offer(context, rawUser('late'), true)
    vi.advanceTimersByTime(300)
    expect(fake.append).not.toHaveBeenCalled()
    expect(fake.revision.mock.calls.length).toBe(revisionCalls)
    sink.dispose()
  })
})
