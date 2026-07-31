import { createStarryNight, type Grammar } from '@wooorm/starry-night'
import { toHtml } from 'hast-util-to-html'

const LANGUAGE_SCOPES: Record<string, string> = {
  js: 'source.js', javascript: 'source.js', jsx: 'source.js',
  ts: 'source.ts', typescript: 'source.ts', tsx: 'source.tsx',
  py: 'source.python', python: 'source.python',
  rs: 'source.rust', rust: 'source.rust',
  go: 'source.go', java: 'source.java',
  c: 'source.c', cpp: 'source.c++', cxx: 'source.c++',
  css: 'source.css', json: 'source.json', yaml: 'source.yaml', yml: 'source.yaml',
  sh: 'source.shell', shell: 'source.shell', bash: 'source.shell',
  html: 'text.html.basic', markup: 'text.html.basic',
}

const GRAMMAR_LOADERS: Record<string, () => Promise<{ default: Grammar }>> = {
  'source.js': () => import('@wooorm/starry-night/source.js'),
  'source.ts': () => import('@wooorm/starry-night/source.ts'),
  'source.tsx': () => import('@wooorm/starry-night/source.tsx'),
  'source.python': () => import('@wooorm/starry-night/source.python'),
  'source.rust': () => import('@wooorm/starry-night/source.rust'),
  'source.go': () => import('@wooorm/starry-night/source.go'),
  'source.java': () => import('@wooorm/starry-night/source.java'),
  'source.c': () => import('@wooorm/starry-night/source.c'),
  'source.c++': () => import('@wooorm/starry-night/source.c++'),
  'source.css': () => import('@wooorm/starry-night/source.css'),
  'source.json': () => import('@wooorm/starry-night/source.json'),
  'source.yaml': () => import('@wooorm/starry-night/source.yaml'),
  'source.shell': () => import('@wooorm/starry-night/source.shell'),
  'text.html.basic': () => import('@wooorm/starry-night/text.html.basic'),
}

const highlighters = new Map<string, Promise<Awaited<ReturnType<typeof createStarryNight>>>>()
const highlightCache = new Map<string, string | null>()
const highlightPending = new Map<string, Promise<string | null>>()
const MAX_HIGHLIGHT_CACHE_ENTRIES = 128

function cacheKey(language: string, code: string): string {
  return `${language.toLowerCase()}\u0000${code}`
}

function cacheResult(key: string, value: string | null): string | null {
  highlightCache.delete(key)
  highlightCache.set(key, value)
  while (highlightCache.size > MAX_HIGHLIGHT_CACHE_ENTRIES) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    highlightCache.delete(oldest)
  }
  return value
}

export function scopeForLanguage(language: string): string | undefined {
  return LANGUAGE_SCOPES[language.toLowerCase()]
}

export async function highlightCode(language: string, code: string): Promise<string | null> {
  const key = cacheKey(language, code)
  if (highlightCache.has(key)) {
    const cached = highlightCache.get(key) ?? null
    highlightCache.delete(key)
    highlightCache.set(key, cached)
    return cached
  }
  const pending = highlightPending.get(key)
  if (pending) return pending

  const result = highlightCodeUncached(language, code)
  highlightPending.set(key, result)
  try {
    return await result
  } finally {
    highlightPending.delete(key)
  }
}

async function highlightCodeUncached(language: string, code: string): Promise<string | null> {
  const scope = scopeForLanguage(language)
  const load = scope && GRAMMAR_LOADERS[scope]
  if (!scope || !load) return cacheResult(cacheKey(language, code), null)
  let highlighter = highlighters.get(scope)
  if (!highlighter) {
    highlighter = load().then(({ default: grammar }) => createStarryNight([grammar]))
    highlighters.set(scope, highlighter)
  }
  const starry = await highlighter
  return cacheResult(cacheKey(language, code), toHtml(starry.highlight(code, scope)))
}

export function clearHighlightCache(): void {
  highlightCache.clear()
  highlightPending.clear()
}
