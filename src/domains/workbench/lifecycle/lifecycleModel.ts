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

export interface NormalizedError {
  /** 面向用户的摘要（可理解） */
  readonly userSummary: string
  /** 技术细节（可审计；默认折叠） */
  readonly technicalMessage?: string
  readonly code?: string
  readonly provider?: string
  readonly sessionId?: string
  readonly eventId?: string
  readonly recoverability: Recoverability
  /** cause chain：深度受控的嵌套原因 */
  readonly cause?: NormalizedError
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
 * 嵌套 cause 深度截断到 MAX_CAUSE_DEPTH，超出部分保留在末端 technicalMessage。
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
  const technical = text(raw.technicalMessage) ?? text(raw.technical_message) ?? text(raw.message) ?? text(raw.error)
  const summary = text(raw.userSummary) ?? text(raw.user_summary) ?? text(raw.userMessage) ?? technical ?? '未知错误'
  let cause: NormalizedError | undefined
  if (depth < MAX_CAUSE_DEPTH && raw.cause !== undefined) {
    cause = normalizeNormalizedError(raw.cause, depth + 1)
  }
  const recoverability = normalizeRecoverability(raw.recoverability)
  return {
    ...(text(raw.code) !== undefined ? { code: text(raw.code) } : {}),
    ...(text(raw.provider) !== undefined ? { provider: text(raw.provider) } : {}),
    ...(text(raw.sessionId) !== undefined ? { sessionId: text(raw.sessionId) } : {}),
    ...(text(raw.eventId) !== undefined ? { eventId: text(raw.eventId) } : {}),
    userSummary: summary,
    ...(technical !== undefined ? { technicalMessage: technical } : {}),
    recoverability,
    ...(cause !== undefined ? { cause } : {}),
  }
}

function normalizeRecoverability(value: unknown): Recoverability {
  const candidates: readonly Recoverability[] = ['retry', 'fallback', 'reload-plugin', 'reimport', 'none']
  const text_ = text(value)?.trim().toLowerCase()
  return candidates.find(candidate => candidate === text_) ?? 'none'
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
  readonly error?: NormalizedError
  readonly strategy?: string
  readonly tokensBefore?: number
  readonly tokensAfter?: number
  readonly files?: readonly JsonRecord[]
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
        ...(Array.isArray(event.messages) ? { messages: event.messages.filter(isRecordLike) } : {}),
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
