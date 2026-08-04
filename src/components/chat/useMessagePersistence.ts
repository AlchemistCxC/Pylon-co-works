import { useEffect } from 'react'
import { canPersistMessages, persistMessageSnapshot } from './messagePersistence'
import type { Message } from './messageTypes'

/**
 * useMessagePersistence — 当前可见会话消息同步 localStorage（CV-5）。
 * 后台会话在事件入口直接持久化（chatEventController），此处只负责可见会话。
 */
export function useMessagePersistence(
  sessionId: string | null,
  messages: Message[],
  refs: { sessionRef: React.MutableRefObject<string | null>; messageOwnerRef: React.MutableRefObject<string | null> },
) {
  const { sessionRef, messageOwnerRef } = refs
  useEffect(() => {
    const ownerId = messageOwnerRef.current
    const source = sessionRef.current
    const renderedSource = sessionRef.current
    if (!canPersistMessages({ ownerId, source, renderedSessionId: sessionId, renderedSource }) || messages.length === 0) return
    const ownedSessionId = ownerId as string
    try { persistMessageSnapshot(ownedSessionId, messages, localStorage) } catch {}
  }, [messages, sessionId])
}
