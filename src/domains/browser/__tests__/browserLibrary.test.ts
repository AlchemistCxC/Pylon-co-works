// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendConsole,
  clearBrowserCollection,
  createEmptyBrowserLibrary,
  isBrowserLibraryUrl,
  loadBrowserLibrary,
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
})
