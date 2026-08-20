import { useEffect, useState } from 'react'
import { sessionUiStateGet, sessionUiStateSet } from './sessionUiState'
import type { Message } from './messageTypes'

/**
 * useMessageLocation — 跨会话搜索定位消费（FE-AUD-003，报告 5A）。
 *
 * 消息就绪后消费 pendingMessageLocation：目标消息存在 → scrollIntoView +
 * 高亮（返回 locateId 供并入搜索高亮）；不存在 → 过期提示。消费即清除意图。
 */
export function useMessageLocation(
  sessionId: string | null,
  messages: readonly Message[],
  messageRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>,
): { locateId: string | null; locateError: string } {
  const [locateId, setLocateId] = useState<string | null>(null)
  const [locateError, setLocateError] = useState('')

  useEffect(() => {
    if (!sessionId) return
    const pending = sessionUiStateGet<{ sessionId: string; messageId: string }>(sessionId, 'pendingMessageLocation')
    if (!pending) return
    sessionUiStateSet(sessionId, 'pendingMessageLocation', undefined)
    if (pending.sessionId !== sessionId) return
    if (!messages.some(message => message.id === pending.messageId)) {
      setLocateError('快照已过期：目标消息已不在该会话')
      return
    }
    setLocateId(pending.messageId)
  }, [messages, sessionId])

  useEffect(() => {
    if (!locateId) return
    const node = messageRefs.current.get(locateId)
    if (node) {
      node.scrollIntoView({ block: 'center' })
      const timer = window.setTimeout(() => setLocateId(null), 1800)
      return () => window.clearTimeout(timer)
    }
    setLocateError('快照已过期：目标消息已不在该会话')
    setLocateId(null)
  }, [locateId, messageRefs])

  return { locateId, locateError }
}
