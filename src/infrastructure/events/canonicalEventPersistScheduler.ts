/**
 * canonicalEventPersistScheduler — canonical 事件流落盘调度（A1-c P1）。
 *
 * 语义镜像 messagePersistScheduler，但按 owner_key 键控：
 * - per-owner trailing debounce（默认 300ms）+ async single-flight（latest wins）；
 * - 成功写携带 revision 作为下一次 expected_revision（旧写不覆盖新写）；
 * - 失败不丢内存事件：普通失败恢复 dirty（下次 flush 重试）并经 onError 可见上报；
 * - revision conflict 由 sink 重新播种并替换 dirty 批次，不丢事件；真正终态失败
 *   仅 event_invalid / event_session_deleted。
 * - discard(ownerKey)：会话被 prune 时丢弃未落盘事件，并使已在途写入的结果失效
 *   （DEL-04 后端 tombstone gate 兜底迟到写；前端 discard 仍负责本地清理）。
 */
import { asCanonicalEventRepositoryError, CanonicalEventRepositoryError } from './canonicalEventRepository'

export interface CanonicalEventPersistSchedulerOptions {
  debounceMs?: number
  /** 持久化回调：返回最新 revision；失败必须 reject（不吞错）。 */
  persist: (ownerKey: string, events: readonly unknown[], expectedRevision: number | null) => Promise<number>
  /** 写失败可见上报（不静默吞）；缺省 console.error。 */
  onError?: (ownerKey: string, error: unknown) => void
}

/** 终态错误：重试必然失败，丢弃同批并清 revision，不恢复 dirty。 */
function isTerminalEventError(error: unknown): boolean {
  return error instanceof CanonicalEventRepositoryError
    && (error.code === 'event_invalid'
      || error.code === 'event_session_deleted')
}

export function createCanonicalEventPersistScheduler({ debounceMs = 300, persist, onError }: CanonicalEventPersistSchedulerOptions) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const dirty = new Map<string, readonly unknown[]>()
  /** 每 owner 最近成功写后的 revision（expected_revision 基准；null = 尚未写）。 */
  const revisions = new Map<string, number>()
  /** 单飞行标记：在飞 owner 的新 dirty 保留，完成后自动续写。 */
  const inflight = new Set<string>()
  /** 在飞 Promise 记录：供 flushAllAsync 等待全部落盘完成后返回。 */
  const inflightPromises = new Map<string, Promise<unknown>>()
  /** 最近一次未被后续成功写恢复的失败；关闭 drain 必须向调用方传播。 */
  const failures = new Map<string, unknown>()
  /** 已丢弃的 owner（discard 后不写、不复活）。 */
  const discarded = new Set<string>()

  const reportError = (ownerKey: string, error: unknown) => {
    if (onError) {
      onError(ownerKey, error)
    } else {
      console.error(`[canonicalEventPersistScheduler] 事件落盘失败 (${ownerKey}):`, error)
    }
  }

  const persistNow = (ownerKey: string): boolean => {
    const timer = timers.get(ownerKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(ownerKey)
    }
    if (inflight.has(ownerKey)) return false
    if (discarded.has(ownerKey)) return false
    const pending = dirty.get(ownerKey)
    if (pending === undefined) return false
    // 显式开始一次新尝试即消费旧失败；本次若仍失败会重新记录。
    failures.delete(ownerKey)
    inflight.add(ownerKey)
    dirty.delete(ownerKey)
    const expectedRevision = revisions.get(ownerKey) ?? null
    const promise = (async () => {
      try {
        const revision = await persist(ownerKey, pending, expectedRevision)
        // discard() may run while the append is in flight.  Its result is no
        // longer a valid baseline for this owner, even when the backend write
        // itself eventually succeeds.
        if (!discarded.has(ownerKey)) revisions.set(ownerKey, revision)
      } catch (error) {
        // An explicit discard makes the backend tombstone response an expected
        // outcome.  Keep other persistence failures visible even if the owner
        // was removed, so a real database problem is never silently hidden.
        if (
          discarded.has(ownerKey)
          && asCanonicalEventRepositoryError(error).code === 'event_session_deleted'
        ) return
        failures.set(ownerKey, error)
        if (isTerminalEventError(error)) {
          // 终态失败：同批与 revision 基准均失效，丢弃（调用方重新播种）。
          dirty.delete(ownerKey)
          revisions.delete(ownerKey)
        } else if (!dirty.has(ownerKey)) {
          // 仅当没有更新的批次在飞期间到达时才恢复 pending（不得用旧数据覆盖新批次）。
          dirty.set(ownerKey, pending)
        }
        reportError(ownerKey, error)
      } finally {
        inflight.delete(ownerKey)
        inflightPromises.delete(ownerKey)
        // 仅在飞期间有更新的批次（引用与本次不同）时立即续写（latest wins）——
        // 失败恢复的同批次不触发自动重试（避免失败热点下无界重试循环）。
        const current = dirty.get(ownerKey)
        if (!discarded.has(ownerKey)
          && current !== undefined
          && current !== pending
          && !timers.has(ownerKey)) {
          persistNow(ownerKey)
        }
      }
    })()
    inflightPromises.set(ownerKey, promise)
    return true
  }

  return {
    /** 用 repository revision 明确重置 optimistic baseline（首次 seed / conflict reseed）。 */
    seedRevision: (ownerKey: string, revision: number): void => {
      if (!discarded.has(ownerKey)) revisions.set(ownerKey, revision)
    },
    /** 标记该 owner 事件为 dirty；force=true 立即写盘（终态事件 / 切会话 / dispose）。 */
    markDirty: (ownerKey: string, events: readonly unknown[], force = false): void => {
      if (discarded.has(ownerKey)) return
      dirty.set(ownerKey, events)
      if (force) {
        persistNow(ownerKey)
        return
      }
      const existing = timers.get(ownerKey)
      if (existing !== undefined) clearTimeout(existing)
      timers.set(ownerKey, setTimeout(() => persistNow(ownerKey), debounceMs))
    },
    /** 强制 flush 全部 dirty（已丢弃 owner 跳过）。 */
    flushAll: (): void => {
      for (const ownerKey of [...dirty.keys()]) {
        if (!discarded.has(ownerKey)) persistNow(ownerKey)
      }
    },
    /**
     * 异步稳定 drain：等待调用期间产生的续写批次；任一 owner 的最后写入失败则
     * reject 并保留 dirty，关闭流程不得把“尚未 durable”误报为成功。
     */
    flushAllAsync: async (): Promise<void> => {
      const startDirty = (): void => {
        for (const ownerKey of [...dirty.keys()]) {
          if (!discarded.has(ownerKey)) persistNow(ownerKey)
        }
      }
      startDirty()
      while (true) {
        const pending = [...inflightPromises.values()]
        if (pending.length > 0) await Promise.allSettled(pending)

        // 若在飞期间到达更新批次，finally 或下一轮 startDirty 会继续写；只有 owner
        // 已空闲时仍留有 failure，才是本次 drain 的最终失败。
        const idleFailures = [...failures.entries()]
          .filter(([ownerKey]) => !inflight.has(ownerKey))
          .map(([, error]) => error)
        if (idleFailures.length === 1) throw idleFailures[0]
        if (idleFailures.length > 1) {
          throw new AggregateError(idleFailures, '多个 canonical event owner 落盘失败')
        }

        startDirty()
        if (dirty.size === 0 && inflightPromises.size === 0) return
      }
    },
    /** 丢弃该 owner 未落盘事件与 revision 基准（会话被 prune；不复活）。 */
    discard: (ownerKey: string): void => {
      discarded.add(ownerKey)
      const timer = timers.get(ownerKey)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(ownerKey)
      }
      dirty.delete(ownerKey)
      revisions.delete(ownerKey)
      failures.delete(ownerKey)
    },
    /** 清理全部 timer（不 flush——dispose 语义为丢弃未落盘，由调用方决定先 flushAll）。 */
    dispose: (): void => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      dirty.clear()
      revisions.clear()
      failures.clear()
      discarded.clear()
    },
    hasDirty: (ownerKey: string): boolean => dirty.has(ownerKey),
  }
}

export type CanonicalEventPersistScheduler = ReturnType<typeof createCanonicalEventPersistScheduler>
