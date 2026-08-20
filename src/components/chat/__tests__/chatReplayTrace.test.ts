import { beforeEach, describe, expect, it } from 'vitest'
import { CHAT_REPLAY_TRACE_FLAG, CHAT_REPLAY_TRACE_KEY, readChatReplayTrace, recordChatReplayTrace, safeContentEvidence } from '../chatReplayTrace'
import type { Message } from '../messageTypes'

const messages: Message[] = [
  { id: 'm1', role: 'user', sender: 'user', content: '敏感正文', time: 't' },
  { id: 'm2', role: 'assistant', sender: 'peri', content: '回答正文', time: 't' },
]

describe('TS-WI04 chat replay trace', () => {
  beforeEach(() => localStorage.clear())

  it('默认关闭，不产生 trace', () => {
    recordChatReplayTrace({ kind: 'load-start', ownerSessionId: 's1' })
    expect(localStorage.getItem(CHAT_REPLAY_TRACE_KEY)).toBeNull()
  })

  it('开启后写 JSONL，只记录 ids/长度/hash，不记录正文', () => {
    localStorage.setItem(CHAT_REPLAY_TRACE_FLAG, '1')
    recordChatReplayTrace({ kind: 'commit', ownerSessionId: 's1', ...safeContentEvidence(messages) })
    const raw = localStorage.getItem(CHAT_REPLAY_TRACE_KEY)!
    expect(raw).not.toContain('敏感正文')
    expect(raw).not.toContain('回答正文')
    expect(readChatReplayTrace()).toEqual([
      expect.objectContaining({ kind: 'commit', ownerSessionId: 's1', messageIds: ['m1', 'm2'], messageCount: 2, contentLength: expect.any(Number), contentHash: expect.any(String) }),
    ])
  })
})
