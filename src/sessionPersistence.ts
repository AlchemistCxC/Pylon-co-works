import type { PersistedProfile } from './profilePersistence.ts'
import type { Session, Turn } from './identityStore.ts'
import { normalizePluginNamespaceRoot } from './domains/pluginData/pluginNamespace.ts'
import { normalizeSessionCreationSnapshot } from './plugin-runtime/session-creation/compileSessionCreationSnapshot.ts'
import type { SessionCreationSnapshot } from './plugin-runtime/session-creation/sessionCreationTypes.ts'

// H2：DTO 单源——Session 定义在 identityStore（域类型），持久化层引用之；
// PersistedProfile 定义在 profilePersistence。删除逐字节重复的本地声明，
// normalizeSession 的返回类型 = Session 后，新增字段漏归一化即编译期报错。
export type PersistedSession = Session

export const SESSION_SCHEMA_VERSION = 3
export const SESSION_STORAGE_KEY = 'pylon-sessions'
export const LEGACY_SESSION_STORAGE_KEY = 'prism-sessions'

/** v1 遗留会话形状（无 agentId）：迁移时用于 owner 推断；无法唯一确定时进入 needs-owner-resolution */
export interface LegacySession {
  id: string
  periId?: string
  name: string
  source: string
  profileId: string
  createdAt: number
  lastActiveAt: number
  platform: string
  workdir: string
  /** CWD-03：Workspace 实体绑定（可选；legacy 会话无此字段） */
  workspaceId?: string
  sessionPrompt: string
  skills: string[]
  hooks: string[]
  /** M2：启用的 commandSet 插件 id；旧数据缺省。 */
  commandSetPlugins?: string[]
  autoName: string
  metadata?: Record<string, Record<string, unknown>>
  context?: Record<string, Record<string, unknown>>
  creationSnapshot?: SessionCreationSnapshot
}

/**
 * owner 推断提示（ISSUE-01 v1 迁移，强度从强到弱）：
 * 1. 唯一 Agent 下的 periId（经 activeSessionByAgent → session.periId 反查）；
 * 2. workspace agent sheet 对 sessionId 的明确引用（activeSessionByAgent）；
 * 3. 唯一 Agent runtime 中的 source（sourcesByAgent，持久层迁移时通常为空，
 *    由恢复选择流程在运行时补充）。
 */
export interface OwnerHints {
  activeSessionByAgent: Record<string, string | undefined>
  sourcesByAgent?: Record<string, readonly string[]>
}

export type SessionHydrationResult =
  | { kind: 'ready'; sessions: Session[]; turns?: Turn[] }
  | { kind: 'needs-owner-resolution'; sessions: Session[]; unresolved: LegacySession[]; turns?: Turn[] }
  | { kind: 'corrupt'; message: string }

interface SessionEnvelope {
  version: typeof SESSION_SCHEMA_VERSION
  // CR-001：mutation 持久化会把未定 owner 的 legacy 会话（不补 agentId）并入同一 envelope
  // 写盘（persistSessionsWithUnresolved），故元素是 v2 会话与 legacy 形状的并集
  sessions: Array<PersistedSession | LegacySession>
  turns?: Turn[]
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const timestamp = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback

function normalizeLegacySession(value: unknown, profiles: PersistedProfile[]): LegacySession | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id).trim()
  if (!id) return null

  const name = text(raw.name, `session-${id}`).trim() || `session-${id}`
  const validProfileId = text(raw.profileId)
  const profileId = profiles.some(profile => profile.id === validProfileId)
    ? validProfileId
    : (profiles[0]?.id || '')
  const createdAt = timestamp(raw.createdAt)
  const commandSetPlugins = stringList(raw.commandSetPlugins)
  const periId = text(raw.periId) || undefined
  const workspaceId = text(raw.workspaceId) || undefined
  const creationSnapshot = normalizeSessionCreationSnapshot(raw.creationSnapshot)

  return {
    id,
    ...(periId ? { periId } : {}),
    name,
    source: text(raw.source).trim() || `local:${id}`,
    profileId,
    createdAt,
    lastActiveAt: timestamp(raw.lastActiveAt, createdAt),
    platform: text(raw.platform, 'local'),
    workdir: text(raw.workdir),
    ...(workspaceId ? { workspaceId } : {}),
    sessionPrompt: text(raw.sessionPrompt),
    skills: stringList(raw.skills),
    hooks: stringList(raw.hooks),
    // 旧数据缺省 = 不落字段（resolver 按"全部 active"处理）；显式空数组不写回。
    ...(commandSetPlugins.length > 0 ? { commandSetPlugins } : {}),
    autoName: text(raw.autoName),
    ...(raw.metadata !== undefined ? { metadata: normalizePluginNamespaceRoot(raw.metadata) } : {}),
    ...(raw.context !== undefined ? { context: normalizePluginNamespaceRoot(raw.context) } : {}),
    ...(creationSnapshot ? { creationSnapshot } : {}),
  }
}

function normalizeTurn(value: unknown): Turn | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id).trim()
  const sessionId = text(raw.sessionId).trim()
  if (!id || !sessionId) return null
  const startedAt = timestamp(raw.startedAt)
  return {
    id,
    sessionId,
    startedAt,
    ...(typeof raw.endedAt === 'number' && Number.isFinite(raw.endedAt) ? { endedAt: raw.endedAt } : {}),
    metadata: normalizePluginNamespaceRoot(raw.metadata),
    context: normalizePluginNamespaceRoot(raw.context),
  }
}

/** 兼容旧数据：接受裸数组（旧版 sessionInput 曾允许）与 v1/v2 envelope；其余视为损坏 */
function parseEnvelope(value: unknown): { sessions: unknown[]; turns: unknown[] } | null {
  if (Array.isArray(value)) return { sessions: value, turns: [] }
  if (!value || typeof value !== 'object') return null
  const envelope = value as Record<string, unknown>
  if (envelope.version !== 1 && envelope.version !== 2 && envelope.version !== 3) return null
  if (!Array.isArray(envelope.sessions)) return null
  return { sessions: envelope.sessions, turns: Array.isArray(envelope.turns) ? envelope.turns : [] }
}

function buildOwnerResolver(sessions: LegacySession[], hints: OwnerHints): (session: LegacySession) => string | undefined {
  const periIdAgents = new Map<string, Set<string>>()
  const sessionIdAgents = new Map<string, Set<string>>()
  for (const [agentId, activeSessionId] of Object.entries(hints.activeSessionByAgent)) {
    if (!activeSessionId) continue
    const referenced = sessions.find(session => session.id === activeSessionId)
    if (referenced?.periId) {
      let set = periIdAgents.get(referenced.periId)
      if (!set) { set = new Set(); periIdAgents.set(referenced.periId, set) }
      set.add(agentId)
    }
    let sidSet = sessionIdAgents.get(activeSessionId)
    if (!sidSet) { sidSet = new Set(); sessionIdAgents.set(activeSessionId, sidSet) }
    sidSet.add(agentId)
  }

  return (session) => {
    if (session.periId) {
      const agents = periIdAgents.get(session.periId)
      if (agents && agents.size === 1) return [...agents][0]
    }
    const sidAgents = sessionIdAgents.get(session.id)
    if (sidAgents && sidAgents.size === 1) return [...sidAgents][0]
    if (hints.sourcesByAgent) {
      const matches = Object.entries(hints.sourcesByAgent)
        .filter(([, sources]) => sources.includes(session.source))
        .map(([agentId]) => agentId)
      if (matches.length === 1) return matches[0]
    }
    return undefined
  }
}

export function normalizeSessions(value: unknown, profiles: PersistedProfile[], hints?: OwnerHints): SessionHydrationResult {
  const parsed = parseEnvelope(value)
  if (!parsed) return { kind: 'corrupt', message: '会话数据无法解析：未知 envelope' }

  const seen = new Set<string>()
  const turns = parsed.turns.map(normalizeTurn).filter((turn): turn is Turn => turn !== null)
  const normalized: Array<LegacySession & { agentId?: string }> = []
  for (const raw of parsed.sessions) {
    const session = normalizeLegacySession(raw, profiles)
    if (!session || seen.has(session.id)) continue
    seen.add(session.id)
    const rawRecord = raw as Record<string, unknown>
    const agentId = text(rawRecord.agentId).trim() || undefined
    normalized.push({ ...session, agentId })
  }

  const resolver = buildOwnerResolver(normalized, hints ?? { activeSessionByAgent: {} })
  const resolved: Session[] = []
  const unresolved: LegacySession[] = []
  for (const session of normalized) {
    if (session.agentId) {
      resolved.push({ ...session, agentId: session.agentId, metadata: session.metadata ?? {}, context: session.context ?? {} })
    } else {
      const owner = resolver(session)
      if (owner) resolved.push({ ...session, agentId: owner, metadata: session.metadata ?? {}, context: session.context ?? {} })
      else {
        const { agentId: _agentId, ...legacy } = session
        unresolved.push(legacy)
      }
    }
  }

  const withTurns = turns.length > 0 ? { turns } : {}
  if (unresolved.length > 0) return { kind: 'needs-owner-resolution', sessions: resolved, unresolved, ...withTurns }
  return { kind: 'ready', sessions: resolved, ...withTurns }
}

function parseStoredSessions(raw: string | null, profiles: PersistedProfile[], hints: OwnerHints): SessionHydrationResult | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parseEnvelope(parsed) ? normalizeSessions(parsed, profiles, hints) : { kind: 'corrupt', message: '会话数据损坏：未知 envelope' }
  } catch {
    return { kind: 'corrupt', message: '会话数据损坏：JSON 解析失败' }
  }
}

export function serializeSessions(sessions: Array<PersistedSession | LegacySession>, turns: Turn[] = []): string {
  const envelope: SessionEnvelope = { version: SESSION_SCHEMA_VERSION, sessions, ...(turns.length > 0 ? { turns } : {}) }
  return JSON.stringify(envelope)
}

export function parseSessions(raw: string | null, profiles: PersistedProfile[], hints?: OwnerHints): SessionHydrationResult {
  return parseStoredSessions(raw, profiles, hints ?? { activeSessionByAgent: {} }) ?? { kind: 'ready', sessions: [] }
}

export function persistSessions(storage: StorageLike, sessions: PersistedSession[], turns: Turn[] = []): boolean {
  try {
    storage.setItem(SESSION_STORAGE_KEY, serializeSessions(sessions, turns))
    return true
  } catch {
    // 存储不可用/写满：写盘失败不应让 identityStore action 抛异常；
    // 返回 false 供调用方把"未保存"提升为可见状态（报告 1C L1）
    return false
  }
}

/**
 * CR-001：mutation 持久化保留 unresolved 现场——把尚未定 owner 的 legacy 会话
 * （原样、不补 agentId）与已解析会话并入同一 v2 envelope 写盘，避免用 resolved 子集
 * 覆盖存储而永久丢失未决数据。下次 loadSessions 重新推断/归类（幂等，无副作用）。
 */
export function persistSessionsWithUnresolved(
  storage: StorageLike,
  sessions: PersistedSession[],
  unresolved: readonly LegacySession[],
  turns: Turn[] = [],
): boolean {
  try {
    storage.setItem(SESSION_STORAGE_KEY, serializeSessions([...sessions, ...unresolved], turns))
    return true
  } catch {
    return false
  }
}

/**
 * 加载会话并迁移：
 * - ready：迁移写回 v2（含推断出的 agentId）；
 * - needs-owner-resolution：不写回——保留原始数据，等待恢复选择流程显式定 owner；
 * - corrupt：不写回，保留现场供诊断。
 */
export function loadSessions(storage: StorageLike, profiles: PersistedProfile[], hints?: OwnerHints): SessionHydrationResult {
  const ownerHints = hints ?? { activeSessionByAgent: {} }
  const currentRaw = storage.getItem(SESSION_STORAGE_KEY)
  const current = parseStoredSessions(currentRaw, profiles, ownerHints)
  // 新 key 有可用数据（ready / needs-owner-resolution）时以它为准；损坏结果不视为权威
  if (current && current.kind !== 'corrupt') {
    if (current.kind === 'ready' && current.sessions.length > 0) persistSessions(storage, current.sessions, current.turns ?? [])
    return current
  }

  // 新 key 缺失或损坏：回退旧 key 迁移（旧 key 也 ready 时迁移结果覆盖已损坏数据，
  // 否则保留现场等待恢复选择/诊断）
  const legacyRaw = storage.getItem(LEGACY_SESSION_STORAGE_KEY)
  const legacy = parseStoredSessions(legacyRaw, profiles, ownerHints)
  if (!legacy) return current ?? { kind: 'ready', sessions: [] }
  if (legacy.kind === 'ready') {
    persistSessions(storage, legacy.sessions, legacy.turns ?? [])
    storage.removeItem(LEGACY_SESSION_STORAGE_KEY)
  }
  return legacy
}
