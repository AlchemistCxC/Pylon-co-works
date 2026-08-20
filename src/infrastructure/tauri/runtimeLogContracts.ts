import type { RuntimeCorrelation, RuntimeLogEntry } from '../../domains/runtime/runtimeLogs.ts'

/**
 * runtimeLogContracts — 运行日志 wire 收窄（W1-08）。
 *
 * list_runtime_logs / pylon:runtime-log / push_frontend_log 的 RuntimeLogEntry
 * （§5.6）宽容 normalize：level 非法归 info、session 可空、timestamp 数字/字符串兼容；
 * 消息已脱敏，前端直接展示不外传。LOG-03（§5.14 增量字段）：新增 code/category/
 * recoverable/userActionRequired/rawAvailable + correlation（OBS-02 身份）——normalize
 * 保留 correlation，UI 可见会话身份（OBS-07 P5 correlationDroppedFrontend 闭环）。
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

/** OBS-02/LOG-03：correlation 收窄——agentId+source 必填、clientGeneration 有限非负整数；
 * 不完整则整体拒绝（身份不得残缺，禁止只记 source 或只记 sessionId）。
 * CR-201（LOG-03 审查）：clientGeneration 严格类型守卫——Rust wire 为 `client_generation: u64`
 * 必填有限非负整数，非 number 形态（null/''/true/[] 经 `Number()` 强转 0/1 的宽松通过路径）
 * 一律拒绝，AC-3"残缺身份整体拒绝"语义不因强转放宽。 */
function toCorrelation(value: unknown): RuntimeCorrelation | null {
  if (!isPlainObject(value)) return null
  const agentId = typeof value.agentId === 'string' ? value.agentId : ''
  const source = typeof value.source === 'string' ? value.source : ''
  if (!agentId || !source) return null
  const generation = value.clientGeneration
  if (
    typeof generation !== 'number'
    || !Number.isFinite(generation)
    || !Number.isInteger(generation)
    || generation < 0
  ) {
    return null
  }
  return {
    agentId,
    source,
    clientGeneration: generation,
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
    ...(typeof value.localSessionId === 'string' ? { localSessionId: value.localSessionId } : {}),
    ...(typeof value.remoteSessionId === 'string' ? { remoteSessionId: value.remoteSessionId } : {}),
    ...(typeof value.periId === 'string' ? { periId: value.periId } : {}),
    ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
    ...(typeof value.toolCallId === 'string' ? { toolCallId: value.toolCallId } : {}),
  }
}

function toBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function normalizeRuntimeLogEntry(value: unknown): RuntimeLogEntry | null {
  if (!isPlainObject(value)) return null
  const id = Number(value.id)
  if (!Number.isFinite(id)) return null
  const message = typeof value.message === 'string' ? value.message : ''
  if (!message) return null
  const correlation = toCorrelation(value.correlation)
  return {
    id,
    timestamp: toTimestamp(value.timestamp),
    level: toLevel(value.level),
    source: typeof value.source === 'string' ? value.source : '',
    ...(typeof value.session === 'string' && value.session.length > 0 ? { session: value.session } : {}),
    message,
    ...(isPlainObject(value.fields) ? { fields: Object.fromEntries(Object.entries(value.fields).filter(([, v]) => typeof v === 'string')) as Record<string, string> } : {}),
    // LOG-03 增量字段：字符串直接透传，布尔经 toBool（非法值省略，宽容收窄）。
    ...(typeof value.code === 'string' && value.code.length > 0 ? { code: value.code } : {}),
    ...(typeof value.category === 'string' && value.category.length > 0 ? { category: value.category } : {}),
    ...(toBool(value.recoverable) !== undefined ? { recoverable: toBool(value.recoverable) } : {}),
    ...(toBool(value.userActionRequired) !== undefined ? { userActionRequired: toBool(value.userActionRequired) } : {}),
    ...(toBool(value.rawAvailable) !== undefined ? { rawAvailable: toBool(value.rawAvailable) } : {}),
    ...(correlation ? { correlation } : {}),
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

export interface HermesProfileDiagnostics {
  profiles: string[]
  configured?: string
  resolved: boolean
}

export interface StartupDiagnostics {
  agentConfig: StartupDiagnosticEntry | null
  gatewayConfig: StartupDiagnosticEntry | null
  prism: StartupDiagnosticEntry | null
  defaultAgentId?: string
  configSource?: { kind: string; fileName?: string }
  /** Hermes profile 探测结果（release-issues #1 方案 G 演进；无 Hermes 时缺失） */
  hermesProfile?: HermesProfileDiagnostics
  /** 施工文档 §7.4：存储模式诊断（setup 解析 DataDirs 后写入） */
  storage?: StorageDiagnostics
}

export interface StorageDiagnostics {
  mode: 'portable' | 'app_data' | string
  portableRequested: boolean
  fallbackReason?: string
  migrationAvailable: boolean
}

function normalizeDiagnosticEntry(value: unknown): StartupDiagnosticEntry | null {
  if (!isPlainObject(value)) return null
  const status = typeof value.status === 'string' && value.status.length > 0 ? value.status : 'unknown'
  return {
    status,
    ...(typeof value.message === 'string' && value.message.length > 0 ? { message: value.message } : {}),
  }
}

function normalizeHermesProfile(value: unknown): HermesProfileDiagnostics | undefined {
  if (!isPlainObject(value)) return undefined
  return {
    profiles: Array.isArray(value.profiles) ? value.profiles.filter((item): item is string => typeof item === 'string') : [],
    ...(typeof value.configured === 'string' && value.configured.length > 0 ? { configured: value.configured } : {}),
    resolved: value.resolved === true,
  }
}

function normalizeStorageDiagnostics(value: unknown): StorageDiagnostics | undefined {
  if (!isPlainObject(value)) return undefined
  return {
    mode: typeof value.mode === 'string' ? value.mode : 'app_data',
    portableRequested: value.portableRequested === true,
    ...(typeof value.fallbackReason === 'string' && value.fallbackReason.length > 0 ? { fallbackReason: value.fallbackReason } : {}),
    migrationAvailable: value.migrationAvailable === true,
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
    ...(normalizeHermesProfile(raw.hermesProfile) ? { hermesProfile: normalizeHermesProfile(raw.hermesProfile)! } : {}),
    ...(normalizeStorageDiagnostics(raw.storage) ? { storage: normalizeStorageDiagnostics(raw.storage)! } : {}),
  }
}
