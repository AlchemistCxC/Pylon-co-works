/**
 * userDataRepository — 用户数据（Profile/Session/activeProfileId）后端持久化 client
 * （ISSUE-14 W5 消费侧：Tauri 模式 identityStore mutation 写穿 versioned user store）。
 *
 * 分层：identityStore → UserDataRepository → tauri adapter(typed invoke)
 *       → Rust user_data_load / user_data_save → UserDataService → UserDataStore。
 *
 * 写穿语义（W5 最小闭环，W6 再接 hydration/读回）：
 * - per-key 串行队列 + 尾部合并：同一 key 至多一个在飞写；在飞期间的新 envelope 覆盖
 *   待写批次（latest wins，旧写不覆盖新写；不产生乱序落库）。
 * - revision baseline：首次保存前先读后端当前 revision 作为 expected 基准；每次成功
 *   保存以返回 revision 推进 baseline；expected 不匹配（跨写者）→ 后端返回
 *   user_data_revision_conflict，旧写被拒不覆盖新写，错误可见上报。
 * - 失败可见：envelope 为全量状态快照，写失败由下一次 mutation 的全量重发自动修复；
 *   错误经调用方可见上报（reportRuntimeError），不静默吞。
 *
 * browser 模式不经过本模块（identityStore 直接同步读写 localStorage，读路径不变）。
 */
import { IS_TAURI } from './infrastructure/tauri/env'

export type UserDataKey = 'profiles' | 'sessions'

/** 已存储 envelope 的 wire 形状（后端 UserDataEnvelope camelCase；payload 自描述含 version）。 */
export interface UserDataEnvelope {
  version: number
  revision: number
  payload: Record<string, unknown>
}

/** 保存结果 wire 形状（后端 UserDataSaveResult）：新 revision（后续 expected 基准）。 */
export interface UserDataSaveResult {
  revision: number
}

/** 写失败结构化错误：code 供分支（user_data_revision_conflict / user_data_unavailable / user_data_corrupt）。 */
export class UserDataRepositoryError extends Error {
  readonly code: string | undefined
  constructor(code: string | undefined, message: string) {
    super(message)
    this.name = 'UserDataRepositoryError'
    this.code = code
  }
}

/** Tauri invoke 拒绝值（后端 {code,message} 结构化错误）→ UserDataRepositoryError。 */
export function asUserDataRepositoryError(error: unknown): UserDataRepositoryError {
  if (error instanceof UserDataRepositoryError) return error
  if (error && typeof error === 'object' && 'message' in error) {
    const shape = error as { code?: string; message?: unknown }
    return new UserDataRepositoryError(shape.code, String(shape.message ?? error))
  }
  return new UserDataRepositoryError(undefined, String(error))
}

/** invoke 失败必须以 reject 传播（归一化，不得把失败变成功）。 */
export function rejectUserDataError(error: unknown): never {
  throw asUserDataRepositoryError(error)
}

// ── user_data_unavailable 有界重试（治"启动早期 service 未就绪→写穿失败→后端缺会话"）──
// 后端 user_data_service 由 tokio::spawn 异步初始化（create_dir + open_db + migrate），
// 启动早期前端 fire-and-forget 写穿会撞上槽位为 None → user_data_unavailable。
// SQLite 是 Tauri 模式唯一权威；这里对 unavailable 有界重试，避免正常 mutation 因
// 瞬时 service 抖动进入 unsynced。若最终失败，上层进入 degraded-readonly 并重读权威。
const MAX_SAVE_RETRY = 12
const RETRY_DELAY_MS = 300

function sleepFor(ms: number): Promise<void> {
  return new Promise(resolve => { globalThis.setTimeout(resolve, ms) })
}

function isUnavailable(error: unknown): boolean {
  return asUserDataRepositoryError(error).code === 'user_data_unavailable'
}

/** 延迟加载 Tauri invoke（仅 Tauri 模式执行；browser 模式永不执行）。
 *  缓存 in-flight promise：profiles/sessions 两条串行链可能同一微任务并发
 *  首次加载，并发 import 同一模块在部分 runner 下会竞态失败。 */
let invokeModulePromise: Promise<typeof import('@tauri-apps/api/core')> | null = null
async function loadInvoke(): Promise<typeof import('@tauri-apps/api/core')> {
  invokeModulePromise ??= import('@tauri-apps/api/core')
  return invokeModulePromise
}

/** I14-W7：Profile 删除结果（后端单事务 fallback/重绑定/activeProfileId）。 */
export interface ProfileDeleteResult {
  fallback: string
  profilesRevision: number
  sessionsRevision: number | null
}

/** 用户数据持久化 client（load/save/deleteProfile）。 */
export interface UserDataRepository {
  /** 读取 key 对应 envelope；无数据返回 null（顺带推进 revision baseline）。 */
  load(key: UserDataKey): Promise<UserDataEnvelope | null>
  /** 保存 envelope（自描述含 version）；返回最新 revision。 */
  save(key: UserDataKey, envelope: Record<string, unknown>): Promise<number>
  /** I14-W7：后端原子删除 Profile（fallback/重绑定/activeProfileId 单事务）。 */
  deleteProfile(profileId: string): Promise<ProfileDeleteResult>
  /** 等待全部 per-key 串行链落定（关闭前 flush / 测试收敛）。 */
  flush(): Promise<void>
}

interface KeyQueue {
  /** 最近成功写后的 revision（expected 基准；null = 尚未初始化）。 */
  baseline: number | null
  /** 待写 envelope（尾部合并：在飞/排队期间的最新批次）。 */
  pending: Record<string, unknown> | null
  /** 串行链：同 key 至多一个在飞写，后写等待先写完成。 */
  chain: Promise<void>
  /** 最近一次尚未被成功持久化恢复的写失败；关闭 drain 必须传播。 */
  lastError: unknown | null
}

/** tauri adapter：typed invoke → 后端 SQLite UserDataStore。 */
export function tauriUserDataRepository(): UserDataRepository {
  const queues: Record<UserDataKey, KeyQueue> = {
    profiles: { baseline: null, pending: null, chain: Promise.resolve(), lastError: null },
    sessions: { baseline: null, pending: null, chain: Promise.resolve(), lastError: null },
  }

  const loadImpl = async (key: UserDataKey): Promise<UserDataEnvelope | null> => {
    const { invoke } = await loadInvoke()
    return invoke<UserDataEnvelope | null>('user_data_load', { key }).catch(rejectUserDataError)
  }

  const scheduleSave = (key: UserDataKey, envelope?: Record<string, unknown>): Promise<number> => {
    const queue = queues[key]
    let attemptedPersistence = false
    if (envelope !== undefined) queue.pending = envelope
    const run = queue.chain.then(async (): Promise<number> => {
      const payload = queue.pending
      queue.pending = null
      if (payload === null) return queue.baseline ?? 0
      attemptedPersistence = true
      try {
        const { invoke } = await loadInvoke()
        // 有界重试：user_data_unavailable（service 启动慢/瞬时不可用）→ 退避重试直到
        // 成功。其他错误保持结构化失败，payload 留在 pending 供下一次 flush/mutation
        // 重试，不能依赖“未来也许还会有一次 mutation”。
        let result: UserDataSaveResult | null = null
        let lastError: unknown = null
        for (let attempt = 0; attempt < MAX_SAVE_RETRY; attempt++) {
          if (queue.baseline === null) {
            try {
              const current = await loadImpl(key)
              queue.baseline = current?.revision ?? 0
            } catch (error) {
              if (!isUnavailable(error)) throw error
              lastError = error
              await sleepFor(RETRY_DELAY_MS)
              continue
            }
          }
          try {
            result = await invoke<UserDataSaveResult>('user_data_save', {
              key,
              payload,
              expectedRevision: queue.baseline,
            }).catch(rejectUserDataError)
            break
          } catch (error) {
            if (asUserDataRepositoryError(error).code === 'user_data_revision_conflict') {
              try {
                const current = await loadImpl(key)
                queue.baseline = current?.revision ?? 0
              } catch { /* 刷新失败：保留旧 baseline 与 pending，由 flush 再试 */ }
              throw error
            }
            if (isUnavailable(error)) {
              lastError = error
              await sleepFor(RETRY_DELAY_MS)
              continue
            }
            throw error
          }
        }
        if (result === null) {
          throw lastError ?? new UserDataRepositoryError('user_data_unavailable', '写穿后端失败：重试次数耗尽')
        }
        queue.baseline = result.revision
        return result.revision
      } catch (error) {
        // latest wins：期间若已有更新快照，不得用失败的旧 payload 覆盖；否则恢复本批。
        if (queue.pending === null) queue.pending = payload
        throw error
      }
    })
    // 链本身保持可续，但记录尚未恢复的最后写失败，供关闭 drain 判断 durability。
    queue.chain = run.then(
      () => {
        if (attemptedPersistence) queue.lastError = null
      },
      (error) => {
        queue.lastError = error
      },
    )
    return run
  }

  return {
    async load(key) {
      // I14-W6（CR-002）：load 纳入 per-key 串行链——与在飞 save 串行化，杜绝
      // "load 读到 save 前旧 revision 覆写 baseline"的自致冲突；读回也以链上最新
      // 落库状态为基线。
      const queue = queues[key]
      const run = queue.chain.then(async () => {
        // 权威重读是 recovery boundary：此前失败后保留的全量 pending 可能建立在陈旧
        // localStorage/cache 上，必须先丢弃，否则之后 flush 会把它反向覆盖到 SQLite。
        queue.pending = null
        queue.lastError = null
        const envelope = await loadImpl(key)
        queue.baseline = envelope?.revision ?? 0
        return envelope
      })
      queue.chain = run.then(() => undefined, () => {})
      return run
    },
    async save(key, envelope) {
      return scheduleSave(key, envelope)
    },
    async deleteProfile(profileId) {
      // I14-W7：后端原子删除；返回 fallback + 新 revision（调用方据此重读权威状态）
      const { invoke } = await loadInvoke()
      return invoke<ProfileDeleteResult>('user_profile_delete', { profileId }).catch(rejectUserDataError)
    },
    async flush() {
      // 先等待既有链，再对失败后保留的最新 pending 各重试一次；仍失败才阻止关闭。
      await Promise.all([queues.profiles.chain, queues.sessions.chain])
      const retries = (Object.keys(queues) as UserDataKey[])
        .filter(key => queues[key].pending !== null)
        .map(key => scheduleSave(key))
      if (retries.length > 0) await Promise.allSettled(retries)
      await Promise.all([queues.profiles.chain, queues.sessions.chain])
      const failures = Object.values(queues)
        .map(queue => queue.lastError)
        .filter((error): error is NonNullable<typeof error> => error !== null)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, '多个用户数据分区写穿失败')
      }
    },
  }
}

/** composition root 选择器：Tauri 走后端 versioned user store；否则 null（browser 模式
 * identityStore 直接同步读写 localStorage，不经本仓库）。 */
export function selectUserDataRepository(): UserDataRepository | null {
  return IS_TAURI ? tauriUserDataRepository() : null
}
