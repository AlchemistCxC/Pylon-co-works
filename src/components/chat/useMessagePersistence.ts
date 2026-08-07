import { useEffect } from 'react'
import { canPersistMessages } from './messagePersistence'
import { messagePersistScheduler } from './messagePersistScheduler'
import type { Message } from './messageTypes'

/**
 * useMessagePersistence — 当前可见会话消息同步 localStorage（CV-5，报告 6C/FE-AUD-014）。
 * 经统一 messagePersistScheduler（trailing debounce 300ms）；切会话 force flush。
 * 后台会话在事件入口走同一 scheduler（chatEventController）。
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
    // 切会话时 force flush（消息不丢尾）；普通追加走 debounce
    messagePersistScheduler.markDirty(ownedSessionId, messages, sessionId === null || refs.sessionRef.current !== sessionId)
    // refs 是稳定 ref 对象（来自 useSessionLifecycle），无需加入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sessionId])
}
