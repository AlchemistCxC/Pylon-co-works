/**
 * OBS-04：P2 三源导出取证工具（方案书任务表 OBS-04，§11 完成判据 #5）。
 *
 * 目的：对同一会话导出 ACP replay / SQLite / localStorage 三份原始数据，供 P2
 * （会话 Replay 与工具渲染损坏，方案书 §1.3）定位"具体由哪一层触发损坏"。
 *
 * 纪律（方案书 §2 阶段 M0）：
 * - 只读取证：不修改任何业务语义；三源全部经只读路径采集。
 * - 隔离生产路径：本模块仅由 DEV 钩子挂载（devTrigger.ts，import.meta.env.DEV 守卫，
 *   生产构建 tree-shake）；不接入任何生产 UI。
 * - 脱敏导出：镜像 Rust `sanitize.rs` 的 Strip 语义——敏感 key（rawInput/rawOutput/
 *   prompt/persona/headers/env/authorization/password/cookie/credential，以及含
 *   token/apikey/api_key/secret 的键名）整体剔除；字符串值含 secret 形态（分隔符变体 /
 *   sk-、ghp_、xoxb-、akia、eyj 前缀）整体 [REDACTED]。保留工具身份字段（toolCallId/
 *   title/kind/status/tool name）作为 P2 证据；聊天正文保留（仅 secret 形态值被
 *   REDACTED）。
 *
 * 三源 join 键（explorer 调查确认）：
 *   localStorage：`pylon-msgs-<Session.id>`（v1 envelope，兼容旧裸数组）。
 *     A1-c 后 Tauri 下该快照已废弃（旧 key 清理），此段仅保留为 legacy evidence。
 *   SQLite      ：`canonical_events.owner_key`（经 evt_list/evt_revision；ownerKey 用
 *     identity 的 profileId/agentId/source 经 toCanonicalOwnerKey 构造）
 *   ACP replay  ：source='local:'+Session.id + periId（经 load_persisted_session 重拉）
 *
 * 排序键对照（三源逐消息对账依据）：
 *   localStorage = 数组下标（array-index）
 *   SQLite       = sequence（canonical event sequence，owner 维单调递增）
 *   replay       = arrivalSeq（canonicalNormalizer 的 sequence = index+1）
 */

import { messageStorageKey, parseMessageSnapshot } from '../components/chat/messagePersistence.ts'
import type { Message } from '../components/chat/messageTypes.ts'
import { readChatReplayTrace } from '../components/chat/chatReplayTrace.ts'
import { normalizeRawEvent, type CanonicalNormalizeResult } from '../domains/events/canonicalNormalizer.ts'
import { toCanonicalOwnerKey } from '../domains/events/eventSchema.ts'
import type { CanonicalEventPage, CanonicalEventRow } from '../infrastructure/events/canonicalEventRepository.ts'
import type { ExportSource } from '../contracts/exportSource.ts'
import { getPluginServiceRegistry } from '../plugin-runtime/runtimeServices.ts'

export function listExportSources(): ExportSource[] {
  return getPluginServiceRegistry().list<ExportSource>('export')
}

function resolveExportSource(sourceName: ExportSource['sourceName']): ExportSource | undefined {
  return listExportSources().find(source => source.sourceName === sourceName)
}

// ============================================================================
// 脱敏（镜像 src-tauri/src/sanitize.rs：is_export_sensitive_key + sanitize_value_content）
// ============================================================================

const REDACTED = '[REDACTED]'

/** 镜像 Rust is_export_sensitive_key：命中即整个 key 剔除（Strip 策略）。 */
export function isSensitiveExportKey(key: string): boolean {
  const lower = key.toLowerCase()
  if (
    lower === 'rawinput' || lower === 'rawoutput' || lower === 'prompt' || lower === 'persona'
    || lower === 'headers' || lower === 'env' || lower === 'authorization' || lower === 'password'
    || lower === 'cookie' || lower === 'credential' || lower === 'tokenvalue'
  ) return true
  return lower.endsWith('token') || lower.endsWith('apikey') || lower.endsWith('api_key') || lower.includes('secret')
}

const SENSITIVE_KEY_PATTERN = /(?:password|secret|token|api_key|apikey|authorization|client_secret|access_token|x-api-key|prompt|persona)\s*[:=："＝"]|bearer\s/
const BARE_SECRET_PATTERN = /(^|[^a-z0-9])(sk-|ghp_|xoxb-|akia|eyj)/

/** 镜像 Rust sanitize_value_content：值含 secret 形态整体 REDACTED。 */
export function containsSensitiveValue(value: string): boolean {
  const lower = value.toLowerCase()
  return SENSITIVE_KEY_PATTERN.test(lower) || BARE_SECRET_PATTERN.test(lower)
}

/**
 * 绝对路径形态（盘符 / UNC / 根相对）→ 收窄为 `…/目录名`，避免全路径外泄；
 * 非绝对路径原样保留。与交接声明"不输出绝对路径"对齐。
 */
export function redactAbsolutePath(path: string): string {
  if (path.includes('\0')) return REDACTED
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\')
  if (!isAbsolute) return path
  const trimmed = path.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]+/).filter(Boolean)
  const last = segments[segments.length - 1]
  return last ? `…/${last}` : REDACTED
}

/**
 * 工件级 identity 脱敏（CR-001 闭环）：先过 sanitizeExportValue（secret 形态值整值
 * REDACTED + 敏感 key 剔除），再对绝对路径形态 workdir 收窄为 `…/目录名`。
 */
export function sanitizeIdentityExport(identity: SessionIdentityExport): SessionIdentityExport {
  const sanitized = sanitizeExportValue(identity) as Partial<SessionIdentityExport>
  if (typeof sanitized.workdir === 'string') sanitized.workdir = redactAbsolutePath(sanitized.workdir)
  return sanitized as SessionIdentityExport
}

/**
 * 递归脱敏（Strip 策略 + 值内容 REDACTED）。深拷贝；命中敏感 key 的键值对整个剔除。
 * 非敏感子树递归；字符串值经值内容检测。
 */
export function sanitizeExportValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return containsSensitiveValue(value) ? REDACTED : value
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeExportValue)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveExportKey(key)) continue
      out[key] = sanitizeExportValue(child)
    }
    return out
  }
  return value
}

// ============================================================================
// 工件类型（artifact wire 形状）
// ============================================================================

export interface SessionIdentityExport {
  id: string
  name?: string
  agentId?: string
  profileId?: string
  source?: string
  periId?: string | null
  workdir?: string
  sessionPrompt?: string
  autoName?: string
  platform?: string
  createdAt?: number
  lastActiveAt?: number
}

export interface LocalStorageSection {
  messageKey: string
  snapshotPresent: boolean
  /** v1 envelope 的 version；旧裸数组为 null。 */
  envelopeVersion: number | null
  /** 原始快照（envelope 或裸数组）逐字节 parse 保留，脱敏后用于现场对比。 */
  rawSnapshot: unknown
  messages: Message[] | null
  messageCount: number
  corrupt: boolean
  parseError: string | null
  /** replay trace JSONL 摘要（只含 ids/hash/长度，无正文）。 */
  traceLines: number
}

export interface SqliteSection {
  sessionId: string
  revision: number
  rows: CanonicalEventRow[]
  rowCount: number
  pages: number
  truncated: boolean
}

export interface ReplaySection {
  source: string | null
  periId: string | null
  loadOk: boolean
  loadError: string | null
  response: unknown
  envelopeCount: number
  envelopes: unknown[]
  likelyTruncated: boolean
  normalized: {
    total: number
    malformed: number
    noIdentity: number
    byKind: Record<string, number>
    warnings: string[]
  } | null
}

export interface ThreeSourceArtifact {
  tool: 'obs04-three-source-export'
  schemaVersion: 1
  exportedAt: number
  sessionId: string
  identity: SessionIdentityExport | null
  sources: {
    localStorage: LocalStorageSection
    sqlite: SqliteSection
    replay: ReplaySection
  }
  ordering: {
    localStorage: 'array-index'
    sqlite: 'sequence'
    replay: 'arrivalSeq'
  }
  summary: {
    messageCounts: { localStorage: number; sqlite: number; replay: number }
    truncated: { localStorage: boolean; sqlite: boolean; replay: boolean }
    gaps: string[]
  }
}

// ============================================================================
// 采集函数（依赖注入，便于单测）
// ============================================================================

export interface Obs04Transport {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
}

export interface StorageLike {
  getItem(key: string): string | null
}

const MAX_SQLITE_PAGES = 200
const SQLITE_PAGE_SIZE = 500
const REPLAY_TRUNCATION_LIMIT = 10_000

/** 证据源 localStorage（A1-c 后为 legacy evidence：Tauri 下不再产生，缺省 absent）。 */
export function collectLocalStorageSection(sessionId: string, storage: StorageLike): LocalStorageSection {
  const messageKey = messageStorageKey(sessionId)
  let raw: string | null
  try {
    raw = storage.getItem(messageKey)
  } catch (error) {
    return {
      messageKey,
      snapshotPresent: false,
      envelopeVersion: null,
      rawSnapshot: null,
      messages: null,
      messageCount: 0,
      corrupt: true,
      parseError: `storage read failed: ${String(error)}`,
      traceLines: 0,
    }
  }
  let rawSnapshot: unknown = null
  let envelopeVersion: number | null = null
  let corrupt = false
  let parseError: string | null = null
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      rawSnapshot = parsed
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const envelope = parsed as { version?: unknown }
        if (typeof envelope.version === 'number') envelopeVersion = envelope.version
      }
    } catch (error) {
      corrupt = true
      parseError = `json parse failed: ${String(error)}`
      rawSnapshot = raw // 原文保留（不可 parse 时也留现场）
    }
  }
  const messages = parseMessageSnapshot<Message>(raw)
  let traceLines: number
  try {
    traceLines = readChatReplayTrace().length
  } catch {
    traceLines = -1 // 读取 trace 失败单独标注，不污染快照结果
  }
  return {
    messageKey,
    snapshotPresent: raw !== null,
    envelopeVersion,
    rawSnapshot: sanitizeExportValue(rawSnapshot),
    messages: messages ? sanitizeExportValue(messages) as Message[] : null,
    messageCount: messages?.length ?? 0,
    corrupt,
    parseError,
    traceLines,
  }
}

/** 证据源 SQLite（canonical_events）：evt_list 游标分页全量镜像 + evt_revision；行内内容脱敏。 */
export async function collectSqliteSection(input: {
  sessionId: string
  ownerKey: string
  transport: Obs04Transport
}): Promise<SqliteSection> {
  const { sessionId, ownerKey, transport } = input
  const rows: CanonicalEventRow[] = []
  let beforeSequence: number | null = null
  let pages = 0
  let truncated = false
  do {
    const page = await transport.invoke('evt_list', { ownerKey, beforeSequence, limit: SQLITE_PAGE_SIZE }) as CanonicalEventPage
    rows.push(...(page?.events ?? []))
    beforeSequence = page?.nextBeforeSequence ?? null
    pages += 1
    if (pages >= MAX_SQLITE_PAGES && beforeSequence !== null) {
      truncated = true
      break
    }
  } while (beforeSequence !== null)
  // 页间从新到旧，全量按 sequence 升序 = UI 时间序（与 canonicalEventRepository.loadAll 一致）。
  rows.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  let revision: number
  try {
    revision = Number(await transport.invoke('evt_revision', { ownerKey })) || 0
  } catch {
    revision = -1
  }
  return {
    sessionId,
    revision,
    rows: sanitizeExportValue(rows) as CanonicalEventRow[],
    rowCount: rows.length,
    pages,
    truncated,
  }
}

/** canonical eventType → 旧取证工件 kind 词汇（保持 OBS-04 工件 schema 语义稳定）。 */
function legacyKindFor(normalized: CanonicalNormalizeResult): string {
  switch (normalized.event.eventType) {
    case 'user.message': return 'user'
    case 'assistant.text.delta': return 'assistant-text'
    case 'assistant.thinking.delta': return 'assistant-thinking'
    case 'tool.call.started': return 'tool-call'
    case 'tool.call.updated':
    case 'tool.call.completed':
    case 'tool.call.failed': return 'tool-update'
    case 'turn.completed': return 'done'
    case 'turn.failed': return 'error'
    case 'unknown':
      // wire-only 类型（canonical 归 unknown）仍按原始 sessionUpdate 分类，
      // 保留旧工件的 usage/plan 计数语义。
      if (normalized.sessionUpdate === 'usage_update') return 'usage'
      if (normalized.sessionUpdate === 'plan') return 'plan'
      return 'unknown'
    default: return 'unknown'
  }
}

const TOOL_EVENT_TYPES = new Set(['tool.call.started', 'tool.call.updated', 'tool.call.completed', 'tool.call.failed'])
const TEXT_EVENT_TYPES = new Set(['user.message', 'assistant.text.delta', 'assistant.thinking.delta'])

/** 旧工件 malformed 语义：canonical 的 envelope 级 malformed + 工具缺 toolCallId / 文本缺 text。 */
function replayEntryMalformed(normalized: CanonicalNormalizeResult): boolean {
  if (normalized.malformed) return true
  const { event } = normalized
  if (TOOL_EVENT_TYPES.has(event.eventType)) return event.identity?.toolCallId === undefined
  if (TEXT_EVENT_TYPES.has(event.eventType)) {
    return typeof (event.typedPayload as { text?: string } | undefined)?.text !== 'string'
  }
  return false
}

function replayEntryWarning(normalized: CanonicalNormalizeResult, malformed: boolean): string | undefined {
  if (normalized.warning) return normalized.warning
  if (!malformed) return undefined
  const { event } = normalized
  if (TOOL_EVENT_TYPES.has(event.eventType)) return `${String(normalized.sessionUpdate)} 缺少 toolCallId`
  if (TEXT_EVENT_TYPES.has(event.eventType)) return `${String(normalized.sessionUpdate)} 缺少文本`
  return undefined
}

function replayKindCounts(normalized: CanonicalNormalizeResult[]): { byKind: Record<string, number>; malformed: number; noIdentity: number; warnings: string[] } {
  const byKind: Record<string, number> = {}
  let malformed = 0
  let noIdentity = 0
  const warnings: string[] = []
  for (const entry of normalized) {
    const kind = legacyKindFor(entry)
    byKind[kind] = (byKind[kind] ?? 0) + 1
    const entryMalformed = replayEntryMalformed(entry)
    if (entryMalformed) malformed += 1
    if (!entry.event.identity) noIdentity += 1
    const warning = replayEntryWarning(entry, entryMalformed)
    if (warning && warnings.length < 20) warnings.push(`${entry.event.sequence}: ${warning}`)
  }
  return { byKind, malformed, noIdentity, warnings }
}

/** 证据源 ACP replay：load_persisted_session 重拉原始 envelope + canonical normalizer 归一摘要。 */
export async function collectReplaySection(
  identity: { source?: string | null; periId?: string | null; cwd?: string | null; agentId?: string | null; profileId?: string | null },
  transport: Obs04Transport,
): Promise<ReplaySection> {
  const source = identity.source ?? null
  const periId = identity.periId ?? null
  if (!periId) {
    return {
      source,
      periId: null,
      loadOk: false,
      loadError: 'no periId — ACP replay 需 periId（会话未建立远端 session）',
      response: null,
      envelopeCount: 0,
      envelopes: [],
      likelyTruncated: false,
      normalized: null,
    }
  }
  const args: Record<string, unknown> = { periId }
  // load_persisted_session 需完整 durable owner；legacy identity 缺任一维时不猜测，
  // 后端拒绝缺少 owner，取证工件如实记录 load 失败（不冒充成功）。
  if (identity.agentId && identity.profileId && source) {
    args.owner = { profileId: identity.profileId, agentId: identity.agentId, localSessionId: source }
  }
  if (identity.cwd) args.cwd = identity.cwd
  try {
    const result = await transport.invoke('load_persisted_session', args) as { response?: unknown; replay?: unknown } | null
    const replay = result?.replay
    const envelopes = Array.isArray(replay) ? replay : []
    const normalized = envelopes.map((raw, index) => normalizeRawEvent(raw, {
      owner: {
        profileId: identity.profileId ?? '',
        agentId: identity.agentId ?? '',
        localSessionId: source ?? '',
      },
      clientGeneration: 0,
      sequence: index + 1,
      receivedAt: new Date().toISOString(),
    }))
    const { byKind, malformed, noIdentity, warnings } = replayKindCounts(normalized)
    return {
      source,
      periId,
      loadOk: true,
      loadError: null,
      response: sanitizeExportValue(result?.response ?? null),
      envelopeCount: envelopes.length,
      envelopes: sanitizeExportValue(envelopes) as unknown[],
      likelyTruncated: envelopes.length >= REPLAY_TRUNCATION_LIMIT,
      normalized: {
        total: normalized.length,
        malformed,
        noIdentity,
        byKind,
        warnings,
      },
    }
  } catch (error) {
    return {
      source,
      periId,
      loadOk: false,
      loadError: String(error),
      response: null,
      envelopeCount: 0,
      envelopes: [],
      likelyTruncated: false,
      normalized: null,
    }
  }
}

/** 身份解析：pylon-sessions v2 envelope（或裸数组/旧版）按 id 定位；失败返回 null。 */
export function resolveSessionIdentity(sessionId: string, storage: StorageLike): SessionIdentityExport | null {
  let raw: string | null
  try {
    raw = storage.getItem('pylon-sessions')
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : null
  if (!list) return null
  const match = list.find((item): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && (item as { id?: unknown }).id === sessionId,
  )
  if (!match) return null
  const text = (value: unknown, fallback?: string) => typeof value === 'string' ? value : fallback
  const num = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    id: sessionId,
    name: text(match.name),
    agentId: text(match.agentId),
    profileId: text(match.profileId),
    source: text(match.source, `local:${sessionId}`),
    periId: text(match.periId) ?? null,
    workdir: text(match.workdir),
    sessionPrompt: text(match.sessionPrompt),
    autoName: text(match.autoName),
    platform: text(match.platform),
    createdAt: num(match.createdAt, 0),
    lastActiveAt: num(match.lastActiveAt, 0),
  }
}

/** 组装三源工件：排序键对照 + 摘要 + 缺口登记。 */
export function buildThreeSourceArtifact(input: {
  sessionId: string
  identity: SessionIdentityExport | null
  localStorage: LocalStorageSection
  sqlite: SqliteSection
  replay: ReplaySection
}): ThreeSourceArtifact {
  const { sessionId, identity, localStorage, sqlite, replay } = input
  const gaps: string[] = []
  // A1-c：Tauri 下 localStorage 快照已废弃，缺省 absent 是预期，不再登记缺口。
  if (localStorage.corrupt) gaps.push('localStorage: legacy 快照损坏（原文保留）')
  if (identity && (!identity.profileId || !identity.agentId || !identity.source)) {
    gaps.push('sqlite: identity 缺少 profileId/agentId/source，无法构造 canonical ownerKey')
  }
  if (sqlite.revision < 0) gaps.push('sqlite: evt_revision 读取失败')
  if (sqlite.rowCount === 0 && sqlite.revision >= 0 && localStorage.messageCount > 0) {
    gaps.push(`sqlite: 无 canonical 事件但 localStorage 有 ${localStorage.messageCount} 条（三源不一致）`)
  }
  if (sqlite.truncated) gaps.push('sqlite: 分页到达硬上限，镜像可能截断')
  if (replay.periId === null) gaps.push('replay: 会话无 periId，无法重拉 ACP replay')
  if (replay.loadOk === false && replay.periId !== null) gaps.push(`replay: load_persisted_session 失败（${replay.loadError}）`)
  if (replay.likelyTruncated) gaps.push('replay: envelope 数达到 Rust 收集上限（10k），可能截断')
  return {
    tool: 'obs04-three-source-export',
    schemaVersion: 1,
    exportedAt: Date.now(),
    sessionId,
    identity: identity ? sanitizeIdentityExport(identity) : identity,
    sources: { localStorage, sqlite, replay },
    ordering: { localStorage: 'array-index', sqlite: 'sequence', replay: 'arrivalSeq' },
    summary: {
      messageCounts: {
        localStorage: localStorage.messageCount,
        sqlite: sqlite.rowCount,
        replay: replay.envelopeCount,
      },
      truncated: {
        localStorage: false,
        sqlite: sqlite.truncated,
        replay: replay.likelyTruncated,
      },
      gaps,
    },
  }
}

async function collectLocalStorageViaRegistry(sessionId: string, storage: StorageLike): Promise<LocalStorageSection> {
  const source = resolveExportSource('localStorage')
  if (!source) return collectLocalStorageSection(sessionId, storage)
  return await source.collect({ sessionId, storage }) as LocalStorageSection
}

async function collectSqliteViaRegistry(input: { sessionId: string; ownerKey: string; transport: Obs04Transport }): Promise<SqliteSection> {
  const source = resolveExportSource('sqlite')
  if (!source) return collectSqliteSection(input)
  return await source.collect(input) as SqliteSection
}

async function collectReplayViaRegistry(input: {
  identity: { source?: string | null; periId?: string | null; cwd?: string | null; agentId?: string | null; profileId?: string | null }
  transport: Obs04Transport
}): Promise<ReplaySection> {
  const source = resolveExportSource('replay')
  if (!source) return collectReplaySection(input.identity, input.transport)
  return await source.collect(input) as ReplaySection
}

/** 编排：身份解析 → 三源采集 → 组装。任一路失败不影响其他源（各源自带失败态）。 */
export async function exportThreeSourcesForSession(input: {
  sessionId: string
  transport: Obs04Transport
  storage?: StorageLike
  identity?: SessionIdentityExport | null
  cwd?: string | null
  agentId?: string | null
}): Promise<ThreeSourceArtifact> {
  const storage = input.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!storage) throw new Error('three-source export requires a storage backend')
  const identity = input.identity !== undefined
    ? input.identity
    : resolveSessionIdentity(input.sessionId, storage)
  const sqliteSectionPromise = (() => {
    if (identity?.profileId && identity?.agentId && identity?.source) {
      const ownerKey = toCanonicalOwnerKey({
        profileId: identity.profileId,
        agentId: identity.agentId,
        localSessionId: identity.source,
      })
      return collectSqliteViaRegistry({ sessionId: input.sessionId, ownerKey, transport: input.transport })
    }
    // identity 缺失（无 profileId/agentId/source）无法构造 canonical ownerKey：
    // 置 revision=-1，由 build 登记缺口，不尝试无意义 evt_* 调用。
    return Promise.resolve<SqliteSection>({
      sessionId: input.sessionId,
      revision: -1,
      rows: [],
      rowCount: 0,
      pages: 0,
      truncated: false,
    })
  })()
  const [localStorageSection, sqliteSection, replaySection] = await Promise.all([
    collectLocalStorageViaRegistry(input.sessionId, storage),
    sqliteSectionPromise,
    collectReplayViaRegistry({
      identity: {
        source: identity?.source ?? `local:${input.sessionId}`,
        periId: identity?.periId ?? null,
        cwd: input.cwd ?? identity?.workdir ?? null,
        agentId: input.agentId ?? identity?.agentId ?? null,
        profileId: identity?.profileId ?? null,
      },
      transport: input.transport,
    }),
  ])
  return buildThreeSourceArtifact({
    sessionId: input.sessionId,
    identity,
    localStorage: localStorageSection,
    sqlite: sqliteSection,
    replay: replaySection,
  })
}

/** 浏览器端下载工件（仅 Tauri/浏览器运行时可调用；非浏览器环境 no-op）。 */
export function downloadThreeSourceArtifact(artifact: ThreeSourceArtifact): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `pylon-three-source-${artifact.sessionId}-${Date.now()}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
