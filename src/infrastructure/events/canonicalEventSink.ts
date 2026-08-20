/**
 * canonicalEventSink — canonical 事件归一 + 落盘闸口（A1-c P2）。
 *
 * 职责：
 * - 每个 owner 首次写入前用 `evt_revision` 播种 sequence 基线；
 * - 播种期间的原始事件排队，播种成功后按到达顺序归一落盘；
 * - 播种失败：保留原始队列并有界退避重试；关闭 drain 会立即再试并传播失败；
 * - `event_revision_conflict`：保留 pending，读取同一 journal revision 后整体
 *   rebase/retry，不丢弃冲突批次。
 * - `event_session_deleted`（DEL-04 tombstone gate）：后端拒绝迟到写——整 owner
 *   停用，不再播种/重试（不复活已删会话）。
 *
 * 不负责：UI dispatch、replay（调用方保证 replay 不进入本 sink）。
 */
import { normalizeRawEvent } from '../../domains/events/canonicalNormalizer'
import {
  toCanonicalOwnerKey,
  type CanonicalConversationEvent,
  type CanonicalEventOwner,
} from '../../domains/events/eventSchema'
import { reportRuntimeError } from '../../runtimeError'
import {
  asCanonicalEventRepositoryError,
  tauriCanonicalEventRepository,
  type CanonicalEventRepository,
} from './canonicalEventRepository'
import { createCanonicalEventPersistScheduler } from './canonicalEventPersistScheduler'
import { publishPluginEvent } from './pluginEventBus.ts'

export interface CanonicalEventOfferContext {
  owner: CanonicalEventOwner
  clientGeneration: number
}

export interface CanonicalEventSink {
  /** 归一并落盘一条原始 wire（force=true 立即写，用于终态/切会话）。 */
  offer(context: CanonicalEventOfferContext, raw: unknown, force?: boolean): void
  /** 强制 flush 全部未落盘事件。 */
  flushAll(): void
  /** 异步 flush 并等待在飞写完成（窗口关闭用）。 */
  flushAllAsync(): Promise<void>
  /** 丢弃该 owner 全部未落盘事件与播种状态（会话被 prune）。 */
  discard(ownerKey: string): void
  dispose(): void
}

export interface CanonicalEventSinkDeps {
  repository?: CanonicalEventRepository
  debounceMs?: number
  onError?: (ownerKey: string, error: unknown) => void
  /** seed/reseed 失败后的基础退避；测试可缩短。 */
  seedRetryMs?: number
}

type OwnerStatus = 'seeding' | 'ready'

interface OwnerState {
  owner: CanonicalEventOwner
  clientGeneration: number
  status: OwnerStatus
  /** 已分配给最后一条事件的 sequence（服务端 revision 播种后从 revision 起）。 */
  seq: number
  /** 尚未确认写成功的已归一事件（latest-wins 批次；写成功后按 sequence 移除）。 */
  pending: CanonicalConversationEvent[]
  /** 播种期间的原始事件队列。 */
  queue: Array<{ raw: unknown; force: boolean }>
  seedAttempts: number
  seedError: unknown | null
}

export function createCanonicalEventSink(deps: CanonicalEventSinkDeps = {}): CanonicalEventSink {
  const repository = deps.repository ?? tauriCanonicalEventRepository()
  const states = new Map<string, OwnerState>()
  /** discard 后不得复活（scheduler 层也拒写；此处挡掉 reseed 与归一）。 */
  const discardedOwners = new Set<string>()
  const seedTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const seedInflight = new Map<string, Promise<void>>()
  const seedRetryMs = deps.seedRetryMs ?? 300
  const reportError = deps.onError ?? ((ownerKey: string, error: unknown) => {
    reportRuntimeError(`canonical 事件落盘失败（${ownerKey}）`, error)
  })

  const scheduler = createCanonicalEventPersistScheduler({
    debounceMs: deps.debounceMs ?? 300,
    persist: async (ownerKey, events, expectedRevision) => {
      const canonicalEvents = events as CanonicalConversationEvent[]
      try {
        const revision = await repository.append(canonicalEvents, expectedRevision)
        // 写成功的 sequence 从 pending 移除；更新期间到达的新事件保留。
        const state = states.get(ownerKey)
        if (state) {
          const written = new Set(canonicalEvents.map(event => event.sequence))
          state.pending = state.pending.filter(event => !written.has(event.sequence))
        }
        return revision
      } catch (error) {
        // 冲突：保留全部 pending，重新读取同一 journal revision 后整体 rebase/retry。
        const code = asCanonicalEventRepositoryError(error).code
        if (code === 'event_revision_conflict') {
          const state = states.get(ownerKey)
          if (state && state.status === 'ready') {
            state.status = 'seeding'
            reseed(ownerKey)
          }
        } else if (code === 'event_session_deleted') {
          // DEL-04：owner 已 tombstone——停用整 owner（不 reseed、不再重试）。
          discardedOwners.add(ownerKey)
          states.delete(ownerKey)
          scheduler.discard(ownerKey)
        }
        throw error
      }
    },
    onError: reportError,
  })

  const reseed = (ownerKey: string, scheduleRetry = true): Promise<void> => {
    const existing = seedInflight.get(ownerKey)
    if (existing) return existing
    const timer = seedTimers.get(ownerKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      seedTimers.delete(ownerKey)
    }
    const task = repository.revision(ownerKey).then(revision => {
      const current = states.get(ownerKey)
      if (!current || current.status !== 'seeding') return
      // 成功 seed 后 append 可能立即因并发写者产生 conflict；先释放本次 seed single-flight，
      // 使 persist catch 能启动真正的新一轮 reseed，而不是复用已完成的旧 Promise。
      seedInflight.delete(ownerKey)
      scheduler.seedRevision(ownerKey, revision)
      // conflict 后 pending 已经发布但尚未 durable：在同一 owner journal 上连续 rebase。
      current.pending = current.pending.map((event, index) => {
        const sequence = revision + index + 1
        return { ...event, sequence, eventId: `${ownerKey}#${sequence}` }
      })
      current.seq = revision + current.pending.length
      current.status = 'ready'
      current.seedAttempts = 0
      current.seedError = null
      if (current.pending.length > 0) {
        scheduler.markDirty(ownerKey, [...current.pending], true)
      }
      const queued = current.queue
      current.queue = []
      for (const item of queued) {
        processReady(current, ownerKey, item.raw, item.force)
      }
    }).catch(error => {
      const current = states.get(ownerKey)
      if (current) {
        current.seedAttempts += 1
        current.seedError = error
        if (scheduleRetry && !discardedOwners.has(ownerKey)) {
          const delay = Math.min(seedRetryMs * (2 ** Math.min(current.seedAttempts - 1, 4)), 5_000)
          seedTimers.set(ownerKey, setTimeout(() => {
            seedTimers.delete(ownerKey)
            void reseed(ownerKey)
          }, delay))
        }
      }
      reportError(ownerKey, error)
    }).finally(() => {
      seedInflight.delete(ownerKey)
    })
    seedInflight.set(ownerKey, task)
    return task
  }

  const processReady = (state: OwnerState, ownerKey: string, raw: unknown, force: boolean): void => {
    const normalized = normalizeRawEvent(raw, {
      owner: state.owner,
      clientGeneration: state.clientGeneration,
      sequence: state.seq + 1,
      receivedAt: new Date().toISOString(),
    })
    state.seq = normalized.event.sequence
    state.pending.push(normalized.event)
    publishPluginEvent(normalized.event)
    scheduler.markDirty(ownerKey, [...state.pending], force)
  }

  return {
    offer(context, raw, force = false) {
      const ownerKey = toCanonicalOwnerKey(context.owner)
      if (discardedOwners.has(ownerKey)) return
      let state = states.get(ownerKey)
      if (!state) {
        state = {
          owner: { ...context.owner },
          clientGeneration: context.clientGeneration,
          status: 'seeding',
          seq: 0,
          pending: [],
          queue: [],
          seedAttempts: 0,
          seedError: null,
        }
        states.set(ownerKey, state)
        reseed(ownerKey)
      }
      if (state.status === 'seeding') {
        state.queue.push({ raw, force })
        return
      }
      processReady(state, ownerKey, raw, force)
    },
    flushAll: () => scheduler.flushAll(),
    flushAllAsync: async () => {
      // 关闭时不等待后台 timer：所有 seeding owner 立即再试一次，仍失败则传播。
      const seeding = [...states.entries()].filter(([, state]) => state.status === 'seeding')
      await Promise.all(seeding.map(([ownerKey]) => reseed(ownerKey, false)))
      const seedFailures = [...states.values()]
        .filter(state => state.status === 'seeding' && state.seedError !== null)
        .map(state => state.seedError)
      if (seedFailures.length === 1) throw seedFailures[0]
      if (seedFailures.length > 1) throw new AggregateError(seedFailures, '多个 canonical owner 播种失败')
      await scheduler.flushAllAsync()
    },
    discard: (ownerKey) => {
      discardedOwners.add(ownerKey)
      const timer = seedTimers.get(ownerKey)
      if (timer !== undefined) clearTimeout(timer)
      seedTimers.delete(ownerKey)
      states.delete(ownerKey)
      scheduler.discard(ownerKey)
    },
    dispose: () => {
      discardedOwners.clear()
      for (const timer of seedTimers.values()) clearTimeout(timer)
      seedTimers.clear()
      seedInflight.clear()
      states.clear()
      scheduler.dispose()
    },
  }
}
