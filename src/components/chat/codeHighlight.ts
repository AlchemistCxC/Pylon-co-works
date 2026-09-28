// 代码高亮的**宿主编排层**——issue #241 / ADR-0020 起引擎是 **Lezer**（纯 JS），
// 不再是 Rust/wasm 的 syntect（那套的语法资产占渲染器可控内存 ~30% 且不可归还）。
//
// 本文件保留的是编排：语言同步门、provider 注册面（`highlightCode` 优先走已注册 provider）、
// 结果缓存与并发去重，以及把**行数组**拼回消费方契约的 HTML 串。引擎在 `./lezerHighlight.ts`
// （纯计算：整块代码进、行数组出）。
//
// 出口形状与旧 wasm 出口**逐项一致**（`{ spans: { classes, text } }[]`、未知语言 `null`、
// 源码以 '\n' 收尾时行数组少一个空尾行）——这是「换引擎不动消费方」的前提：三个消费面
// （插件 provider `core.renderer.code-highlight`、聊天代码块、markdown 内嵌代码块）
// 都只经过本文件。（第四个消费面 FileTabView 的只读分支已退役，见 `FileTabView.solid.tsx`。）
import { hasHighlightLanguage, highlightBlockWithLezer, type LezerHighlightedLine } from './lezerHighlight.ts'
import { resolveCodeHighlightProvider } from '../../domains/rendererContent/rendererContentRegistry.ts'

const highlightCache = new Map<string, string | null>()
const highlightPending = new Map<string, Promise<string | null>>()
const MAX_HIGHLIGHT_CACHE_ENTRIES = 128
/**
 * #443：条数预算与字节量脱钩——128 条大块可钉住数十 MB（key 内嵌整段源码，value ≈ 源码
 * 2–3 倍的 HTML）。补**字符预算**（键长即源码长度，与 `markdownRenderModel` 的
 * `MAX_CACHE_CHARS = 2_000_000` 同值同依据）。
 */
const MAX_HIGHLIGHT_CACHE_CHARS = 2_000_000
/**
 * 单条不缓存上限（与 canonical raw 64KiB 同量级）：超限块仍返回结果但不进缓存——
 * 单条 64K 块的 HTML ≈ 192–768 KB，一条就能吃掉总预算的一到三成；超限块重进视口走
 * Lezer 切片重算（可让出、不卡帧），比钉住常驻更划算。
 */
const MAX_HIGHLIGHT_CACHE_ENTRY_CHARS = 65_536
let cachedChars = 0

function cacheKey(language: string, code: string): string {
  return `${language.toLowerCase()}\u0000${code}`
}

function cacheResult(key: string, value: string | null): string | null {
  if (key.length > MAX_HIGHLIGHT_CACHE_ENTRY_CHARS) return value
  // 防御双记（审查轮 P2）：has 前置检查在唯一调用链里保证「key 必不在缓存」，但这里
  // 不依赖它——键已在缓存时先按旧键长退款，cachedChars 才与真实驻留一致。
  if (highlightCache.has(key)) cachedChars -= key.length
  highlightCache.delete(key)
  highlightCache.set(key, value)
  cachedChars += key.length
  while (cachedChars > MAX_HIGHLIGHT_CACHE_CHARS || highlightCache.size > MAX_HIGHLIGHT_CACHE_ENTRIES) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    highlightCache.delete(oldest)
    cachedChars -= oldest.length
  }
  return value
}

/** 只读读数：缓存条数与键字符占用（消费方是单测与探针，先例 `markdownRenderModel.graftBaseStats`）。 */
export function highlightCacheStats(): { readonly entries: number, readonly chars: number } {
  return { entries: highlightCache.size, chars: cachedChars }
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
function lineToHtml(line: LezerHighlightedLine): string {
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
  // 同步语言门：未知语言不穿越引擎直接回落 null（与旧实现同形；判据从 TextMate scope
  // 换成「有没有对应语言包」，两边同一批别名）。
  if (!hasHighlightLanguage(language)) return cacheResult(cacheKey(language, code), null)
  const lines: readonly LezerHighlightedLine[] | undefined = await highlightBlockWithLezer(code, language)
  // 语言已知但语言包缺失 ⇒ 引擎返回 undefined，与 TS 基线「loader 缺失返回 null」同语义。
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
