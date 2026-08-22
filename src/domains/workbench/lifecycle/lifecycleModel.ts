/**
 * C13：生命周期 / 错误 / 自愈统一语义模型（纯 domain，无 IO/store/framework import）。
 *
 * - NormalizedError 是错误一等契约：userSummary / technicalMessage / code /
 *   recoverability / cause chain；UI 只读结构化字段，不得解析字符串决定动作
 *   （C13 完成定义）。
 * - lifecycle 事件收敛为 LifecycleState：retry/compact/rewind/suspended 是当前态，
 *   history 保留全部已发生事实——恢复成功不删除历史，只更新状态关联（K07 精神：
 *   状态名称与真实投影一致）。
 */

export const LIFECYCLE_PHASES = ['retry', 'compact', 'rewind', 'suspended', 'recovered'] as const
export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number]

export type Recoverability = 'retry' | 'fallback' | 'reload-plugin' | 'reimport' | 'none'
export type ErrorPhase = 'resolve' | 'prepare' | 'mount' | 'update' | 'switch' | 'action' | 'destroy' | 'settings-migrate'

export interface NormalizedError {
  /** 面向用户的摘要（可理解） */
  readonly userSummary: string
  /** 技术细节（可审计；默认折叠） */
  readonly technicalMessage?: string
  readonly code?: string
  readonly provider?: string
  readonly sessionId?: string
  readonly eventId?: string
  readonly renderKind?: string
  readonly rendererId?: string
  readonly rendererSuiteId?: string
  readonly rendererSlotId?: string
  readonly pluginId?: string
  readonly runtimeInstanceId?: string
  readonly phase?: ErrorPhase
  readonly recoverability: Recoverability
  /** cause chain：深度受控的嵌套原因 */
  readonly cause?: NormalizedError
  /** provider 扩展字段；不把原始 provider 对象直接暴露给 renderer */
  readonly metadata?: Readonly<Record<string, unknown>>
}

const MAX_CAUSE_DEPTH = 4

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * unknown → NormalizedError。字符串输入按 userSummary=technicalMessage 收窄；
 * 嵌套 cause 深度截断到 MAX_CAUSE_DEPTH，超出部分以 causeTruncated metadata 留痕。
 */
export function normalizeNormalizedError(raw: unknown, depth = 0): NormalizedError | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'string') {
    const message = raw.trim() || '未知错误'
    return { userSummary: message, technicalMessage: message, recoverability: 'none' }
  }
  if (!isRecord(raw)) {
    return { userSummary: '未知错误', technicalMessage: String(raw), recoverability: 'none' }
  }
  const knownKeys = new Set([
    'userSummary', 'user_summary', 'userMessage',
    'technicalMessage', 'technical_message', 'detail', 'message', 'error',
    'code', 'provider', 'sessionId', 'session_id', 'eventId', 'event_id',
    'renderKind', 'rendererId', 'rendererSuiteId', 'rendererSlotId', 'pluginId', 'runtimeInstanceId', 'phase',
    'recoverability', 'retryable', 'cause', 'metadata',
  ])
  const metadata: Record<string, unknown> = isRecord(raw.metadata) ? { ...raw.metadata } : {}
  if (raw.metadata !== undefined && !isRecord(raw.metadata)) metadata.metadata = raw.metadata
  for (const [key, value] of Object.entries(raw)) {
    if (!knownKeys.has(key) && value !== undefined) metadata[key] = value
  }
  const technical = text(raw.technicalMessage) ?? text(raw.technical_message) ?? text(raw.detail) ?? text(raw.message) ?? text(raw.error)
  const summary = text(raw.userSummary) ?? text(raw.user_summary) ?? text(raw.userMessage) ?? technical ?? '未知错误'
  let cause: NormalizedError | undefined
  if (depth < MAX_CAUSE_DEPTH && raw.cause !== undefined) {
    cause = normalizeNormalizedError(raw.cause, depth + 1)
  } else if (depth >= MAX_CAUSE_DEPTH && raw.cause !== undefined) {
    metadata.causeTruncated = true
  }
  const recoverability = normalizeRecoverability(raw.recoverability, raw.retryable)
  const phase = normalizeErrorPhase(raw.phase)
  if (raw.phase !== undefined && phase === undefined) metadata.phase = raw.phase
  return {
    ...(text(raw.code) !== undefined ? { code: text(raw.code) } : {}),
    ...(text(raw.provider) !== undefined ? { provider: text(raw.provider) } : {}),
    ...(text(raw.sessionId ?? raw.session_id) !== undefined ? { sessionId: text(raw.sessionId ?? raw.session_id) } : {}),
    ...(text(raw.eventId ?? raw.event_id) !== undefined ? { eventId: text(raw.eventId ?? raw.event_id) } : {}),
    ...(text(raw.renderKind) !== undefined ? { renderKind: text(raw.renderKind) } : {}),
    ...(text(raw.rendererId) !== undefined ? { rendererId: text(raw.rendererId) } : {}),
    ...(text(raw.rendererSuiteId) !== undefined ? { rendererSuiteId: text(raw.rendererSuiteId) } : {}),
    ...(text(raw.rendererSlotId) !== undefined ? { rendererSlotId: text(raw.rendererSlotId) } : {}),
    ...(text(raw.pluginId) !== undefined ? { pluginId: text(raw.pluginId) } : {}),
    ...(text(raw.runtimeInstanceId) !== undefined ? { runtimeInstanceId: text(raw.runtimeInstanceId) } : {}),
    ...(phase !== undefined ? { phase } : {}),
    userSummary: summary,
    ...(technical !== undefined ? { technicalMessage: technical } : {}),
    recoverability,
    ...(cause !== undefined ? { cause } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

function normalizeRecoverability(value: unknown, retryable?: unknown): Recoverability {
  const candidates: readonly Recoverability[] = ['retry', 'fallback', 'reload-plugin', 'reimport', 'none']
  const text_ = text(value)?.trim().toLowerCase()
  return candidates.find(candidate => candidate === text_) ?? (retryable === true ? 'retry' : 'none')
}

function normalizeErrorPhase(value: unknown): ErrorPhase | undefined {
  const candidates: readonly ErrorPhase[] = ['resolve', 'prepare', 'mount', 'update', 'switch', 'action', 'destroy', 'settings-migrate']
  const text_ = text(value)?.trim().toLowerCase()
  return candidates.find(candidate => candidate === text_)
}

// —— 当前态 ——

export interface RetryState {
  readonly attempt: number
  readonly maxAttempts?: number
  readonly delayMs?: number
  readonly error?: NormalizedError
}

export interface CompactState {
  readonly phase: 'started' | 'completed'
  readonly strategy?: string
  readonly trigger?: string
  readonly tokensBefore?: number
  readonly tokensAfter?: number
  readonly summary?: string
}

export interface RewindState {
  readonly phase: 'preview' | 'completed'
  readonly files?: readonly JsonRecord[]
  readonly messages?: readonly JsonRecord[]
  readonly summary?: string
}

export interface RecoveryInfo {
  readonly source: 'canonical' | 'agent-import'
  readonly importedEvents?: number
}

type JsonRecord = Record<string, unknown>

// —— 历史 ——

export interface LifecycleHistoryItem {
  readonly kind: LifecyclePhase
  /** compact/rewind 阶段（started/completed、preview/completed） */
  readonly phase?: 'started' | 'completed' | 'preview'
  readonly attempt?: number
  readonly maxAttempts?: number
  readonly delayMs?: number
  readonly error?: NormalizedError
  readonly strategy?: string
  readonly trigger?: string
  readonly tokensBefore?: number
  readonly tokensAfter?: number
  readonly files?: readonly JsonRecord[]
  readonly messages?: readonly JsonRecord[]
  readonly summary?: string
  readonly source?: RecoveryInfo['source']
  readonly importedEvents?: number
  readonly reason?: string
}

export interface LifecycleState {
  readonly retry?: RetryState
  readonly compact?: CompactState
  readonly rewind?: RewindState
  readonly suspended?: { readonly reason?: string }
  readonly lastRecovery?: RecoveryInfo
  readonly history: readonly LifecycleHistoryItem[]
}

export function createEmptyLifecycleState(): LifecycleState {
  return { history: [] }
}

interface LifecycleEventInput {
  readonly type: string
  readonly attempt?: unknown
  readonly maxAttempts?: unknown
  readonly delayMs?: unknown
  readonly error?: unknown
  readonly strategy?: unknown
  readonly trigger?: unknown
  readonly tokensBefore?: unknown
  readonly tokensAfter?: unknown
  readonly files?: unknown
  readonly messages?: unknown
  readonly summary?: unknown
  readonly reason?: unknown
  readonly source?: unknown
  readonly importedEvents?: unknown
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** lifecycle 事件 reducer：终态收敛当前态、全部事实进 history（只追加不删除）。 */
export function applyLifecycleEvent(state: LifecycleState, event: LifecycleEventInput): LifecycleState {
  switch (event.type) {
    case 'lifecycle.retrying': {
      const retry: RetryState = {
        attempt: num(event.attempt) ?? 0,
        ...(num(event.maxAttempts) !== undefined ? { maxAttempts: num(event.maxAttempts) } : {}),
        ...(num(event.delayMs) !== undefined ? { delayMs: num(event.delayMs) } : {}),
        ...(event.error !== undefined ? { error: normalizeNormalizedError(event.error) } : {}),
      }
      return {
        ...state,
        retry,
        history: [...state.history, { kind: 'retry', ...retry }],
      }
    }
    case 'lifecycle.compact-started':
    case 'lifecycle.compact-completed': {
      const completed = event.type === 'lifecycle.compact-completed'
      // completed 未携带时保留 started 的 strategy/trigger/tokensBefore
      const compact: CompactState = {
        phase: completed ? 'completed' : 'started',
        ...(text(event.strategy) !== undefined ? { strategy: text(event.strategy) } : state.compact?.strategy !== undefined ? { strategy: state.compact.strategy } : {}),
        ...(text(event.trigger) !== undefined ? { trigger: text(event.trigger) } : state.compact?.trigger !== undefined ? { trigger: state.compact.trigger } : {}),
        ...(num(event.tokensBefore) !== undefined ? { tokensBefore: num(event.tokensBefore) } : state.compact?.tokensBefore !== undefined ? { tokensBefore: state.compact.tokensBefore } : {}),
        ...(num(event.tokensAfter) !== undefined ? { tokensAfter: num(event.tokensAfter) } : {}),
        ...(text(event.summary) !== undefined ? { summary: text(event.summary) } : {}),
      }
      return {
        ...state,
        compact,
        history: [...state.history, { kind: 'compact', ...compact }],
      }
    }
    case 'lifecycle.rewind-preview':
    case 'lifecycle.rewind-completed': {
      const rewind: RewindState = {
        phase: event.type === 'lifecycle.rewind-completed' ? 'completed' : 'preview',
        ...(Array.isArray(event.files) ? { files: event.files.filter(isRecordLike) } : state.rewind?.files !== undefined ? { files: state.rewind.files } : {}),
        ...(Array.isArray(event.messages) ? { messages: event.messages.filter(isRecordLike) } : state.rewind?.messages !== undefined ? { messages: state.rewind.messages } : {}),
        ...(text(event.summary) !== undefined ? { summary: text(event.summary) } : {}),
      }
      return {
        ...state,
        rewind,
        history: [...state.history, { kind: 'rewind', ...rewind }],
      }
    }
    case 'lifecycle.suspended': {
      const suspended = { ...(text(event.reason) !== undefined ? { reason: text(event.reason) } : {}) }
      return {
        ...state,
        suspended,
        history: [...state.history, { kind: 'suspended', ...(suspended.reason !== undefined ? { reason: suspended.reason } : {}) }],
      }
    }
    case 'lifecycle.recovered': {
      const source = event.source === 'agent-import' ? 'agent-import' as const : 'canonical' as const
      const lastRecovery: RecoveryInfo = {
        source,
        ...(num(event.importedEvents) !== undefined ? { importedEvents: num(event.importedEvents) } : {}),
      }
      // recovered 终态：收敛 retry/suspend 当前态；history 不删除
      return {
        ...state,
        retry: undefined,
        suspended: undefined,
        lastRecovery,
        history: [...state.history, { kind: 'recovered', source, ...(lastRecovery.importedEvents !== undefined ? { importedEvents: lastRecovery.importedEvents } : {}) }],
      }
    }
    default:
      return state
  }
}

function isRecordLike(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// —— 派生选择器 ——

/** 当前活动错误：retry 在途时其 error 为活动错误；恢复后清空（历史保留） */
export function selectActiveErrors(state: LifecycleState): readonly NormalizedError[] {
  return state.retry?.error ? [state.retry.error] : []
}

/** React generic fallback 文本行：全部历史可读 */
export function readableLifecycleLines(history: readonly LifecycleHistoryItem[]): readonly string[] {
  return history.map(item => {
    switch (item.kind) {
      case 'retry':
        return `[retry] 第 ${item.attempt ?? '?'}${item.maxAttempts !== undefined ? `/${item.maxAttempts}` : ''} 次重试${item.error?.userSummary ? ` — ${item.error.userSummary}` : ''}`
      case 'compact':
        return `[compact] ${item.phase === 'completed' ? '完成' : '开始'}${item.summary ? ` — ${item.summary}` : ''}${item.tokensAfter !== undefined && item.tokensBefore !== undefined ? `（${item.tokensBefore}→${item.tokensAfter} tokens）` : ''}`
      case 'rewind':
        return `[rewind] ${item.phase === 'completed' ? '完成' : '预览'}${item.summary ? ` — ${item.summary}` : ''}`
      case 'suspended':
        return `[suspended] ${item.reason ?? '已暂停'}`
      case 'recovered':
        return `[recovered] 已恢复${item.source === 'agent-import' ? '（导入回放）' : ''}${item.importedEvents !== undefined ? ` ${item.importedEvents} 条事件` : ''}`
    }
  })
}

/** 单行摘要：无活动状态时空串。suspended 优先于 retry 展示（暂停即重试链挂起） */
export function plainLifecycleSummary(state: LifecycleState): string {
  if (state.suspended) return `[suspended] ${state.suspended.reason ?? '已暂停'}`
  if (state.retry) return readableLifecycleLines([{ kind: 'retry', ...state.retry }])[0]!
  if (state.rewind?.phase === 'preview') return `[rewind] 预览${state.rewind.summary ? ` — ${state.rewind.summary}` : ''}`
  if (state.compact?.phase === 'started') return `[compact] 进行中${state.compact.strategy ? `（${state.compact.strategy}）` : ''}`
  return ''
}

/** Strict renderer boundary guards. Normalization happens before these functions. */
export function isValidLifecycleStateInput(input: unknown): input is LifecycleState {
  if (!isRecord(input) || !hasOnlyKeys(input, ['retry', 'compact', 'rewind', 'suspended', 'lastRecovery', 'history'])) return false
  if (!Array.isArray(input.history) || !input.history.every(isValidLifecycleHistoryInput)) return false
  if (input.retry !== undefined && !isValidRetryInput(input.retry)) return false
  if (input.compact !== undefined && !isValidCompactInput(input.compact)) return false
  if (input.rewind !== undefined && !isValidRewindInput(input.rewind)) return false
  if (input.suspended !== undefined && (!isRecord(input.suspended)
    || !hasOnlyKeys(input.suspended, ['reason']) || !optionalString(input.suspended.reason))) return false
  return input.lastRecovery === undefined || isValidRecoveryInput(input.lastRecovery)
}

export function isValidNormalizedErrorInput(input: unknown, depth = 0): input is NormalizedError {
  if (depth > MAX_CAUSE_DEPTH || !isRecord(input) || !hasOnlyKeys(input, [
    'userSummary', 'technicalMessage', 'code', 'provider', 'sessionId', 'eventId', 'renderKind', 'rendererId',
    'rendererSuiteId', 'rendererSlotId', 'pluginId', 'runtimeInstanceId', 'phase', 'recoverability', 'cause', 'metadata',
  ])) return false
  if (!text(input.userSummary) || !['retry', 'fallback', 'reload-plugin', 'reimport', 'none'].includes(String(input.recoverability))) return false
  for (const key of ['technicalMessage', 'code', 'provider', 'sessionId', 'eventId', 'renderKind', 'rendererId', 'rendererSuiteId', 'rendererSlotId', 'pluginId', 'runtimeInstanceId'] as const) {
    if (!optionalString(input[key])) return false
  }
  if (input.phase !== undefined && !['resolve', 'prepare', 'mount', 'update', 'switch', 'action', 'destroy', 'settings-migrate'].includes(String(input.phase))) return false
  if (input.metadata !== undefined && !isRecord(input.metadata)) return false
  return input.cause === undefined || isValidNormalizedErrorInput(input.cause, depth + 1)
}

export function isValidSystemNoticeInput(input: unknown): input is {
  readonly code: string
  readonly message: string
  readonly eventId: string
  readonly sequence: number
  readonly level: 'info' | 'warning' | 'error'
  readonly data?: unknown
} {
  return isRecord(input)
    && hasOnlyKeys(input, ['code', 'message', 'eventId', 'sequence', 'level', 'data'])
    && Boolean(text(input.code) && text(input.message) && text(input.eventId))
    && isNonNegativeFinite(input.sequence)
    && ['info', 'warning', 'error'].includes(String(input.level))
}

function isValidRetryInput(input: unknown): input is RetryState {
  return isRecord(input)
    && hasOnlyKeys(input, ['attempt', 'maxAttempts', 'delayMs', 'error'])
    && isNonNegativeFinite(input.attempt)
    && isOptionalNonNegativeFinite(input.maxAttempts)
    && isOptionalNonNegativeFinite(input.delayMs)
    && (input.error === undefined || isValidNormalizedErrorInput(input.error))
}

function isValidCompactInput(input: unknown): input is CompactState {
  return isRecord(input)
    && hasOnlyKeys(input, ['phase', 'strategy', 'trigger', 'tokensBefore', 'tokensAfter', 'summary'])
    && (input.phase === 'started' || input.phase === 'completed')
    && optionalString(input.strategy) && optionalString(input.trigger) && optionalString(input.summary)
    && isOptionalNonNegativeFinite(input.tokensBefore) && isOptionalNonNegativeFinite(input.tokensAfter)
}

function isValidRewindInput(input: unknown): input is RewindState {
  return isRecord(input)
    && hasOnlyKeys(input, ['phase', 'files', 'messages', 'summary'])
    && (input.phase === 'preview' || input.phase === 'completed')
    && optionalRecordArray(input.files) && optionalRecordArray(input.messages) && optionalString(input.summary)
}

function isValidRecoveryInput(input: unknown): input is RecoveryInfo {
  return isRecord(input)
    && hasOnlyKeys(input, ['source', 'importedEvents'])
    && (input.source === 'canonical' || input.source === 'agent-import')
    && isOptionalNonNegativeFinite(input.importedEvents)
}

function isValidLifecycleHistoryInput(input: unknown): input is LifecycleHistoryItem {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'kind', 'phase', 'attempt', 'maxAttempts', 'delayMs', 'error', 'strategy', 'trigger', 'tokensBefore', 'tokensAfter',
    'files', 'messages', 'summary', 'source', 'importedEvents', 'reason',
  ])) return false
  return LIFECYCLE_PHASES.includes(input.kind as LifecyclePhase)
    && (input.phase === undefined || input.phase === 'started' || input.phase === 'completed' || input.phase === 'preview')
    && isOptionalNonNegativeFinite(input.attempt) && isOptionalNonNegativeFinite(input.maxAttempts)
    && isOptionalNonNegativeFinite(input.delayMs) && isOptionalNonNegativeFinite(input.tokensBefore)
    && isOptionalNonNegativeFinite(input.tokensAfter) && isOptionalNonNegativeFinite(input.importedEvents)
    && optionalString(input.strategy) && optionalString(input.trigger) && optionalString(input.summary) && optionalString(input.reason)
    && optionalRecordArray(input.files) && optionalRecordArray(input.messages)
    && (input.source === undefined || input.source === 'canonical' || input.source === 'agent-import')
    && (input.error === undefined || isValidNormalizedErrorInput(input.error))
}

function hasOnlyKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(input).every(key => allowed.has(key))
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isOptionalNonNegativeFinite(value: unknown): boolean {
  return value === undefined || isNonNegativeFinite(value)
}

function optionalRecordArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isRecord))
}
