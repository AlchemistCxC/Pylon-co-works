/**
 * Browser library — small, renderer-owned persistence for browser affordances.
 *
 * The native WebView manager deliberately remains an ephemeral page/session host.
 * History, bookmarks, download attempts, and the operation console are user-facing
 * library data, so keeping them in a versioned local store makes the same contract
 * work in Tauri and the iframe preview without leaking cookies or page storage.
 */

export interface HistoryEntry {
  readonly id: string
  readonly url: string
  readonly title?: string
  readonly visitedAt: number
}

export interface BookmarkEntry {
  readonly id: string
  readonly url: string
  readonly title?: string
  readonly createdAt: number
}

export type DownloadStatus = 'started' | 'failed'

export interface DownloadEntry {
  readonly id: string
  readonly url: string
  readonly filename?: string
  readonly status: DownloadStatus
  readonly error?: string
  readonly startedAt: number
}

export type ConsoleLevel = 'info' | 'success' | 'error'

export interface ConsoleEntry {
  readonly id: string
  readonly at: number
  readonly level: ConsoleLevel
  readonly command: string
  readonly detail?: string
}

export interface BrowserLibrary {
  readonly version: 1
  readonly history: readonly HistoryEntry[]
  readonly bookmarks: readonly BookmarkEntry[]
  readonly downloads: readonly DownloadEntry[]
  readonly console: readonly ConsoleEntry[]
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export const BROWSER_LIBRARY_STORAGE_KEY = 'pylon.browser.library.v1'
export const MAX_HISTORY_ENTRIES = 200
export const MAX_BOOKMARK_ENTRIES = 200
export const MAX_DOWNLOAD_ENTRIES = 100
export const MAX_CONSOLE_ENTRIES = 300

export function createEmptyBrowserLibrary(): BrowserLibrary {
  return { version: 1, history: [], bookmarks: [], downloads: [], console: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteTime(value: unknown, fallback: number): number {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : NaN
  return Number.isFinite(candidate) && candidate >= 0 && candidate <= Number.MAX_SAFE_INTEGER
    ? candidate
    : fallback
}

function normalizedUrl(value: unknown): string | undefined {
  const url = nonEmptyString(value)
  return url && isBrowserLibraryUrl(url) ? url : undefined
}

/** Restrict library entries to navigable web URLs; never persist javascript/data/file. */
export function isBrowserLibraryUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function stableId(prefix: string, url: string, at: number): string {
  // IDs are only local rendering keys.  Include a readable prefix and avoid crypto
  // so the preview/test runtime has no additional dependency.
  return `${prefix}-${at.toString(36)}-${encodeURIComponent(url).slice(0, 48)}`
}

function normalizeHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    if (!isRecord(item)) return null
    const url = normalizedUrl(item.url)
    if (!url || !isBrowserLibraryUrl(url)) return null
    const visitedAt = finiteTime(item.visitedAt ?? item.visited_at, Date.now() - index)
    return {
      id: nonEmptyString(item.id) ?? stableId('history', url, visitedAt),
      url,
      ...(nonEmptyString(item.title) ? { title: item.title } : {}),
      visitedAt,
    }
  }).filter((item): item is HistoryEntry => item !== null)
}

function normalizeBookmarks(value: unknown): BookmarkEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!isRecord(item)) return null
    const url = normalizedUrl(item.url)
    if (!url || !isBrowserLibraryUrl(url)) return null
    if (seen.has(url)) return null
    seen.add(url)
    const createdAt = finiteTime(item.createdAt ?? item.created_at, Date.now() - index)
    return {
      id: nonEmptyString(item.id) ?? stableId('bookmark', url, createdAt),
      url,
      ...(nonEmptyString(item.title) ? { title: item.title } : {}),
      createdAt,
    }
  }).filter((item): item is BookmarkEntry => item !== null)
}

function normalizeDownloads(value: unknown): DownloadEntry[] {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    if (!isRecord(item)) return null
    const url = normalizedUrl(item.url)
    if (!url || !isBrowserLibraryUrl(url)) return null
    const startedAt = finiteTime(item.startedAt ?? item.started_at, Date.now() - index)
    const status: DownloadStatus = item.status === 'failed' ? 'failed' : 'started'
    return {
      id: nonEmptyString(item.id) ?? stableId('download', url, startedAt),
      url,
      ...(nonEmptyString(item.filename) ? { filename: item.filename } : {}),
      status,
      ...(nonEmptyString(item.error) ? { error: item.error } : {}),
      startedAt,
    }
  }).filter((item): item is DownloadEntry => item !== null)
}

function normalizeConsole(value: unknown): ConsoleEntry[] {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    if (!isRecord(item)) return null
    const command = nonEmptyString(item.command)
    if (!command) return null
    const at = finiteTime(item.at, Date.now() - index)
    const level: ConsoleLevel = item.level === 'error' ? 'error' : item.level === 'success' ? 'success' : 'info'
    return {
      id: nonEmptyString(item.id) ?? stableId('console', command, at),
      at,
      level,
      command,
      ...(nonEmptyString(item.detail) ? { detail: item.detail } : {}),
    }
  }).filter((item): item is ConsoleEntry => item !== null)
}

export function normalizeBrowserLibrary(value: unknown): BrowserLibrary {
  if (!isRecord(value)) return createEmptyBrowserLibrary()
  return {
    version: 1,
    history: normalizeHistory(value.history).sort((a, b) => b.visitedAt - a.visitedAt).slice(0, MAX_HISTORY_ENTRIES),
    bookmarks: normalizeBookmarks(value.bookmarks).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_BOOKMARK_ENTRIES),
    downloads: normalizeDownloads(value.downloads).sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_DOWNLOAD_ENTRIES),
    console: normalizeConsole(value.console).sort((a, b) => b.at - a.at).slice(0, MAX_CONSOLE_ENTRIES),
  }
}

export function loadBrowserLibrary(storage?: StorageLike): BrowserLibrary {
  const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (!target) return createEmptyBrowserLibrary()
  try {
    const raw = target.getItem(BROWSER_LIBRARY_STORAGE_KEY)
    return raw ? normalizeBrowserLibrary(JSON.parse(raw)) : createEmptyBrowserLibrary()
  } catch {
    return createEmptyBrowserLibrary()
  }
}

export function saveBrowserLibrary(library: BrowserLibrary, storage?: StorageLike): void {
  const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
  if (!target) return
  try { target.setItem(BROWSER_LIBRARY_STORAGE_KEY, JSON.stringify(normalizeBrowserLibrary(library))) } catch { /* quota/private mode */ }
}

export function recordHistory(
  library: BrowserLibrary,
  entry: { url: string; title?: string; visitedAt?: number },
): BrowserLibrary {
  const url = normalizedUrl(entry.url)
  if (!url) return library
  const visitedAt = finiteTime(entry.visitedAt, Date.now())
  const existing = library.history.find(item => item.url === url)
  const next: HistoryEntry = {
    id: existing?.id ?? stableId('history', url, visitedAt),
    url,
    ...(entry.title?.trim() || existing?.title ? { title: entry.title?.trim() || existing?.title } : {}),
    visitedAt,
  }
  return { ...library, history: [next, ...library.history.filter(item => item.url !== url)].slice(0, MAX_HISTORY_ENTRIES) }
}

export function toggleBookmark(
  library: BrowserLibrary,
  entry: { url: string; title?: string; createdAt?: number },
): { library: BrowserLibrary; bookmarked: boolean } {
  const url = normalizedUrl(entry.url)
  if (!url) return { library, bookmarked: false }
  const existing = library.bookmarks.find(item => item.url === url)
  if (existing) return { library: { ...library, bookmarks: library.bookmarks.filter(item => item.url !== url) }, bookmarked: false }
  const createdAt = finiteTime(entry.createdAt, Date.now())
  const bookmark: BookmarkEntry = {
    id: stableId('bookmark', url, createdAt),
    url,
    ...(entry.title?.trim() ? { title: entry.title.trim() } : {}),
    createdAt,
  }
  return { library: { ...library, bookmarks: [bookmark, ...library.bookmarks].slice(0, MAX_BOOKMARK_ENTRIES) }, bookmarked: true }
}

export function recordDownload(
  library: BrowserLibrary,
  entry: { url: string; filename?: string; status?: DownloadStatus; error?: string; startedAt?: number },
): BrowserLibrary {
  const url = normalizedUrl(entry.url)
  if (!url) return library
  const startedAt = finiteTime(entry.startedAt, Date.now())
  const status: DownloadStatus = entry.status === 'failed' ? 'failed' : 'started'
  const download: DownloadEntry = {
    id: stableId('download', url, startedAt),
    url,
    ...(entry.filename?.trim() ? { filename: entry.filename.trim() } : {}),
    status,
    ...(entry.error?.trim() ? { error: entry.error.trim() } : {}),
    startedAt,
  }
  return { ...library, downloads: [download, ...library.downloads].slice(0, MAX_DOWNLOAD_ENTRIES) }
}

export function appendConsole(
  library: BrowserLibrary,
  entry: { command: string; level?: ConsoleLevel; detail?: string; at?: number },
): BrowserLibrary {
  const command = entry.command.trim()
  if (!command) return library
  const at = finiteTime(entry.at, Date.now())
  const level: ConsoleLevel = entry.level === 'error' ? 'error' : entry.level === 'success' ? 'success' : 'info'
  const item: ConsoleEntry = {
    id: stableId('console', command, at),
    at,
    level,
    command,
    ...(entry.detail?.trim() ? { detail: entry.detail.trim() } : {}),
  }
  return { ...library, console: [item, ...library.console].slice(0, MAX_CONSOLE_ENTRIES) }
}

export function clearBrowserCollection(library: BrowserLibrary, collection: 'history' | 'bookmarks' | 'downloads' | 'console'): BrowserLibrary {
  return { ...library, [collection]: [] } as BrowserLibrary
}
