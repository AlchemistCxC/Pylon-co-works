import { addError, resolveRuntimeErrors as resolveStoredRuntimeErrors } from './errorCenter.ts'
import type { RuntimeErrorMatcher } from './errorCenter.ts'

export type RecoveryKind =
  | 'open-agent-settings'
  | 'select-agent-executable'
  | 'open-runtime-log'

export type RuntimeErrorSeverity = 'error' | 'warning' | 'info'
export type RuntimeErrorVisibility = 'global' | 'diagnostic'
export type RuntimeErrorScopeKind = 'app' | 'agent' | 'session' | 'sheet' | 'operation'

export interface RuntimeErrorScope {
  kind: RuntimeErrorScopeKind
  id: string
}

export interface RuntimeErrorRecovery {
  kind: RecoveryKind
  agentId?: string
  sessionId?: string
  sheetId?: string
  suiteId?: string
}

/** Display-only action kept in memory; never serialized into wire/canonical data. */
export interface RuntimeErrorRecoveryAction {
  label: string
  run: () => void | Promise<void>
}

export interface RuntimeErrorOptions {
  /** Global errors are rendered by ErrorCenter; diagnostics stay queryable but quiet. */
  visibility?: RuntimeErrorVisibility
  severity?: RuntimeErrorSeverity
  scope?: RuntimeErrorScope
  /** Optional stable operation key when action text is not unique. */
  key?: string
  technicalMessage?: string
  metadata?: Readonly<Record<string, unknown>>
  source?: string
  recovery?: RuntimeErrorRecovery
  recoveryAction?: RuntimeErrorRecoveryAction
}

export interface RuntimeErrorDetail {
  action: string
  /** Short user-facing summary. Never use this field for unverified timings/raw payloads. */
  message: string
  /** 后端稳定错误码（施工文档 §5.2）；缺失时保留 undefined。 */
  code?: string
  /** 可行动恢复入口（ErrorCenter 据此渲染恢复按钮）。 */
  recovery?: RuntimeErrorRecovery
  severity?: RuntimeErrorSeverity
  visibility?: RuntimeErrorVisibility
  scope?: RuntimeErrorScope
  key?: string
  /** Bounded, redacted technical detail shown only after expansion. */
  technicalMessage?: string
  metadata?: Readonly<Record<string, unknown>>
  source?: string
  recoveryAction?: RuntimeErrorRecoveryAction
}

interface StructuredWireError {
  message?: unknown
  code?: unknown
}

const MAX_DETAIL_LENGTH = 8_192
const MAX_DETAIL_DEPTH = 4
const MAX_DETAIL_NODES = 400
const SECRET_KEY = /(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key)/i

function bounded(value: string): string {
  if (value.length <= MAX_DETAIL_LENGTH) return value
  return `${value.slice(0, MAX_DETAIL_LENGTH)}\n…（详情已截断）`
}

/**
 * Remove common credential forms from free-form provider text and Error.stack.
 * Key-based object redaction alone is insufficient because transports often
 * interpolate headers or query parameters into an exception message.
 */
function redactText(value: string): string {
  return bounded(value)
    .replace(/((?:authorization|cookie)\s*:\s*)(Bearer\s+)?[^\r\n]+/gi, '$1$2[已脱敏]')
    .replace(
      /(["']?(?:password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)["']?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      '$1[已脱敏]',
    )
    .replace(
      /((?:password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)\s*=\s*)[^\s&;]+/gi,
      '$1[已脱敏]',
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已脱敏]')
    .replace(/(https?:\/\/[^:/\s]+:)[^@\s/]+@/gi, '$1[已脱敏]@')
}

/**
 * Provider transports sometimes return their configured timeout in a free-form
 * error even when the local call failed immediately. Never promote that
 * unverified duration into the concise user-facing summary; the original text
 * remains available in technicalMessage for diagnostics.
 */
function safeUserSummary(value: string): string {
  const normalized = value.trim()
  if (!normalized) return '未知错误'
  if (/(?:ACP\s+protocol\s*:.*provider\s+error|provider\s+error.*ACP\s+protocol\s*:)/i.test(normalized)) {
    return 'Provider 返回错误'
  }
  if (/timed\s+out\s+after\s+\d+(?:\.\d+)?\s*s/i.test(normalized)) {
    if (/first[-_ ]token/i.test(normalized)) return '首个响应超时'
    if (/(?:idle|闲置)/i.test(normalized)) return '响应闲置超时'
    return '请求超时'
  }
  return normalized
}

/** Redact obvious credential-shaped keys before technical details reach UI. */
interface RedactionBudget { remaining: number }

function redact(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget: RedactionBudget = { remaining: MAX_DETAIL_NODES },
): unknown {
  if (depth > MAX_DETAIL_DEPTH || budget.remaining-- <= 0) return '[详情已截断]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[循环详情已省略]'
    seen.add(value)
    return value.slice(0, 40).map(item => redact(item, depth + 1, seen, budget))
  }
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[循环详情已省略]'
  seen.add(value)
  const output: Record<string, unknown> = {}
  let entries: Array<[string, unknown]>
  try {
    entries = Object.entries(value as Record<string, unknown>).slice(0, 80)
  } catch {
    return '[详情不可用]'
  }
  for (const [key] of entries) {
    if (SECRET_KEY.test(key)) {
      output[key] = '[已脱敏]'
      continue
    }
    let nested: unknown
    try { nested = (value as Record<string, unknown>)[key] } catch { nested = '[详情不可用]' }
    output[key] = redact(nested, depth + 1, seen, budget)
  }
  return output
}

function technicalFrom(error: unknown, summary: string): string | undefined {
  if (error instanceof Error) {
    const stack = typeof error.stack === 'string' && error.stack.trim() ? error.stack.trim() : ''
    let providerDetail = ''
    try {
      const candidate = (error as Error & { technicalMessage?: unknown }).technicalMessage
      providerDetail = typeof candidate === 'string' ? candidate.trim() : ''
    } catch { /* hostile Error-like getter */ }
    const parts = [providerDetail, stack && stack !== summary ? stack : summary].filter(Boolean)
    return redactText(parts.join('\n'))
  }
  if (error && typeof error === 'object') {
    try { return bounded(JSON.stringify(redact(error), null, 2)) } catch { return summary }
  }
  if (typeof error === 'string') {
    const raw = error.trim()
    return raw && raw !== summary ? redactText(raw) : undefined
  }
  return undefined
}

/** 从后端 wire 错误提取 code 与 message（不把 code 拼进 message 后丢失结构）。 */
function structuredErrorParts(error: unknown): { code?: string; message: string } | null {
  if (error && typeof error === 'object') {
    try {
      const shape = error as StructuredWireError
      if (typeof shape.message === 'string' && shape.message.trim().length > 0) {
        return {
          code: typeof shape.code === 'string' && shape.code.trim() ? shape.code.trim() : undefined,
          message: shape.message.trim(),
        }
      }
    } catch {
      return null
    }
  }
  return null
}

/** 从部署错误码推导恢复入口（施工文档 §5.3 按钮映射）。 */
export function recoveryForCode(code: string | undefined, agentId?: string): RuntimeErrorDetail['recovery'] {
  switch (code) {
    case 'agent_executable_missing':
      return { kind: 'select-agent-executable', agentId }
    case 'config_read_only':
    case 'config_write_error':
      return { kind: 'open-agent-settings', agentId }
    case 'agent_spawn_failed':
    case 'agent_initialize_failed':
    case 'agent_connection_timeout':
      return { kind: 'open-runtime-log' }
    default:
      return undefined
  }
}

export function formatRuntimeError(action: string, error: unknown, agentId?: string): RuntimeErrorDetail {
  if (error === null || error === undefined) {
    return { action, message: '未知错误' }
  }
  if (error instanceof Error) {
    let rawMessage = ''
    let rawCode: unknown
    try { rawMessage = typeof error.message === 'string' ? error.message : '' } catch { /* hostile Error-like getter */ }
    try { rawCode = (error as Error & { code?: unknown }).code } catch { rawCode = undefined }
    const message = safeUserSummary(rawMessage)
    const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : undefined
    return {
      action,
      message: redactText(message),
      ...(code ? { code, recovery: recoveryForCode(code, agentId) } : {}),
    }
  }
  const parts = structuredErrorParts(error)
  if (parts !== null) {
    return {
      action,
      message: redactText(safeUserSummary(parts.message)),
      code: parts.code,
      recovery: recoveryForCode(parts.code, agentId),
    }
  }
  let raw: string
  try { raw = String(error) } catch { raw = '' }
  const message = raw && raw.trim().length > 0 && raw !== '[object Object]'
    ? redactText(safeUserSummary(raw))
    : '未知错误'
  return { action, message }
}

export function reportRuntimeError(action: string, error: unknown, agentId?: string, options?: RuntimeErrorOptions): RuntimeErrorDetail {
  const detail = formatRuntimeError(action, error, agentId)
  const scope = options?.scope ?? (agentId ? { kind: 'agent' as const, id: agentId } : undefined)
  const enriched: RuntimeErrorDetail = {
    ...detail,
    severity: options?.severity ?? 'error',
    visibility: options?.visibility ?? 'global',
    ...(scope ? { scope } : {}),
    ...(options?.key ? { key: options.key } : {}),
    ...(options?.source ? { source: options.source } : {}),
    ...(options?.recovery ? { recovery: options.recovery } : {}),
    ...(options?.recoveryAction ? { recoveryAction: options.recoveryAction } : {}),
    ...(options?.technicalMessage
      ? { technicalMessage: redactText(options.technicalMessage) }
      : (() => {
        const technical = technicalFrom(error, detail.message)
        return technical ? { technicalMessage: technical } : {}
      })()),
    ...(options?.metadata ? { metadata: redact(options.metadata) as Readonly<Record<string, unknown>> } : {}),
  }
  console.error(`${action}失败`, error)
  if (typeof window !== 'undefined') {
    // 聚合错误中心（保留事件分发向后兼容，如外部 listener）
    addError(enriched)
    window.dispatchEvent(new CustomEvent<RuntimeErrorDetail>('pylon:runtime-error', { detail: enriched }))
  }
  return enriched
}

/** Report a real degradation without interrupting the user with a global tray item. */
export function reportRuntimeDiagnostic(
  action: string,
  error: unknown,
  agentId?: string,
  options?: Omit<RuntimeErrorOptions, 'visibility'>,
): RuntimeErrorDetail {
  return reportRuntimeError(action, error, agentId, { ...options, visibility: 'diagnostic', severity: options?.severity ?? 'warning' })
}

/** Resolve only matching active entries after a corresponding operation succeeds. */
export function resolveRuntimeErrors(matcher: RuntimeErrorMatcher): void {
  resolveStoredRuntimeErrors(matcher)
}
