/**
 * runtimeLogs — 运行日志纯域（W1-08）。
 *
 * RuntimeLogEntry 收窄模型（wire normalize 在 infrastructure/runtimeLogContracts）；
 * list 回放 + runtime-log 增量按 id 去重合并（不是按 message 文本）；source/level/search
 * 纯过滤；固定上限环形语义（方案 A：最近 1000 条，防无界 DOM）。
 */

/**
 * OBS-02 统一身份 correlation context（wire `correlation` 的收窄镜像，
 * 方案书 §5.2/§5.14）。LOG-03：normalize 不再丢弃——UI 可见会话身份
 * （OBS-07 P5 correlationDroppedFrontend 闭环）。
 */
export interface RuntimeCorrelation {
  agentId: string
  provider?: string
  source: string
  localSessionId?: string
  remoteSessionId?: string
  periId?: string
  clientGeneration: number
  requestId?: string
  toolCallId?: string
}

export interface RuntimeLogEntry {
  id: number
  timestamp: number
  level: string
  source: string
  session?: string
  message: string
  fields?: Record<string, string>
  /** LOG-03 增量字段（方案书 §5.14）：机器可读错误码（稳定词汇，前端可分支）。 */
  code?: string
  /** LOG-03：日志功能域分类（stderr/frontend 等；监控窗口可按类别分离原始 stderr）。 */
  category?: string
  /** LOG-03：该错误是否可重试/自愈（语义由填充方定义）。 */
  recoverable?: boolean
  /** LOG-03：是否需用户操作介入。 */
  userActionRequired?: boolean
  /** LOG-03：该条是否承载真实原始文本（可能经脱敏；区别于占位符）。 */
  rawAvailable?: boolean
  /** OBS-02：统一身份 correlation context（LOG-03 起 normalize 保留）。 */
  correlation?: RuntimeCorrelation
}

export interface RuntimeLogFilter {
  level?: string
  source?: string
  search?: string
}

export const RUNTIME_LOG_LIMIT = 1000

/** list 回放 + 增量合并：按 id 去重（同一日志 id 不重复），id 倒序，固定上限 */
export function mergeRuntimeLogs(existing: RuntimeLogEntry[], incoming: RuntimeLogEntry[], limit = RUNTIME_LOG_LIMIT): RuntimeLogEntry[] {
  const seen = new Set(existing.map(entry => entry.id))
  const merged = [...existing]
  for (const entry of incoming) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    merged.push(entry)
  }
  merged.sort((a, b) => b.id - a.id)
  return merged.length > limit ? merged.slice(0, limit) : merged
}

/** 纯过滤：level 精确、source 精确、search 大小写不敏感包含（message） */
export function filterRuntimeLogs(entries: RuntimeLogEntry[], filter: RuntimeLogFilter): RuntimeLogEntry[] {
  const search = filter.search?.trim().toLowerCase()
  return entries.filter(entry =>
    (!filter.level || entry.level === filter.level)
    && (!filter.source || entry.source === filter.source)
    && (!search || entry.message.toLowerCase().includes(search))
  )
}

/** 去重后的 level/source 集合（过滤控件选项，顺序稳定） */
export function collectRuntimeLogFacets(entries: RuntimeLogEntry[]): { levels: string[]; sources: string[] } {
  const levels = new Set<string>()
  const sources = new Set<string>()
  for (const entry of entries) {
    if (entry.level) levels.add(entry.level)
    if (entry.source) sources.add(entry.source)
  }
  const order: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 }
  return {
    levels: [...levels].sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9)),
    sources: [...sources].sort(),
  }
}
// ── W1-09：crashed/error 本地诊断 marker（不伪造成后端日志，独立卡片展示） ──

export interface CrashMarker {
  key: string
  agentId: string
  status: string
  detail?: string
  at: number
}

export interface AgentStatusLike {
  status: string
  recentError?: string
  generation?: number
}

export const CRASH_MARKER_LIMIT = 20

/** 从 agentStatuses 派生 crashed/error 本地诊断 marker；按 agentId:status:generation 去重 */
export function deriveCrashMarkers(
  previous: readonly CrashMarker[],
  statuses: Record<string, AgentStatusLike | undefined>,
  now = Date.now(),
): CrashMarker[] {
  const known = new Set(previous.map(marker => marker.key))
  const next: CrashMarker[] = [...previous]
  for (const [agentId, status] of Object.entries(statuses)) {
    if (!status || (status.status !== 'crashed' && status.status !== 'error')) continue
    const key = `${agentId}:${status.status}:${status.generation ?? 0}`
    if (known.has(key)) continue
    known.add(key)
    next.push({
      key,
      agentId,
      status: status.status,
      ...(status.recentError ? { detail: status.recentError } : {}),
      at: now,
    })
  }
  return next.length > CRASH_MARKER_LIMIT ? next.slice(-CRASH_MARKER_LIMIT) : next
}
