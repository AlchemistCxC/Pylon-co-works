/**
 * core.search.* —— 内置搜索 provider 插件（tauri canonical 两阶段 / browser 快照扫描）。
 *
 * search 方法按需动态 import searchService 的 builtin 分支。
 */
import {
  type SearchProvider,
} from '../../../contracts/searchProvider.ts'

function createBuiltinSearchProvider(kind: 'tauri' | 'browser'): SearchProvider {
  const pluginId = `core.search.${kind === 'browser' ? 'snapshot' : kind}`
  return {
    providerId: pluginId,
    mode: kind,
    search: async query => {
      const { searchAllMessagesSnapshot, searchAllMessagesTauri } = await import('../../../domains/search/searchService.ts')
      const result = kind === 'tauri'
        ? await searchAllMessagesTauri(query)
        : await searchAllMessagesSnapshot(query)
      return { results: result.results, truncated: result.truncated }
    },
  }
}

export const BUILTIN_SEARCH_PROVIDERS = [
  createBuiltinSearchProvider('tauri'),
  createBuiltinSearchProvider('browser'),
] as const
