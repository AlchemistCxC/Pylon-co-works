// 仅类型导入（编译期擦除），运行时零开销：starry-night 核心（vscode-textmate /
// oniguruma wasm 加载器）与 hast-util-to-html 直到首块代码真正高亮时才按需加载，
// 避免把高亮引擎拖进主 chunk。
// S1-CSP：onig.wasm 本地化（?url 让 vite 打包为 asset）——starry-night 默认
// fetch('https://esm.sh/vscode-oniguruma@2/release/onig.wasm') 是远程 CDN 依赖
// （断网/墙内高亮挂 + 被 CSP connect-src 拦截），getOnigurumaUrlFetch 指向本地。
import type { createStarryNight, Grammar } from '@wooorm/starry-night'
import type { toHtml } from 'hast-util-to-html'
import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url'
import { resolveCodeHighlightProvider } from '../../domains/rendererContent/rendererContentRegistry.ts'

type StarryCore = {
  createStarryNight: typeof createStarryNight
  toHtml: typeof toHtml
}

let corePromise: Promise<StarryCore> | null = null

// 经 starryCore 包装模块动态导入：包根直接动态 import 会连带全部语法集，
// 包装模块的具名 re-export 可被 rollup tree-shake，只带核心引擎（textmate/oniguruma）。
// 显式 .ts 扩展名：Node（legacy 测试 runner）与 Vite 均可解析。
function loadCore(): Promise<StarryCore> {
  if (!corePromise) {
    corePromise = import('./starryCore.ts')
      .then(({ createStarryNight: create, toHtml: toHtmlFn }) => ({ createStarryNight: create, toHtml: toHtmlFn }))
  }
  return corePromise
}

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

/** 内置高亮实现（core.renderer.code-highlight 与无插件回退共用）。 */
export async function highlightCodeBuiltin(language: string, code: string): Promise<string | null> {
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
  // 先同步触发核心动态 import（并行于语法包），避免串行等待
  const core = loadCore()
  let highlighter = highlighters.get(scope)
  if (!highlighter) {
    highlighter = load().then(async ({ default: grammar }) => {
      const { createStarryNight: create } = await core
      return create([grammar], {
        getOnigurumaUrlFetch: () => new URL(onigWasmUrl, window.location.href),
      })
    })
    highlighters.set(scope, highlighter)
  }
  const [starry, { toHtml: toHtmlFn }] = await Promise.all([highlighter, core])
  return cacheResult(cacheKey(language, code), toHtmlFn(starry.highlight(code, scope)))
}

/** legacy 查询面 facade：优先走已注册 provider（core 插件），未注册时回退 builtin。 */
export async function highlightCode(language: string, code: string): Promise<string | null> {
  const provider = resolveCodeHighlightProvider(language, code)
  if (!provider) return highlightCodeBuiltin(language, code)
  return provider.highlight(language, code)
}
