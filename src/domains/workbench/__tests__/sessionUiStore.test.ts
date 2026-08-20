import { describe, expect, it, vi } from 'vitest'
import { createSessionUiStore } from '../sessionUiStore.ts'

describe('createSessionUiStore', () => {
  it('按 session/key 隔离，并以 fallback 读取未设置状态', () => {
    const store = createSessionUiStore()

    expect(store.get('session-a', 'draft', '')).toBe('')
    store.set('session-a', 'draft', 'A 草稿')
    store.set('session-b', 'draft', 'B 草稿')
    store.set('session-a', 'search-query', 'needle')

    expect(store.get('session-a', 'draft', '')).toBe('A 草稿')
    expect(store.get('session-b', 'draft', '')).toBe('B 草稿')
    expect(store.get('session-a', 'search-query', '')).toBe('needle')
    expect(store.get('session-b', 'search-query', '')).toBe('')
  })

  it('只通知对应 session/key，Object.is 相同值不重复通知', () => {
    const store = createSessionUiStore()
    const draftListener = vi.fn()
    const queueListener = vi.fn()
    const otherSessionListener = vi.fn()

    store.subscribe('session-a', 'draft', draftListener)
    store.subscribe('session-a', 'queued-messages', queueListener)
    store.subscribe('session-b', 'draft', otherSessionListener)

    store.set('session-a', 'draft', 'hello')
    store.set('session-a', 'draft', 'hello')
    store.set('session-a', 'queued-messages', [{ id: 1, text: 'next' }])

    expect(draftListener).toHaveBeenCalledTimes(1)
    expect(queueListener).toHaveBeenCalledTimes(1)
    expect(otherSessionListener).not.toHaveBeenCalled()
  })

  it('update 基于当前会话值原子计算，clear 只清目标会话', () => {
    const store = createSessionUiStore()
    const listener = vi.fn()
    store.subscribe('session-a', 'input-history', listener)
    store.set('session-a', 'input-history', ['first'])
    store.set('session-b', 'input-history', ['other'])

    const result = store.update('session-a', 'input-history', [] as string[], previous => [...previous, 'second'])
    expect(result).toEqual(['first', 'second'])
    expect(store.get('session-a', 'input-history', [])).toEqual(['first', 'second'])

    store.clear('session-a')
    expect(store.get('session-a', 'input-history', [])).toEqual([])
    expect(store.get('session-b', 'input-history', [])).toEqual(['other'])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('unsubscribe、clearAll 与 destroy 都幂等且不泄漏通知', () => {
    const store = createSessionUiStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe('session-a', 'draft', listener)
    store.set('session-a', 'draft', 'before')
    unsubscribe()
    unsubscribe()
    store.set('session-a', 'draft', 'after-unsubscribe')
    store.clearAll()
    store.clearAll()
    store.destroy()
    store.destroy()
    store.set('session-a', 'draft', 'after-destroy')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get('session-a', 'draft', 'fallback')).toBe('fallback')
  })
})
