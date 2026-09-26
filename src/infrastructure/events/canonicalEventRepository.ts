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
 * - evt_list(owner_key, before_sequence, limit, cap_typed_payload)：升序页 + 下一页游标。
 *   #376 起读出口对 `typed_payload` 的字符串叶子按 64 KiB 线收口（`cap_typed_payload`
 *   缺省 true）；`turn.unit` 豁免（单元行是历史正文的唯一副本）。
 * - evt_load_compact(owner_key, after_sequence, limit, cap_typed_payload)：compact 读的
 *   **一页**（升序、前向游标；#376-b 起不再一次取回整库）。
 * - 结构化错误 { code, message }：event_revision_conflict / event_repo_corrupt /
 *   event_repo_constraint / event_repo_conflict / event_db_unavailable / event_invalid /
 *   event_session_deleted（DEL-04 tombstone gate，迟到写拒绝）。
 */
import { invoke } from '@tauri-apps/api/core'
import { wireErrorParts } from '../tauri/errorPayload'
import type { CanonicalConversationEvent, CanonicalEventOwner } from '../../domains/events/eventSchema'
import { normalizeCanonicalEventRow, type CanonicalEventRow } from '../../domains/events/canonicalEventRow'
export type { CanonicalEventRow } from '../../domains/events/canonicalEventRow'

/** evt_append 结果：实际写入事件 + owner 最新 revision。 */
export interface CanonicalEventAppendResult {
  events: unknown[]
  revision: number
}

/** evt_list 事件页（升序返回；nextBeforeSequence 为下一页游标，null=已到最早）。 */
export interface CanonicalEventPage {
  events: CanonicalEventRow[]
  nextBeforeSequence: number | null
}

/**
 * #376-b：`evt_load_compact` 的一页（升序；`nextAfterSequence` 为**前向**游标，
 * null = 已到最新）。冷装载按「由旧到新」续折，所以游标方向与 `evt_list` 相反。
 */
export interface CanonicalCompactPage {
  events: CanonicalEventRow[]
  nextAfterSequence: number | null
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

/** #155 T3：独立于 canonical revision 的持久化在途片段。 */
export interface CanonicalDraftFragment {
  ownerKey: string
  draftId: string
  fragmentIndex: number
  clientGeneration: number
  remoteSessionId: string | null
  eventType: 'assistant.text.delta' | 'assistant.thinking.delta'
  identity: Record<string, unknown> | null
  rawPayload: unknown[]
  firstReceivedAt: string
  createdAt: number
  interrupted: boolean
}

export async function loadCanonicalDraftFragments(ownerKey: string): Promise<CanonicalDraftFragment[]> {
  return invoke<CanonicalDraftFragment[]>('evt_draft_list', { ownerKey })
    .catch(rejectCanonicalEventRepositoryError)
}

export async function keepInterruptedDraft(ownerKey: string, draftId: string): Promise<CanonicalEventAppendResult> {
  return invoke<CanonicalEventAppendResult>('evt_draft_keep', { ownerKey, draftId })
    .catch(rejectCanonicalEventRepositoryError)
}

export async function discardInterruptedDraft(ownerKey: string, draftId: string): Promise<boolean> {
  return invoke<boolean>('evt_draft_discard', { ownerKey, draftId })
    .catch(rejectCanonicalEventRepositoryError)
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
  const parts = wireErrorParts(error)
  return new CanonicalEventRepositoryError(parts.code, parts.message)
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
  /** #81 L2：compact 读——「turn.unit 单元 + 未覆盖行」升序（投影/搜索入口；
   * 被单元覆盖的行不传输不解析，读放大随单元粒度下降）。 */
  loadAllPreferUnits(ownerKey: string): Promise<CanonicalEventRow[]>
  /** #376-b：compact 读**分页**（升序、前向游标）。冷装载据此逐页续折，
   * 装载期不再「整库行 + 整库信封 + 文档」三份并存。 */
  listCompact(ownerKey: string, afterSequence: number | null, limit?: number): Promise<CanonicalCompactPage>
  /** 单行取证导出：不解析损坏 JSON，返回数据库中的原始文本。 */
  exportRaw(eventId: string): Promise<CanonicalEventRawExport | null>
  /** B6：跨 owner 内容搜索候选 owner（payload/eventType LIKE）；前端再做消息级过滤。 */
  searchOwners(query: string, limit?: number): Promise<CanonicalEventOwner[]>
}

const DEFAULT_PAGE_LIMIT = 100
const RANGE_PAGE_LIMIT = 1000
/**
 * #376-b：compact 读单页行数。比 `evt_list` 的 1000 小一档——页内行数直接决定一次
 * invoke 的载荷上界（最坏 = 页行数 × 单行 64 KiB），冷装载按页折完即回收，页越小
 * 装载期峰值越低；代价只是多几次 invoke。
 */
const COMPACT_PAGE_LIMIT = 256

/**
 * #376 读出口载荷收口的杀停开关（回滚用，不需要回滚版本）：页面上任意位置出现
 * `data-typed-payload-cap="off"` 即让读出口原样下发 `typed_payload`，回到改动前行为。
 * 沿用 #221 `data-highlight-lifecycle="off"` / #243 `data-row-virtualization="off"`
 * 的先例形态——运维在 devtools 里 `document.body.setAttribute('data-typed-payload-cap','off')`
 * 后触发一次重载即生效。
 *
 * 这里是「全局出现即关」而不是先例的「最近祖先即关」：读出口在挂载任何工作台 DOM
 * 之前就已被调用（冷装载），此时没有可用的祖先链。
 */
export function typedPayloadCapDisabled(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector('[data-typed-payload-cap="off"]') !== null
}

function typedPayloadCapEnabled(): boolean {
  return !typedPayloadCapDisabled()
}

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

/**
 * #81 L1 搭车（双读修复）：会话打开时占位 `loadAll` 之后，权威恢复不再整读第二遍——
 * 以占位行的 max(sequence) 为游标，revision + 前向区间读补差量，结果与全量重读
 * 逐行一致（占位行 ≤ 游标升序 + 差量 > 游标升序）。任何失败回退到全量读，不改变
 * 权威恢复的可用性语义。
 */
export async function loadCanonicalEventsIncremental(
  repository: CanonicalEventRepository,
  ownerKey: string,
  baseRows: readonly CanonicalEventRow[],
): Promise<CanonicalEventRow[]> {
  const baseRevision = baseRows.reduce((max, row) => Math.max(max, row.sequence), 0)
  try {
    const revision = await repository.revision(ownerKey)
    const delta = revision > baseRevision
      ? await loadCanonicalEventRange(repository, ownerKey, baseRevision, revision)
      : []
    return [...baseRows, ...delta]
  } catch {
    return repository.loadAll(ownerKey)
  }
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
        capTypedPayload: typedPayloadCapEnabled(),
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
    async loadAllPreferUnits(ownerKey) {
      const rows: CanonicalEventRow[] = []
      let afterSequence: number | null = null
      do {
        const page = await this.listCompact(ownerKey, afterSequence, COMPACT_PAGE_LIMIT)
        rows.push(...page.events)
        afterSequence = page.nextAfterSequence
      } while (afterSequence !== null)
      return rows
    },
    async listCompact(ownerKey, afterSequence, limit = COMPACT_PAGE_LIMIT) {
      const page = await invoke<CanonicalCompactPage>('evt_load_compact', {
        ownerKey,
        afterSequence,
        limit,
        capTypedPayload: typedPayloadCapEnabled(),
      }).catch(rejectCanonicalEventRepositoryError)
      return {
        events: page.events.map(normalizeCanonicalEventRow),
        nextAfterSequence: page.nextAfterSequence,
      }
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
