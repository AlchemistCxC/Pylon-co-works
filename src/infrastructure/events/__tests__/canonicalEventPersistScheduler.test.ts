/**
 * A1-c P1：canonicalEventPersistScheduler 行为测试。
 * trailing debounce / force / per-owner / flushAll / single-flight / revision /
 * 失败恢复 dirty / revision_conflict 保批 / 真正终态错误丢弃同批 /
 * discard 不复活。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanonicalEventPersistScheduler } from '../canonicalEventPersistScheduler'
import { CanonicalEventRepositoryError } from '../canonicalEventRepository'

/** 排空微任务（fake timers 下让 async 续写完成）。 */
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('canonicalEventPersistScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('trailing debounce：多次 markDirty 只写最后一次', () => {
    const persist = vi.fn().mockResolvedValue(0)
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('o1', [1])
    scheduler.markDirty('o1', [2])
    scheduler.markDirty('o1', [3])
    expect(persist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(299)
    expect(persist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith('o1', [3], null)
  })

  it('force=true 立即写盘，不等待 debounce', () => {
    const persist = vi.fn().mockResolvedValue(0)
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('o1', [1])
    scheduler.markDirty('o1', [2], true)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith('o1', [2], null)
  })

  it('per-owner 独立 debounce（A 不阻塞 B）', () => {
    const persist = vi.fn().mockResolvedValue(0)
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('oA', ['a'])
    scheduler.markDirty('oB', ['b'])
    vi.advanceTimersByTime(300)
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('flushAll 强制写全部 dirty；dispose 丢弃未落盘', () => {
    const persist = vi.fn().mockResolvedValue(0)
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('o1', [1])
    scheduler.markDirty('o2', [2])
    scheduler.flushAll()
    expect(persist).toHaveBeenCalledTimes(2)
    scheduler.markDirty('o3', [3])
    scheduler.dispose()
    vi.advanceTimersByTime(300)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(scheduler.hasDirty('o3')).toBe(false)
  })

  it('single-flight：在飞期间新 markDirty 保留，完成后以最新数据续写', async () => {
    let releaseFirst!: (revision: number) => void
    const calls: Array<[string, readonly unknown[], number | null]> = []
    const persist = vi.fn((ownerKey: string, events: readonly unknown[], expectedRevision: number | null) => {
      calls.push([ownerKey, events, expectedRevision])
      if (calls.length === 1) {
        return new Promise<number>((resolve) => { releaseFirst = resolve })
      }
      return Promise.resolve(1)
    })
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('o1', ['old'], true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['o1', ['old'], null])
    scheduler.markDirty('o1', ['newer'], true)
    expect(calls).toHaveLength(1)
    releaseFirst(0)
    await flushMicrotasks()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(['o1', ['newer'], 0])
  })

  it('single-flight：成功写携带上次 revision 作为 expected_revision（旧写不覆盖新写）', async () => {
    const persist = vi.fn().mockResolvedValue(5)
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('o1', ['a'], true)
    expect(persist).toHaveBeenCalledTimes(1)
    scheduler.markDirty('o1', ['b'], true)
    expect(persist).toHaveBeenCalledTimes(1)
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenNthCalledWith(1, 'o1', ['a'], null)
    expect(persist).toHaveBeenNthCalledWith(2, 'o1', ['b'], 5)
  })

  it('写失败不丢内存事件：保留 dirty + onError 可见上报，下次 flush 重试', async () => {
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockResolvedValueOnce(0)
    const onError = vi.fn()
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist, onError })
    scheduler.markDirty('o1', ['keep-me'], true)
    await flushMicrotasks()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('o1', expect.any(Error))
    scheduler.markDirty('o1', ['keep-me'], true)
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenNthCalledWith(2, 'o1', ['keep-me'], null)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('写失败不自动无界重试循环（失败恢复的同批次不触发续写）', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('db unavailable'))
    const onError = vi.fn()
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist, onError })
    scheduler.markDirty('o1', ['data'], true)
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('event_revision_conflict 保留同批 dirty，等待 sink 重新播种后重试', async () => {
    const persist = vi.fn().mockRejectedValue(new CanonicalEventRepositoryError('event_revision_conflict', 'revision 冲突'))
    const onError = vi.fn()
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist, onError })
    scheduler.markDirty('o1', ['stale'], true)
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('o1', expect.any(CanonicalEventRepositoryError))
    expect(scheduler.hasDirty('o1')).toBe(true)
    scheduler.seedRevision('o1', 10)
    scheduler.flushAll()
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenNthCalledWith(2, 'o1', ['stale'], 10)
  })

  it('终态 event_invalid：同样丢弃同批（不无限重试畸形事件）', async () => {
    const persist = vi.fn().mockRejectedValue(new CanonicalEventRepositoryError('event_invalid', 'eventId 不一致'))
    const onError = vi.fn()
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist, onError })
    scheduler.markDirty('o1', ['bad'], true)
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(scheduler.hasDirty('o1')).toBe(false)
  })

  it('终态 event_session_deleted：丢弃同批且后续 markDirty 不再复活（DEL-04 不复活语义）', async () => {
    const persist = vi.fn().mockRejectedValue(new CanonicalEventRepositoryError('event_session_deleted', '会话已删除（tombstone）'))
    const onError = vi.fn()
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist, onError })
    scheduler.markDirty('o1', ['late'], true)
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(scheduler.hasDirty('o1')).toBe(false)
    // 丢弃后不得复活
    scheduler.discard('o1')
    scheduler.markDirty('o1', ['revive-attempt'])
    scheduler.flushAll()
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('discard：清理未落盘 timer/dirty/revision，之后 markDirty 不再复活', async () => {
    const persist = vi.fn().mockResolvedValue(7)
    const scheduler = createCanonicalEventPersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('o1', ['pending'], true)
    await flushMicrotasks()
    expect(persist).toHaveBeenCalledTimes(1)
    scheduler.markDirty('oB', ['never-write'])
    scheduler.discard('oB')
    scheduler.markDirty('oB', ['late'])
    vi.advanceTimersByTime(300)
    scheduler.flushAll()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(scheduler.hasDirty('oB')).toBe(false)
  })

  it('flushAllAsync 是稳定 drain：等待首批完成期间产生的续写批次', async () => {
    let releaseFirst!: (revision: number) => void
    let releaseSecond!: (revision: number) => void
    const calls: unknown[][] = []
    const persist = vi.fn((_ownerKey: string, events: readonly unknown[]) => {
      calls.push([...events])
      return new Promise<number>((resolve) => {
        if (calls.length === 1) releaseFirst = resolve
        else releaseSecond = resolve
      })
    })
    const scheduler = createCanonicalEventPersistScheduler({ persist })
    scheduler.markDirty('o1', ['first'], true)
    const draining = scheduler.flushAllAsync()
    let drained = false
    void draining.then(() => { drained = true })

    scheduler.markDirty('o1', ['second'], true)
    releaseFirst(1)
    await flushMicrotasks()
    expect(calls).toEqual([['first'], ['second']])
    expect(drained).toBe(false)

    releaseSecond(2)
    await draining
    expect(drained).toBe(true)
  })

  it('flushAllAsync 传播落盘失败并保留 dirty，关闭流程不得静默成功', async () => {
    const failure = new Error('db unavailable')
    const scheduler = createCanonicalEventPersistScheduler({
      persist: vi.fn().mockRejectedValue(failure),
      onError: vi.fn(),
    })
    scheduler.markDirty('o1', ['keep-me'], true)
    await expect(scheduler.flushAllAsync()).rejects.toThrow('db unavailable')
    expect(scheduler.hasDirty('o1')).toBe(true)
  })
})
