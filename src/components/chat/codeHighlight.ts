// 代码高亮的计算核出口层——issue #220 WP4 切流后的形态。
//
// 高亮引擎在 Rust 计算核（`src-tauri/pylon-markdown` 的 `highlight_block`，syntect +
// 同源 vendored 语法 + github `pl-*` 类名链，与原 starry-night 基线逐 token parity）。
// 边界约定（spec「边界约定」第 3 条，用户裁决）：**整块代码进、行数组出**——逐行过界
// 禁止。本文件保留的是宿主侧的编排：语言→scope 映射门、provider 注册面（`highlightCode`
// 优先走已注册 provider）、结果缓存与并发去重，以及把行数组拼回消费方契约的 HTML 串。
//
// 产物装载见 `infrastructure/compute/markdownCompute.ts`（Promise 形态；调用点本就异步）。
import { loadMarkdownCompute, type HighlightedLine } from '../../infrastructure/compute/markdownCompute.ts'
import { resolveCodeHighlightProvider } from '../../domains/rendererContent/rendererContentRegistry.ts'

// 语言别名 → TextMate scope。这是**同步门**：未知语言不穿越计算核直接回落 null
// （行为测试钉住映射表本身）；映射的 wasm 侧同表由 WP4 parity 钉死。
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

/** 行内文本转义：与 hast-util-to-html 的文本节点同口径（& < >；引号留在文本里）。 */
function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** 一行 span → HTML 片段（行内不含换行；换行由拼接层按行补）。 */
function lineToHtml(line: HighlightedLine): string {
  let html = ''
  for (const span of line.spans) {
    const text = escapeHtmlText(span.text)
    html += span.classes.length > 0
      ? `<span class="${span.classes.join(' ')}">${text}</span>`
      : text
  }
  return html
}

async function highlightCodeUncached(language: string, code: string): Promise<string | null> {
  const scope = scopeForLanguage(language)
  if (!scope) return cacheResult(cacheKey(language, code), null)
  const { highlightBlock } = await loadMarkdownCompute()
  const lines = highlightBlock(code, language)
  // 语言已知但语法包缺失 ⇒ 计算核返回空，与 TS 基线「loader 缺失返回 null」同语义。
  if (lines === undefined) return cacheResult(cacheKey(language, code), null)
  // 消费方契约：HTML 串按 '\n' 切行后与 `code.split('\n')` 逐行对齐——源码以换行
  // 收尾时行数组少一个空尾行，这里补回，保证行数一致。
  const html = lines.map(lineToHtml).join('\n') + (code.endsWith('\n') ? '\n' : '')
  return cacheResult(cacheKey(language, code), html)
}

/** legacy 查询面 facade：优先走已注册 provider（core 插件），未注册时回退 builtin。 */
export async function highlightCode(language: string, code: string): Promise<string | null> {
  const provider = resolveCodeHighlightProvider(language, code)
  if (!provider) return highlightCodeBuiltin(language, code)
  return provider.highlight(language, code)
}
