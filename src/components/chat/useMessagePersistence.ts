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
  useEffect(() => {
    const ownerId = refs.messageOwnerRef.current
    const source = refs.sessionRef.current
    const renderedSource = refs.sessionRef.current
    if (!canPersistMessages({ ownerId, source, renderedSessionId: sessionId, renderedSource }) || messages.length === 0) return
    const ownedSessionId = ownerId as string
    try { persistMessageSnapshot(ownedSessionId, messages, localStorage) } catch {}
    // refs 是稳定 ref 对象（来自 useSessionLifecycle），无需加入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sessionId])
}
