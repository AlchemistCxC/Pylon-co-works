/**
 * persistedSessions — 最近会话恢复纯域（W1-06）。
 *
 * 宽容 normalize list_persisted_sessions 原始响应（agent 返回形状漂移：未知项跳过不崩）；
 * 按 updatedAt 倒序取最近 N 个（updatedAt 数字/字符串/缺失均稳定 fallback，不 NaN）。
 */

export interface PersistedSessionSummary {
  id: string
  source?: string
  title?: string
  periId?: string
  updatedAt: number
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function toTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

export function normalizePersistedSessions(raw: unknown): PersistedSessionSummary[] {
  if (!Array.isArray(raw)) return []
  const entries: PersistedSessionSummary[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined
    if (!id) continue
    entries.push({
      id,
      ...(typeof item.source === 'string' && item.source.length > 0 ? { source: item.source } : {}),
      ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
      ...(typeof item.periId === 'string' && item.periId.length > 0 ? { periId: item.periId } : {}),
      updatedAt: toTimestamp(item.updatedAt),
    })
  }
  return entries
}

/** 按 updatedAt 倒序取最近 N 个（缺省 5）；缺失时间戳排最后（稳定 fallback） */
export function recentPersistedSessions(raw: unknown, limit = 5): PersistedSessionSummary[] {
  return normalizePersistedSessions(raw)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}
