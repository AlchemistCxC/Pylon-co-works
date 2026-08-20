/**
 * 搜索 provider 契约（施工方案书 v3 §M7）：search.provider 扩展点。
 *
 * 契约层不 import domains；运行时搜索经 domains/search/searchService（legacy 查询面）。
 * 插件贡献的 provider 在 activate/deactivate 时同步进 legacy registry。
 */

/** search.provider 扩展点 id。 */
export const SEARCH_PROVIDER_POINT = 'search.provider'

export type SearchProviderMode = 'tauri' | 'browser' | 'all'

/** search.provider 贡献 impl：一个可替换的跨会话搜索实现。 */
export interface SearchProvider {
  readonly providerId: string
  readonly mode: SearchProviderMode
  search(query: string): Promise<{ results: readonly unknown[]; truncated: boolean }>
}
