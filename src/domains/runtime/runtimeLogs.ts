/**
 * runtimeLogs — 运行日志纯域（W1-08）。
 *
 * RuntimeLogEntry 收窄模型（wire normalize 在 infrastructure/runtimeLogContracts）；
 * list 回放 + runtime-log 增量按 id 去重合并（不是按 message 文本）；source/level/search
 * 纯过滤；固定上限环形语义（方案 A：最近 1000 条，防无界 DOM）。
 */

export interface RuntimeLogEntry {
  id: number
  timestamp: number
  level: string
  source: string
  session?: string
  message: string
  fields?: Record<string, string>
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
