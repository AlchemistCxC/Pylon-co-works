// @vitest-environment jsdom
/**
 * useMessageLocation 消费行为测试（FE-AUD-003 / 报告 5A）：
 * 意图 → 消息就绪 → scrollIntoView + 清除；目标缺失 → 过期提示。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMessageLocation } from '../useMessageLocation'
import { sessionUiStateGet, sessionUiStateSet } from '../sessionUiState'
import type { Message } from '../messageTypes'

function makeMessage(id: string): Message {
  return { id, role: 'user', content: `msg-${id}`, time: Date.now(), sender: 'user' } as unknown as Message
}

function makeRefs(entries: Array<[string, HTMLDivElement | null]>) {
  return { current: new Map(entries) } as React.MutableRefObject<Map<string, HTMLDivElement | null>>
}

describe('useMessageLocation（FE-AUD-003 消费者）', () => {
  beforeEach(() => {
    sessionUiStateSet('s1', 'pendingMessageLocation', undefined)
    vi.restoreAllMocks()
    // jsdom 无 scrollIntoView 实现
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it('意图 + 目标消息就绪：scrollIntoView 被调 + 意图清除', () => {
    sessionUiStateSet('s1', 'pendingMessageLocation', { sessionId: 's1', messageId: 'm1' })
    const node = document.createElement('div')
    const { result } = renderHook(() => useMessageLocation('s1', [makeMessage('m1')], makeRefs([['m1', node]])))
    expect(node.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(result.current.locateId).toBe('m1')
    expect(sessionUiStateGet('s1', 'pendingMessageLocation')).toBeUndefined()
  })

  it('意图 + 目标缺失：过期提示，不 scroll', () => {
    sessionUiStateSet('s1', 'pendingMessageLocation', { sessionId: 's1', messageId: 'ghost' })
    const node = document.createElement('div')
    const { result } = renderHook(() => useMessageLocation('s1', [makeMessage('m1')], makeRefs([['m1', node]])))
    expect(node.scrollIntoView).not.toHaveBeenCalled()
    expect(result.current.locateError).toContain('快照已过期')
    expect(sessionUiStateGet('s1', 'pendingMessageLocation')).toBeUndefined()
  })

  it('无意图：无定位无错误', () => {
    const { result } = renderHook(() => useMessageLocation('s1', [makeMessage('m1')], makeRefs([])))
    expect(result.current.locateId).toBeNull()
    expect(result.current.locateError).toBe('')
  })
})
