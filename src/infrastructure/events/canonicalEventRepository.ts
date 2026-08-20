/**
 * canonicalEventRepository — canonical 事件流 typed repository（A1-c P1）。
 *
 * Tauri 下经 `evt_append` / `evt_revision` / `evt_list` 命令访问 SQLite
 * `canonical_events` 表；browser preview 无后端，不提供 adapter（调用方按
 * IS_TAURI 守卫，本模块不做静默回退）。
 *
 * 后端契约（src-tauri/src/session/mod.rs / event_repo.rs）：
 * - evt_append(events, expected_revision)：owner_key 由后端从 event.owner 推导，
 *   批量必须同 owner；eventId 必须等于 owner_key#sequence；重复 event_id 幂等跳过。
 * - evt_revision(owner_key)：owner 当前 MAX(sequence)，空=0。
 * - evt_list(owner_key, before_sequence, limit)：升序页 + 下一页游标。
 * - 结构化错误 { code, message }：event_revision_conflict / event_repo_corrupt /
 *   event_repo_constraint / event_repo_conflict / event_db_unavailable / event_invalid /
 *   event_session_deleted（DEL-04 tombstone gate，迟到写拒绝）。
 */
import { invoke } from '@tauri-apps/api/core'
import type {
  CanonicalConversationEvent,
  CanonicalEventIdentity,
  CanonicalEventOwner,
  CanonicalEventType,
} from '../../domains/events/eventSchema'

/** evt_append 结果：实际写入事件 + owner 最新 revision。 */
export interface CanonicalEventAppendResult {
  events: unknown[]
  revision: number
}

/**
 * canonical_events 后端回读扁平行（EVT-02 wire，camelCase）：
 * 后端表为扁平列（profile_id/agent_id/local_session_id），`evt_list` 不回嵌套 owner。
 * `normalizeCanonicalEventRow` 负责归一为嵌套 owner 的 canonical 事件。
 */
export interface CanonicalEventWireRow {
  eventId?: string
  ownerKey?: string
  profileId?: string
  agentId?: string
  localSessionId?: string
  remoteSessionId?: string | null
  clientGeneration?: number
  sequence?: number
  occurredAt?: string
  receivedAt?: string
  eventType?: string
  payloadVersion?: number
  identity?: unknown
  typedPayload?: unknown
  rawPayload?: unknown
  createdAt?: number
  owner?: CanonicalEventOwner
}

/** canonical 事件（嵌套 owner；测试与前端内部使用形状）。 */
export type CanonicalEventRow = CanonicalConversationEvent & { createdAt?: number }

/**
 * 后端扁平行 → 嵌套 owner 的 canonical 事件；已是嵌套形状（测试/mock/未来 wire）原样保留。
 * 缺 owner 三元组的行会被归一为 unknown 事件（不抛错，调用方仍可取证）。
 */
export function normalizeCanonicalEventRow(value: unknown): CanonicalEventRow {
  const row = (value ?? {}) as CanonicalEventWireRow
  if (row.owner) {
    return row as unknown as CanonicalEventRow
  }
  const owner: CanonicalEventOwner = {
    profileId: row.profileId ?? '',
    agentId: row.agentId ?? '',
    localSessionId: row.localSessionId ?? '',
    ...(row.remoteSessionId ? { remoteSessionId: row.remoteSessionId } : {}),
  }
  return {
    eventId: row.eventId ?? '',
    owner,
    clientGeneration: row.clientGeneration ?? 0,
    sequence: row.sequence ?? 0,
    occurredAt: row.occurredAt ?? '',
    receivedAt: row.receivedAt ?? '',
    eventType: (row.eventType as CanonicalEventType | undefined) ?? 'unknown',
    payloadVersion: row.payloadVersion ?? 1,
    ...(row.identity !== undefined && row.identity !== null
      ? { identity: row.identity as CanonicalEventIdentity }
      : {}),
    ...(row.typedPayload !== undefined && row.typedPayload !== null
      ? { typedPayload: row.typedPayload }
      : {}),
    rawPayload: row.rawPayload,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
  }
}

/** evt_list 事件页（升序返回；nextBeforeSequence 为下一页游标，null=已到最早）。 */
export interface CanonicalEventPage {
  events: CanonicalEventRow[]
  nextBeforeSequence: number | null
}

export interface CanonicalEventRawExport {
  eventId: string
  ownerKey: string
  sequence: number
  eventType: string
  identityJson: string | null
  typedPayloadJson: string | null
  rawPayloadJson: string
}

/** 事件仓库结构化错误（前端按 code 分支；message 展示用）。 */
export class CanonicalEventRepositoryError extends Error {
  readonly code: string | undefined
  constructor(code: string | undefined, message: string) {
    super(message)
    this.name = 'CanonicalEventRepositoryError'
    this.code = code
  }
}

/** invoke 拒绝值（后端 {code,message}）→ CanonicalEventRepositoryError。 */
export function asCanonicalEventRepositoryError(error: unknown): CanonicalEventRepositoryError {
  if (error instanceof CanonicalEventRepositoryError) return error
  if (error && typeof error === 'object' && 'message' in error) {
    const shape = error as { code?: string; message?: unknown }
    return new CanonicalEventRepositoryError(shape.code, String(shape.message ?? error))
  }
  return new CanonicalEventRepositoryError(undefined, String(error))
}

/** invoke 失败必须以 reject 传播（不把失败变成功）。 */
export function rejectCanonicalEventRepositoryError(error: unknown): never {
  throw asCanonicalEventRepositoryError(error)
}

/** 事件流 repository：append/read（Tauri typed invoke）。 */
export interface CanonicalEventRepository {
  /** 批量 append（单事务、event_id 去重、expected_revision 冲突检测）；返回写入后 revision。 */
  append(events: readonly CanonicalConversationEvent[], expectedRevision: number | null): Promise<number>
  /** owner 当前 revision（MAX(sequence)，空=0）。 */
  revision(ownerKey: string): Promise<number>
  /** 游标分页读取（升序；latest 页 beforeSequence=null）。 */
  list(ownerKey: string, beforeSequence: number | null, limit?: number): Promise<CanonicalEventPage>
  /** 全量读取 owner 事件流（按 sequence 升序）。 */
  loadAll(ownerKey: string): Promise<CanonicalEventRow[]>
  /** 单行取证导出：不解析损坏 JSON，返回数据库中的原始文本。 */
  exportRaw(eventId: string): Promise<CanonicalEventRawExport | null>
  /** B6：跨 owner 内容搜索候选 owner（payload/eventType LIKE）；前端再做消息级过滤。 */
  searchOwners(query: string, limit?: number): Promise<CanonicalEventOwner[]>
}

const DEFAULT_PAGE_LIMIT = 100
const RANGE_PAGE_LIMIT = 1000

/**
 * Read one inclusive forward sequence range through the existing backward cursor.
 * No second cursor/authority is introduced: this is a bounded view over `evt_list`.
 * Missing/corrupt sequence detection is intentionally left to the consuming cursor.
 */
export async function loadCanonicalEventRange(
  repository: Pick<CanonicalEventRepository, 'list'>,
  ownerKey: string,
  afterSequence: number,
  throughSequence: number,
): Promise<CanonicalEventRow[]> {
  if (!Number.isSafeInteger(afterSequence) || !Number.isSafeInteger(throughSequence) || throughSequence <= afterSequence) return []
  const rows: CanonicalEventRow[] = []
  let beforeSequence = throughSequence + 1
  while (beforeSequence > afterSequence + 1) {
    const remaining = beforeSequence - afterSequence - 1
    const page = await repository.list(ownerKey, beforeSequence, Math.min(RANGE_PAGE_LIMIT, remaining))
    const relevant = page.events.filter(event => event.sequence > afterSequence && event.sequence <= throughSequence)
    rows.push(...relevant)
    const earliest = page.events[0]?.sequence
    // A corrupt/non-conforming adapter must not trap recovery in an infinite cursor loop.
    if (earliest === undefined || earliest >= beforeSequence || earliest <= afterSequence + 1) break
    beforeSequence = earliest
  }
  const unique = new Map(rows.map(row => [row.sequence, row]))
  return [...unique.values()].sort((a, b) => a.sequence - b.sequence)
}

export function tauriCanonicalEventRepository(): CanonicalEventRepository {
  const appendImpl = async (
    events: readonly CanonicalConversationEvent[],
    expectedRevision: number | null,
  ): Promise<number> => {
    const result = await invoke<CanonicalEventAppendResult>('evt_append', {
      events: events as unknown[],
      expectedRevision,
    }).catch(rejectCanonicalEventRepositoryError)
    return result.revision
  }
  return {
    append: appendImpl,
    async revision(ownerKey) {
      return invoke<number>('evt_revision', { ownerKey }).catch(rejectCanonicalEventRepositoryError)
    },
    async list(ownerKey, beforeSequence, limit = DEFAULT_PAGE_LIMIT) {
      const page = await invoke<CanonicalEventPage>('evt_list', {
        ownerKey,
        beforeSequence,
        limit,
      }).catch(rejectCanonicalEventRepositoryError)
      return {
        events: page.events.map(normalizeCanonicalEventRow),
        nextBeforeSequence: page.nextBeforeSequence,
      }
    },
    async loadAll(ownerKey) {
      const rows: CanonicalEventRow[] = []
      let beforeSequence: number | null = null
      do {
        const page = await this.list(ownerKey, beforeSequence, 1000)
        rows.push(...page.events)
        beforeSequence = page.nextBeforeSequence
      } while (beforeSequence !== null)
      rows.sort((a, b) => a.sequence - b.sequence)
      return rows
    },
    async exportRaw(eventId) {
      return invoke<CanonicalEventRawExport | null>('evt_export_raw', { eventId })
        .catch(rejectCanonicalEventRepositoryError)
    },
    async searchOwners(query, limit = 50) {
      return invoke<CanonicalEventOwner[]>('evt_search', {
        query,
        limit,
      }).catch(rejectCanonicalEventRepositoryError)
    },
  }
}
