/**
 * C08：Todo / Plan / Goal 统一语义模型（纯 domain，无 IO/store/framework import）。
 *
 * - Todo/Plan 共用 PlanEntryV2：五状态 pending/in-progress/completed/cancelled/blocked；
 *   cancelled 不坍缩为 completed（总纲 4.4：Hermes ACP 会压状态，Pylon 端必须无损保留）。
 * - Goal 独立建模：objective/tokenBudget/blockedReason/tokensUsed 是 goal 一等字段，
 *   不是 todo 装饰。
 * - 未知 provider 状态映射 unknown + rawStatus；未知 goal 字段进 metadata，不静默丢弃
 *   （K14：unknown/raw 必须保留并可见）。
 */

export const PLAN_ENTRY_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled', 'blocked'] as const
export type PlanEntryStatus = (typeof PLAN_ENTRY_STATUSES)[number]

export const GOAL_STATUSES = ['active', 'complete', 'blocked'] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number] | 'unknown'

export interface PlanEntryV2 {
  /** stable item id：显式 id > itemId > content 兜底；patch/reorder 的定位键 */
  readonly id: string
  readonly content: string
  readonly status: PlanEntryStatus | 'unknown'
  readonly activeForm?: string
  readonly priority?: string | number
  readonly blockedReason?: string
  /** provider 原始状态拼写（status 无法收窄时必填；可收窄时保留变体拼写） */
  readonly rawStatus?: string
  /** 已知/未来 provider 字段；不得因结构化收窄而静默丢弃 */
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface GoalAccounting {
  readonly tokensUsed?: number
  readonly timeUsedSeconds?: number
  /** provider-neutral accounting 扩展字段 */
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface GoalSnapshot {
  readonly goalId?: string
  readonly objective?: string
  readonly status: GoalStatus
  readonly tokenBudget?: number
  readonly tokensUsed?: number
  readonly blockedReason?: string
  /** 预算/时间消耗的结构化 accounting；未知 accounting 字段进入 metadata */
  readonly accounting?: GoalAccounting
  /** 未知字段聚合处；保证未来字段可见而非丢弃 */
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface PlanState {
  readonly sessionId: string
  readonly revision: number
  readonly entries: readonly PlanEntryV2[]
}

export function createEmptyPlanState(sessionId: string): PlanState {
  return { sessionId, revision: 0, entries: [] }
}

export interface GoalState {
  readonly current?: GoalSnapshot
}

export interface PlanContentPayload {
  readonly entries: readonly PlanEntryV2[]
  readonly goal?: GoalSnapshot
}

export function createEmptyGoalState(): GoalState {
  return {}
}

export interface PlanEventInput {
  readonly type: 'plan.replaced' | 'plan.entry-updated'
  readonly entries?: readonly unknown[]
  readonly entry?: unknown
}

export interface GoalEventInput {
  readonly type: 'goal.updated' | 'goal.cleared'
  readonly goal?: unknown
  readonly goalId?: string
}

const STATUS_ALIASES: Readonly<Record<string, PlanEntryStatus>> = {
  pending: 'pending',
  todo: 'pending',
  queued: 'pending',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  'in-progress': 'in_progress',
  running: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  killed: 'cancelled',
  abandoned: 'cancelled',
  blocked: 'blocked',
}

const KNOWN_GOAL_STATUSES = new Set<string>(GOAL_STATUSES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** provider 状态 → 五状态；未知拼写保留原文进 rawStatus。已归一化的 unknown 输入若自带 rawStatus 则原样保留 */
export function normalizePlanStatus(rawStatus: unknown): { status: PlanEntryStatus | 'unknown'; rawStatus?: string } {
  if (typeof rawStatus !== 'string' || !rawStatus.trim()) return { status: 'pending' }
  const trimmed = rawStatus.trim()
  if (trimmed === 'unknown') return { status: 'unknown' }
  const normalized = STATUS_ALIASES[trimmed.toLowerCase()]
  if (normalized) return normalized === trimmed ? { status: normalized } : { status: normalized, rawStatus }
  return { status: 'unknown', rawStatus: trimmed }
}

/**
 * wire entries → PlanEntryV2[]。id 缺失时按 content 派生稳定身份；
 * 已归一化的 unknown 条目（status='unknown'+rawStatus）回读时保留 rawStatus。
 * 非 object 条目与缺 content 条目按契约丢弃（与 P1-01 normalizePlanEntries 行为一致）。
 */
export function normalizePlanEntries(raw: unknown): readonly PlanEntryV2[] {
  if (!Array.isArray(raw)) return []
  const entries: PlanEntryV2[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const content = text(item.content) ?? text(item.title) ?? text(item.text)
    if (!content) continue
    const id = text(item.id) ?? text(item.itemId) ?? content
    const rawStatus = typeof item.rawStatus === 'string' && item.status === 'unknown' ? item.rawStatus : undefined
    const statusInfo = normalizePlanStatus(item.status)
    const knownKeys = new Set(['id', 'itemId', 'content', 'title', 'text', 'status', 'rawStatus', 'activeForm', 'priority', 'blockedReason', 'blocked_reason', 'metadata'])
    const metadata: Record<string, unknown> = isRecord(item.metadata) ? { ...item.metadata } : {}
    if (item.metadata !== undefined && !isRecord(item.metadata)) metadata.metadata = item.metadata
    for (const [key, value] of Object.entries(item)) {
      if (!knownKeys.has(key) && value !== undefined) metadata[key] = value
    }
    const entry: PlanEntryV2 = {
      id,
      content,
      status: statusInfo.status,
      ...(statusInfo.rawStatus !== undefined ? { rawStatus: statusInfo.rawStatus } : rawStatus !== undefined ? { rawStatus } : {}),
      ...(text(item.activeForm) !== undefined ? { activeForm: text(item.activeForm) } : {}),
      ...((typeof item.priority === 'number' || typeof item.priority === 'string') && item.priority !== '' ? { priority: item.priority } : {}),
      ...(text(item.blockedReason) !== undefined ? { blockedReason: text(item.blockedReason) } : {}),
      ...(text(item.blocked_reason) !== undefined ? { blockedReason: text(item.blocked_reason) } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    }
    entries.push(entry)
  }
  return entries
}

function entriesEqual(left: PlanEntryV2, right: PlanEntryV2): boolean {
  return left.id === right.id && left.content === right.content && left.status === right.status
    && left.activeForm === right.activeForm && left.priority === right.priority
    && left.blockedReason === right.blockedReason && left.rawStatus === right.rawStatus
    && JSON.stringify(left.metadata ?? null) === JSON.stringify(right.metadata ?? null)
}

/**
 * plan 事件 reducer：
 * - replaced = 全量快照替换（保持 provider 顺序）；深等返回同一引用（终态幂等）。
 * - entry-updated = 按 stable id patch；目标不存在时以 patch 为种子追加（parent-late 容忍）。
 */
export function applyPlanEvent(state: PlanState, event: PlanEventInput): PlanState {
  if (event.type === 'plan.replaced') {
    const entries = normalizePlanEntries(event.entries)
    if (state.entries.length === entries.length && state.entries.every((entry, index) => entriesEqual(entry, entries[index]))) {
      return state
    }
    return { sessionId: state.sessionId, revision: state.revision + 1, entries }
  }
  if (event.type === 'plan.entry-updated') {
    if (!isRecord(event.entry)) return state
    const [patch] = normalizePlanEntries([event.entry])
    if (!patch) return state
    // patch 无显式 id 时按 content 兜底定位（与 normalizePlanEntries 的 id 派生一致）
    const index = state.entries.findIndex(entry => entry.id === patch.id || (!isRecord(event.entry) ? false : (typeof event.entry.id !== 'string' && typeof event.entry.itemId !== 'string' && entry.content === patch.content)))
    if (index < 0) {
      return { sessionId: state.sessionId, revision: state.revision + 1, entries: [...state.entries, patch] }
    }
    const merged: PlanEntryV2 = {
      ...state.entries[index],
      ...patch,
      ...(patch.metadata !== undefined ? { metadata: { ...state.entries[index].metadata, ...patch.metadata } } : {}),
    }
    if (entriesEqual(state.entries[index], merged)) return state
    const entries = [...state.entries]
    entries[index] = merged
    return { sessionId: state.sessionId, revision: state.revision + 1, entries }
  }
  return state
}

/** wire goal payload → GoalSnapshot；已知字段收窄，未知字段进 metadata */
export function normalizeGoalSnapshot(raw: unknown): GoalSnapshot | undefined {
  if (!isRecord(raw)) return undefined
  const rawStatus = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : undefined
  const status: GoalStatus = rawStatus !== undefined
    ? (KNOWN_GOAL_STATUSES.has(rawStatus) ? rawStatus as Exclude<GoalStatus, 'unknown'> : 'unknown')
    : 'unknown'
  const knownKeys = new Set(['goalId', 'goal_id', 'id', 'objective', 'status', 'tokenBudget', 'token_budget', 'tokensUsed', 'tokens_used', 'blockedReason', 'blocked_reason', 'accounting', 'metadata'])
  const metadata: Record<string, unknown> = isRecord(raw.metadata) ? { ...raw.metadata } : {}
  if (raw.metadata !== undefined && !isRecord(raw.metadata)) metadata.metadata = raw.metadata
  for (const [key, value] of Object.entries(raw)) {
    if (!knownKeys.has(key) && value !== undefined) metadata[key] = value
  }
  const accountingRaw = raw.accounting
  let accounting: GoalAccounting | undefined
  if (isRecord(accountingRaw)) {
    const accountingMetadata: Record<string, unknown> = isRecord(accountingRaw.metadata) ? { ...accountingRaw.metadata } : {}
    if (accountingRaw.metadata !== undefined && !isRecord(accountingRaw.metadata)) accountingMetadata.metadata = accountingRaw.metadata
    for (const [key, value] of Object.entries(accountingRaw)) {
      if (!new Set(['tokensUsed', 'tokens_used', 'timeUsedSeconds', 'time_used_seconds', 'metadata']).has(key) && value !== undefined) accountingMetadata[key] = value
    }
    accounting = {
      ...(typeof accountingRaw.tokensUsed === 'number' ? { tokensUsed: accountingRaw.tokensUsed } : typeof accountingRaw.tokens_used === 'number' ? { tokensUsed: accountingRaw.tokens_used } : {}),
      ...(typeof accountingRaw.timeUsedSeconds === 'number' ? { timeUsedSeconds: accountingRaw.timeUsedSeconds } : typeof accountingRaw.time_used_seconds === 'number' ? { timeUsedSeconds: accountingRaw.time_used_seconds } : {}),
      ...(Object.keys(accountingMetadata).length > 0 ? { metadata: accountingMetadata } : {}),
    }
    if (Object.keys(accounting).length === 0) accounting = undefined
  } else if (accountingRaw !== undefined) {
    metadata.accounting = accountingRaw
  }
  const snapshot: GoalSnapshot = {
    ...(text(raw.goalId ?? raw.goal_id ?? raw.id) !== undefined ? { goalId: text(raw.goalId ?? raw.goal_id ?? raw.id) } : {}),
    ...(text(raw.objective) !== undefined ? { objective: text(raw.objective) } : {}),
    status,
    ...(typeof raw.tokenBudget === 'number' ? { tokenBudget: raw.tokenBudget } : typeof raw.token_budget === 'number' ? { tokenBudget: raw.token_budget } : {}),
    ...(typeof raw.tokensUsed === 'number' ? { tokensUsed: raw.tokensUsed } : typeof raw.tokens_used === 'number' ? { tokensUsed: raw.tokens_used } : {}),
    ...(text(raw.blockedReason ?? raw.blocked_reason) !== undefined ? { blockedReason: text(raw.blockedReason ?? raw.blocked_reason) } : {}),
    ...(accounting !== undefined ? { accounting } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
  return snapshot
}

function goalsEqual(left: GoalSnapshot | undefined, right: GoalSnapshot | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.goalId === right.goalId && left.objective === right.objective && left.status === right.status
    && left.tokenBudget === right.tokenBudget && left.tokensUsed === right.tokensUsed
    && left.blockedReason === right.blockedReason
    && JSON.stringify(left.accounting ?? null) === JSON.stringify(right.accounting ?? null)
    && JSON.stringify(left.metadata ?? null) === JSON.stringify(right.metadata ?? null)
}

/** goal 事件 reducer：updated = merge（partial 快照保活），cleared = 显式清除 */
export function applyGoalEvents(state: GoalState, event: GoalEventInput): GoalState {
  if (event.type === 'goal.updated') {
    const incoming = normalizeGoalSnapshot(event.goal)
    if (!incoming) return state
    const previous = state.current
    if (previous && previous.goalId && incoming.goalId && previous.goalId !== incoming.goalId) {
      // 新 goal id = UPSERT 新目标（Peri set_goal 语义）
      return { current: incoming }
    }
    const merged: GoalSnapshot = {
      ...previous,
      ...incoming,
      ...(incoming.accounting !== undefined ? { accounting: { ...previous?.accounting, ...incoming.accounting, ...(incoming.accounting.metadata !== undefined ? { metadata: { ...previous?.accounting?.metadata, ...incoming.accounting.metadata } } : {}) } } : previous?.accounting !== undefined ? { accounting: previous.accounting } : {}),
      ...(incoming.metadata === undefined && previous?.metadata !== undefined ? { metadata: previous.metadata } : {}),
    }
    if (goalsEqual(previous, merged)) return state
    return { current: merged }
  }
  if (event.type === 'goal.cleared') {
    if (!state.current) return state
    if (event.goalId && state.current.goalId && event.goalId !== state.current.goalId) return state
    return { current: undefined }
  }
  return state
}

// —— 派生选择器（纯函数；进度属于 UI 派生，不进状态） ——

export interface PlanProgress {
  readonly total: number
  readonly completed: number
  readonly active: number
  readonly blocked: number
  readonly cancelled: number
}

export function selectPlanProgress(entries: readonly PlanEntryV2[]): PlanProgress {
  const progress: { total: number; completed: number; active: number; blocked: number; cancelled: number } = { total: 0, completed: 0, active: 0, blocked: 0, cancelled: 0 }
  for (const entry of entries) {
    progress.total += 1
    if (entry.status === 'completed') progress.completed += 1
    else if (entry.status === 'in_progress') progress.active += 1
    else if (entry.status === 'blocked') progress.blocked += 1
    else if (entry.status === 'cancelled') progress.cancelled += 1
  }
  return progress
}

/** React generic fallback 文本行：cancelled/blocked/unknown 全部可读 */
export function readablePlanLines(entries: readonly PlanEntryV2[]): readonly string[] {
  return entries.map(entry => {
    const status = entry.status === 'unknown' && entry.rawStatus ? `unknown (${entry.rawStatus})` : entry.status
    const reason = entry.status === 'blocked' && entry.blockedReason ? ` — ${entry.blockedReason}` : ''
    return `[${status}] ${entry.content}${reason}`
  })
}

export function plainGoalSummary(goal: GoalSnapshot | undefined): string {
  if (!goal) return ''
  const budget = goal.tokenBudget !== undefined && goal.tokenBudget > 0 && goal.tokensUsed !== undefined
    ? ` — 预算 ${Math.round((goal.tokensUsed / goal.tokenBudget) * 100)}%（${goal.tokensUsed}/${goal.tokenBudget}）`
    : ''
  const reason = goal.status === 'blocked' && goal.blockedReason ? ` — ${goal.blockedReason}` : ''
  const label = goal.status === 'unknown' ? '未知' : goal.status
  return `[${label}] ${goal.objective ?? '（无 objective）'}${budget}${reason}`
}

/** Renderer boundary guard: only the normalized Plan/Goal projection may enter content.plan. */
export function isValidPlanContentInput(input: unknown): input is PlanContentPayload {
  if (!isRecord(input) || !hasOnlyKeys(input, ['entries', 'goal']) || !Array.isArray(input.entries)) return false
  if (!input.entries.every(isValidPlanEntryInput)) return false
  return input.goal === undefined || isValidGoalInput(input.goal)
}

function isValidPlanEntryInput(input: unknown): input is PlanEntryV2 {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'id', 'content', 'status', 'activeForm', 'priority', 'blockedReason', 'rawStatus', 'metadata',
  ])) return false
  if (!text(input.id) || !text(input.content)) return false
  if (![...PLAN_ENTRY_STATUSES, 'unknown'].includes(input.status as PlanEntryStatus | 'unknown')) return false
  if (input.status === 'unknown' && !text(input.rawStatus)) return false
  if (input.activeForm !== undefined && typeof input.activeForm !== 'string') return false
  if (input.priority !== undefined && typeof input.priority !== 'string'
    && (typeof input.priority !== 'number' || !Number.isFinite(input.priority))) return false
  if (input.blockedReason !== undefined && typeof input.blockedReason !== 'string') return false
  if (input.rawStatus !== undefined && typeof input.rawStatus !== 'string') return false
  return input.metadata === undefined || isRecord(input.metadata)
}

function isValidGoalInput(input: unknown): input is GoalSnapshot {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'goalId', 'objective', 'status', 'tokenBudget', 'tokensUsed', 'blockedReason', 'accounting', 'metadata',
  ])) return false
  if (![...GOAL_STATUSES, 'unknown'].includes(input.status as GoalStatus)) return false
  if (input.goalId !== undefined && typeof input.goalId !== 'string') return false
  if (input.objective !== undefined && typeof input.objective !== 'string') return false
  if (input.blockedReason !== undefined && typeof input.blockedReason !== 'string') return false
  if (!isOptionalNonNegativeFinite(input.tokenBudget) || !isOptionalNonNegativeFinite(input.tokensUsed)) return false
  if (input.metadata !== undefined && !isRecord(input.metadata)) return false
  if (input.accounting === undefined) return true
  if (!isRecord(input.accounting) || !hasOnlyKeys(input.accounting, ['tokensUsed', 'timeUsedSeconds', 'metadata'])) return false
  return isOptionalNonNegativeFinite(input.accounting.tokensUsed)
    && isOptionalNonNegativeFinite(input.accounting.timeUsedSeconds)
    && (input.accounting.metadata === undefined || isRecord(input.accounting.metadata))
}

function hasOnlyKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(input).every(key => allowed.has(key))
}

function isOptionalNonNegativeFinite(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}
