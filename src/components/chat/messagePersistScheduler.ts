/**
 * messagePersistScheduler — 消息快照持久化调度（报告 6C / FE-AUD-014）。
 *
 * 前台/后台统一一个 scheduler：per-session dirty 引用 + trailing debounce
 * （默认 300ms）；终态（done/error/cancel）、切会话、应用 dispose 强制 flush。
 * 避免长会话每次消息变化 O(n) 全量同步写盘。
 */
import { persistMessageSnapshot } from './messagePersistence'

export interface PersistSchedulerOptions {
  debounceMs?: number
  persist: (sessionId: string, messages: readonly unknown[]) => void
}

export function createMessagePersistScheduler({ debounceMs = 300, persist }: PersistSchedulerOptions) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const dirty = new Map<string, readonly unknown[]>()

  const flushNow = (sessionId: string): boolean => {
    const timer = timers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(sessionId)
    }
    const pending = dirty.get(sessionId)
    if (pending === undefined) return false
    dirty.delete(sessionId)
    try {
      persist(sessionId, pending)
    } catch {
      // 写盘失败：保持内存态，由调用方（reportRuntimeError/告警策略）处理
    }
    return true
  }

  return {
    /** 标记该 session 消息为 dirty；force=true 立即写盘（终态/切会话/卸载） */
    markDirty: (sessionId: string, messages: readonly unknown[], force = false): void => {
      dirty.set(sessionId, messages)
      if (force) {
        flushNow(sessionId)
        return
      }
      const existing = timers.get(sessionId)
      if (existing !== undefined) clearTimeout(existing)
      timers.set(sessionId, setTimeout(() => flushNow(sessionId), debounceMs))
    },
    /** 强制 flush 全部 dirty（应用 dispose/窗口关闭） */
    flushAll: (): void => {
      for (const sessionId of [...dirty.keys()]) flushNow(sessionId)
    },
    /** 清理全部 timer（不 flush——dispose 语义为丢弃未落盘，由调用方决定先 flushAll） */
    dispose: (): void => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      dirty.clear()
    },
    hasDirty: (sessionId: string): boolean => dirty.has(sessionId),
  }
}

export type MessagePersistScheduler = ReturnType<typeof createMessagePersistScheduler>

/** 应用级单例：前台（useMessagePersistence）与后台（chatEventController）共用 */
export const messagePersistScheduler = createMessagePersistScheduler({
  persist: (sessionId, messages) => {
    try {
      persistMessageSnapshot(sessionId, messages as never[], localStorage)
    } catch {
      // 写盘失败静默（内存态保持；一次性告警策略归阶段 8）
    }
  },
})
