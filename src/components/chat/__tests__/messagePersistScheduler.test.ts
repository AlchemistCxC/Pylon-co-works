/**
 * messagePersistScheduler 行为测试（报告 6C / FE-AUD-014）：
 * trailing debounce 合并、force 立即写、flushAll/dispose。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessagePersistScheduler } from '../messagePersistScheduler'

describe('messagePersistScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('trailing debounce：多次 markDirty 只写最后一次', () => {
    const persist = vi.fn()
    const scheduler = createMessagePersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('s1', [1])
    scheduler.markDirty('s1', [2])
    scheduler.markDirty('s1', [3])
    expect(persist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(299)
    expect(persist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith('s1', [3])
  })

  it('force=true 立即写盘，不等待 debounce', () => {
    const persist = vi.fn()
    const scheduler = createMessagePersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('s1', [1])
    scheduler.markDirty('s1', [2], true)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith('s1', [2])
  })

  it('per-session 独立 debounce（A 不阻塞 B）', () => {
    const persist = vi.fn()
    const scheduler = createMessagePersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('sA', ['a'])
    scheduler.markDirty('sB', ['b'])
    vi.advanceTimersByTime(300)
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('flushAll 强制写全部 dirty；dispose 丢弃未落盘', () => {
    const persist = vi.fn()
    const scheduler = createMessagePersistScheduler({ debounceMs: 300, persist })
    scheduler.markDirty('s1', [1])
    scheduler.markDirty('s2', [2])
    scheduler.flushAll()
    expect(persist).toHaveBeenCalledTimes(2)
    scheduler.markDirty('s3', [3])
    scheduler.dispose()
    vi.advanceTimersByTime(300)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(scheduler.hasDirty('s3')).toBe(false)
  })
})
