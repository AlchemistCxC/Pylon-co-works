/**
 * persistedSessions — 最近会话恢复纯域（W1-06）。
 *
 * 宽容 normalize `list_persisted_sessions` 原始响应：真机拿到的形状有两个世代——
 * 官方 ACP `ListSessionsResponse`（**包装对象** `{sessions:[…]}`，条目是官方
 * `SessionInfo`：`sessionId`/`cwd`/`title`/`updatedAt`）与 Peri 早期形状（裸数组，
 * 条目 `id`/`source`/`periId`）。此前只认后者的裸数组 + `item.id`，于是官方形状
 * 整批被丢（#396）。未知项跳过不崩；按 updatedAt 倒序取最近 N 个（updatedAt
 * 数字/字符串/缺失均稳定 fallback，不 NaN）。
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

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/** 裸数组（旧）与 `{sessions:[…]}`（官方 `ListSessionsResponse`）都要认。
 *  `nextCursor` 暂不消费——Peri 一次给全量，Hermes 分页（见 #396 遗留）。 */
function persistedSessionItems(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw
  if (isPlainObject(raw) && Array.isArray(raw.sessions)) return raw.sessions
  return []
}

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
  const entries: PersistedSessionSummary[] = []
  for (const item of persistedSessionItems(raw)) {
    if (!isPlainObject(item)) continue
    // 官方 `SessionInfo.sessionId` 就是我们的远端 id（= `periId`）；旧形状另给 `id`。
    const remoteId = nonEmptyString(item.sessionId) ?? nonEmptyString(item.id)
    const id = nonEmptyString(item.id) ?? remoteId
    if (!id || !remoteId) continue
    const source = nonEmptyString(item.source)
    const title = nonEmptyString(item.title)
    entries.push({
      id,
      ...(source ? { source } : {}),
      ...(title ? { title } : {}),
      // 归属解析（`resolveArchivedSessionOwner`）按 source/periId 命中本地行——官方
      // 形状没有 source，落到 periId 这一路。
      periId: nonEmptyString(item.periId) ?? remoteId,
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
