/**
 * searchService — 跨会话搜索统一入口。
 *
 * A1-c P5/B6：Tauri 模式分两阶段 canonical 搜索——后端 evt_search 在
 * raw/typed payload + eventType 上 LIKE 出候选 owner（limit 50），前端对候选
 * owner loadAll → projectMessagesFromCanonical → 消息文本精确匹配（不再逐会话
 * 全量拉取，也不再依赖 messages 表 / msg_search（B7 已删除该命令）。
 * browser 模式回退本地快照扫描（snapshotSearch）。
 */
import { IS_TAURI } from '../../infrastructure/tauri/env.ts'
import { useIdentityStore, type Session } from '../../identityStore.ts'
import { reportRuntimeError } from '../../runtimeError.ts'
import { getMessageSearchText } from '../../components/chat/messageSearchIndex.ts'
import { toCanonicalOwnerKey, type CanonicalEventOwner } from '../events/eventSchema.ts'
import { projectMessagesFromCanonical } from '../events/messageProjection.ts'
import { tauriCanonicalEventRepository } from '../../infrastructure/events/canonicalEventRepository.ts'
import { collectSnapshotKeys, snapshotSearch, type SnapshotSearchResult } from './snapshotSearch.ts'
import type { SearchProvider } from '../../contracts/searchProvider.ts'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'

/** 单次搜索返回上限（同 limit 语义；达上限视为截断）。 */
export const BACKEND_SEARCH_LIMIT = 50

/** UI 搜索命中：统一形状（含 owner agentId 供 owner-aware 导航）。 */
export type SearchHitUi = SnapshotSearchResult & { agentId?: string; snippet: string }

/** Unicode 安全 snippet：命中处前后 40 字符（不劈代理对/组合字符）。 */
function snippetAround(text: string, needle: string): string {
  const lower = text.toLocaleLowerCase()
  const index = lower.indexOf(needle.toLocaleLowerCase())
  if (index < 0) return text.slice(0, 120)
  const radius = 40
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + needle.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Tauri 模式：两阶段 canonical 搜索（内置实现，core.search.tauri 包装）。 */
export async function searchAllMessagesTauri(query: string): Promise<{ results: SearchHitUi[]; truncated: boolean }> {
  const needle = query.trim()
  if (!needle) return { results: [], truncated: false }
  const sessions = useIdentityStore.getState().sessions
  const repository = tauriCanonicalEventRepository()
  const sessionByOwner = new Map<string, Session>()
  for (const session of sessions) {
    sessionByOwner.set(toCanonicalOwnerKey({
      profileId: session.profileId,
      agentId: session.agentId,
      localSessionId: session.source,
    }), session)
  }
  // 阶段 1：后端内容 LIKE 出候选 owner（payload/eventType；不做消息级语义）
  let candidates: CanonicalEventOwner[] = []
  try {
    candidates = await repository.searchOwners(needle, BACKEND_SEARCH_LIMIT)
  } catch (error) {
    reportRuntimeError('canonical 内容搜索失败', error)
  }
  // 阶段 2：候选 owner 全量投影后按消息搜索文本精确匹配
  const loaded = await Promise.all(candidates.map(async owner => {
    const ownerKey = toCanonicalOwnerKey(owner)
    const session = sessionByOwner.get(ownerKey)
    if (!session) return null
    try {
      const rows = await repository.loadAll(ownerKey)
      return { session, messages: projectMessagesFromCanonical(rows) }
    } catch (error) {
      reportRuntimeError(`读取 canonical 历史失败（${session.id}）`, error)
      return { session, messages: [] }
    }
  }))
  const results: SearchHitUi[] = []
  for (const item of loaded) {
    if (!item) continue
    const { session, messages } = item
    for (const message of messages) {
      const searchable = getMessageSearchText(message)
      if (!searchable.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) continue
      results.push({
        sessionId: session.id,
        messageId: message.id,
        snippet: snippetAround(searchable, needle),
        time: message.time,
        agentId: session.agentId,
      })
      if (results.length >= BACKEND_SEARCH_LIMIT) {
        return { results, truncated: true }
      }
    }
  }
  return { results, truncated: false }
}

/** browser 模式：本地快照扫描（内置实现，core.search.snapshot 包装）。 */
export async function searchAllMessagesSnapshot(query: string): Promise<{ results: SearchHitUi[]; truncated: boolean }> {
  const needle = query.trim()
  if (!needle) return { results: [], truncated: false }
  const { results, truncated } = snapshotSearch(localStorage, needle, collectSnapshotKeys())
  return { results, truncated }
}

/** 无插件回退：按运行时环境选择内置实现。 */
export async function searchAllMessagesBuiltin(query: string): Promise<{ results: SearchHitUi[]; truncated: boolean }> {
  return IS_TAURI ? searchAllMessagesTauri(query) : searchAllMessagesSnapshot(query)
}

/**
 * 跨会话搜索（统一入口）。旧响应不覆盖新 query 由调用方（SearchSheetView）用
 * request generation 保证。
 */
export async function searchAllMessages(query: string): Promise<{ results: SearchHitUi[]; truncated: boolean }> {
  const providers = getPluginServiceRegistry().list<SearchProvider>('search')
  const mode = IS_TAURI ? 'tauri' : 'browser'
  const provider = providers.find(candidate => candidate.mode === mode)
    ?? providers.find(candidate => candidate.mode === 'all')
  if (!provider) return searchAllMessagesBuiltin(query)
  const result = await provider.search(query)
  return { results: result.results as SearchHitUi[], truncated: result.truncated }
}
