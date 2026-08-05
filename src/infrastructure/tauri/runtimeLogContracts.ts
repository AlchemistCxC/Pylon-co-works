import type { RuntimeLogEntry } from '../../domains/runtime/runtimeLogs.ts'

/**
 * runtimeLogContracts — 运行日志 wire 收窄（W1-08）。
 *
 * list_runtime_logs / pylon:runtime-log / push_frontend_log 的 RuntimeLogEntry
 * （§5.6）宽容 normalize：level 非法归 info、session 可空、timestamp 数字/字符串兼容；
 * 消息已脱敏，前端直接展示不外传。
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const

function toLevel(value: unknown): string {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value) ? value : 'info'
}

function toTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : Date.parse(value)
  }
  return 0
}

export function normalizeRuntimeLogEntry(value: unknown): RuntimeLogEntry | null {
  if (!isPlainObject(value)) return null
  const id = Number(value.id)
  if (!Number.isFinite(id)) return null
  const message = typeof value.message === 'string' ? value.message : ''
  if (!message) return null
  return {
    id,
    timestamp: toTimestamp(value.timestamp),
    level: toLevel(value.level),
    source: typeof value.source === 'string' ? value.source : '',
    ...(typeof value.session === 'string' && value.session.length > 0 ? { session: value.session } : {}),
    message,
    ...(isPlainObject(value.fields) ? { fields: Object.fromEntries(Object.entries(value.fields).filter(([, v]) => typeof v === 'string')) as Record<string, string> } : {}),
  }
}

export function normalizeRuntimeLogList(raw: unknown): RuntimeLogEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeRuntimeLogEntry).filter((entry): entry is RuntimeLogEntry => entry !== null)
}
// ── W1-09：startup_diagnostics（§5.10）宽容 normalize ──

export interface StartupDiagnosticEntry {
  status: string
  message?: string
}

export interface StartupDiagnostics {
  agentConfig: StartupDiagnosticEntry | null
  gatewayConfig: StartupDiagnosticEntry | null
  prism: StartupDiagnosticEntry | null
  defaultAgentId?: string
  configSource?: { kind: string; fileName?: string }
}

function normalizeDiagnosticEntry(value: unknown): StartupDiagnosticEntry | null {
  if (!isPlainObject(value)) return null
  const status = typeof value.status === 'string' && value.status.length > 0 ? value.status : 'unknown'
  return {
    status,
    ...(typeof value.message === 'string' && value.message.length > 0 ? { message: value.message } : {}),
  }
}

export function normalizeStartupDiagnostics(raw: unknown): StartupDiagnostics {
  if (!isPlainObject(raw)) return { agentConfig: null, gatewayConfig: null, prism: null }
  return {
    agentConfig: normalizeDiagnosticEntry(raw.agentConfig),
    gatewayConfig: normalizeDiagnosticEntry(raw.gatewayConfig),
    prism: normalizeDiagnosticEntry(raw.prism),
    ...(typeof raw.defaultAgentId === 'string' && raw.defaultAgentId.length > 0 ? { defaultAgentId: raw.defaultAgentId } : {}),
    ...(isPlainObject(raw.configSource)
      ? { configSource: { kind: typeof raw.configSource.kind === 'string' ? raw.configSource.kind : 'unknown', ...(typeof raw.configSource.fileName === 'string' ? { fileName: raw.configSource.fileName } : {}) } }
      : {}),
  }
}
