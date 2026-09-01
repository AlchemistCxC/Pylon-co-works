// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendConsole,
  clearBrowserCollection,
  createEmptyBrowserLibrary,
  isBrowserLibraryUrl,
  loadBrowserLibrary,
  MAX_BOOKMARK_ENTRIES,
  MAX_HISTORY_ENTRIES,
  normalizeBrowserLibrary,
  recordDownload,
  recordHistory,
  saveBrowserLibrary,
  toggleBookmark,
} from '../browserLibrary.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('browserLibrary', () => {
  beforeEach(() => localStorage.clear())

  it('只接受 http(s) URL', () => {
    expect(isBrowserLibraryUrl('https://example.com/a')).toBe(true)
    expect(isBrowserLibraryUrl('http://localhost:3000')).toBe(true)
    expect(isBrowserLibraryUrl('javascript:alert(1)')).toBe(false)
    expect(isBrowserLibraryUrl('file:///tmp/a')).toBe(false)
  })

  it('历史按 URL 去重并把最近访问放在首位', () => {
    let library = createEmptyBrowserLibrary()
    library = recordHistory(library, { url: 'https://example.com', title: 'Example', visitedAt: 10 })
    library = recordHistory(library, { url: 'https://other.test', visitedAt: 20 })
    library = recordHistory(library, { url: 'https://example.com', title: 'Example updated', visitedAt: 30 })
    expect(library.history).toHaveLength(2)
    expect(library.history[0]).toMatchObject({ url: 'https://example.com', title: 'Example updated', visitedAt: 30 })
  })

  it('书签切换幂等，下载和控制台可持久化', () => {
    const storage = memoryStorage()
    let library = createEmptyBrowserLibrary()
    const added = toggleBookmark(library, { url: 'https://example.com', title: 'Example', createdAt: 1 })
    expect(added.bookmarked).toBe(true)
    library = added.library
    const removed = toggleBookmark(library, { url: 'https://example.com', createdAt: 2 })
    expect(removed.bookmarked).toBe(false)
    library = recordDownload(added.library, { url: 'https://example.com/file.txt', filename: 'file.txt', startedAt: 2 })
    library = appendConsole(library, { command: 'browser_snapshot', level: 'success', at: 3, detail: 'ok' })
    saveBrowserLibrary(library, storage)
    const restored = loadBrowserLibrary(storage)
    expect(restored.bookmarks).toHaveLength(1)
    expect(restored.downloads[0]).toMatchObject({ status: 'started', filename: 'file.txt' })
    expect(restored.console[0]).toMatchObject({ command: 'browser_snapshot', level: 'success' })
  })

  it('清空单个 collection 不影响其余数据', () => {
    let library = recordHistory(createEmptyBrowserLibrary(), { url: 'https://example.com', visitedAt: 1 })
    library = appendConsole(library, { command: 'x', at: 2 })
    const next = clearBrowserCollection(library, 'history')
    expect(next.history).toHaveLength(0)
    expect(next.console).toHaveLength(1)
  })

  it('从损坏 localStorage 安全回退为空库', () => {
    const storage = memoryStorage()
    storage.setItem('pylon.browser.library.v1', '{not-json')
    expect(loadBrowserLibrary(storage)).toEqual(createEmptyBrowserLibrary())
  })

  it('归一化会过滤危险 URL、重复书签并接受数字时间字符串', () => {
    const before = Date.now()
    const normalized = normalizeBrowserLibrary({
      history: [
        { url: ' https://example.com/path ', visitedAt: '42' },
        { url: 'javascript:alert(1)', visitedAt: 1 },
        { url: 'https://example.com/path', visitedAt: Number.NaN },
      ],
      bookmarks: [
        { url: 'https://example.com', createdAt: '7' },
        { url: 'https://example.com', createdAt: 8 },
        { url: 'file:///tmp/nope', createdAt: 9 },
      ],
    })
    expect(normalized.history.find(item => item.visitedAt === 42)).toMatchObject({ url: 'https://example.com/path' })
    expect(normalized.history).toHaveLength(2)
    expect(normalized.bookmarks).toHaveLength(1)
    expect(normalized.bookmarks[0]?.createdAt).toBe(7)
    const repairedTimestamp = normalized.history.find(item => item.visitedAt !== 42)?.visitedAt
    expect(repairedTimestamp).toBeGreaterThanOrEqual(before - 1000)
  })

  it('写入 API 会 trim URL、限制时间范围并拒绝非法状态', () => {
    let library = createEmptyBrowserLibrary()
    library = recordHistory(library, { url: '  https://example.com  ', visitedAt: -1 })
    expect(library.history[0]?.url).toBe('https://example.com')
    expect(library.history[0]?.visitedAt).toBeGreaterThan(0)
    const bookmark = toggleBookmark(library, { url: ' https://example.com ', createdAt: 5 })
    expect(bookmark.bookmarked).toBe(true)
    const duplicate = toggleBookmark(bookmark.library, { url: 'https://example.com' })
    expect(duplicate.bookmarked).toBe(false)
    library = recordDownload(bookmark.library, { url: 'https://example.com/a', status: 'unexpected' as never, startedAt: -2 })
    expect(library.downloads[0]?.status).toBe('started')
    library = appendConsole(library, { command: 'x', level: 'unexpected' as never, at: -2 })
    expect(library.console[0]?.level).toBe('info')
  })

  it('归一化保留集合上限，避免 localStorage 无界增长', () => {
    const history = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, index) => ({
      url: `https://example.com/${index}`,
      visitedAt: index,
    }))
    const bookmarks = Array.from({ length: MAX_BOOKMARK_ENTRIES + 5 }, (_, index) => ({
      url: `https://example.com/bookmark/${index}`,
      createdAt: index,
    }))
    const normalized = normalizeBrowserLibrary({ history, bookmarks })
    expect(normalized.history).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(normalized.bookmarks).toHaveLength(MAX_BOOKMARK_ENTRIES)
  })
})
