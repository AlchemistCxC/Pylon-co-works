import { noteMarkdownParseCacheHit, noteMarkdownParseDone, noteMarkdownParseSkipped } from './markdownParseCounters.ts'

export type MarkdownRenderNode = MarkdownRoot | MarkdownElement | MarkdownText

export interface MarkdownRoot {
  type: 'root'
  children: readonly MarkdownRenderNode[]
}

export interface MarkdownElement {
  type: 'element'
  tagName: string
  properties: Readonly<Record<string, unknown>>
  children: readonly MarkdownRenderNode[]
}

export interface MarkdownText {
  type: 'text'
  value: string
}

const renderModelCache = new Map<string, Promise<MarkdownRoot>>()
const MAX_CACHE_ENTRIES = 128

/** 被取代而跳过解析时返回的空模型：调用方必然丢弃它，因此内容不参与渲染。 */
const SKIPPED_MARKDOWN_ROOT: MarkdownRoot = { type: 'root', children: [] }

export interface MarkdownRenderModelOptions {
  /**
   * P57 S3-A11：`{ cache: false }` 绕过 LRU（流式增长尾块的中间态文本永不复用，
   * 只会挤掉 stable 块的缓存条目）。签名向后兼容：不传 options 时行为不变。
   */
  readonly cache?: boolean
  /**
   * #148 解析请求「最新即胜」：回答「这次请求是否仍是调用方当前需要的那一个」。为假说明结果
   * 必被调用方丢弃（Solid 的 `createResource` 只在 `pr === p` 时提交），解析整段文本纯属浪费。
   *
   * 跳过返回空模型，因此**不会**进 LRU（见 `getMarkdownRenderModel` 的撤销逻辑），调用方无需自觉。
   */
  readonly isCurrent?: () => boolean
}

/** 取一次文本的渲染模型（命中 LRU 时复用 pending promise，不重解析）。 */
export function getMarkdownRenderModel(
  markdown: string,
  options: MarkdownRenderModelOptions = {},
): Promise<MarkdownRoot> {
  const cached = renderModelCache.get(markdown)
  if (cached) {
    renderModelCache.delete(markdown)
    renderModelCache.set(markdown, cached)
    noteMarkdownParseCacheHit()
    return cached
  }

  const pending = buildMarkdownRenderModel(markdown, options.isCurrent)
  if (options.cache !== false) {
    renderModelCache.set(markdown, pending)
    while (renderModelCache.size > MAX_CACHE_ENTRIES) {
      const oldest = renderModelCache.keys().next().value
      if (oldest === undefined) break
      renderModelCache.delete(oldest)
    }
    // 跳过（哨兵）的结果不得留在缓存里：它不含任何内容，留着会让同文本的其他行渲染成空。
    // 按身份撤销，避免误删后来者写入的同名条目。
    pending.then(
      model => {
        if (model === SKIPPED_MARKDOWN_ROOT && renderModelCache.get(markdown) === pending) renderModelCache.delete(markdown)
      },
      () => {},
    )
  }
  return pending
}

export function clearMarkdownRenderModelCache(): void {
  renderModelCache.clear()
}

async function buildMarkdownRenderModel(
  markdown: string,
  isCurrent?: () => boolean,
): Promise<MarkdownRoot> {
  // #148：已被取代的请求，其结果必被调用方丢弃（`createResource` 只在 `pr === p` 时提交），
  // 这里让出一次微任务再复查判据——一 tick 内多次发布（token 级切片、终态重发、resume）时，
  // 中间态就在这一步被挡下，既不加载模块也不碰解析器。
  //
  // 放在动态 import **之前**：判据只读调用方的当前文本，与模块加载无因果；而解析调用链的开销
  // 在测试环境里大头是模块加载路径（百毫秒量级）而非解析本身（0.2ms 量级），放在 import 之后
  // 会让跳过的请求仍然付这笔钱。
  if (isCurrent !== undefined) {
    await Promise.resolve()
    if (!isCurrent()) {
      noteMarkdownParseSkipped()
      return SKIPPED_MARKDOWN_ROOT
    }
  }

  const [
    { unified },
    { default: remarkParse },
    { default: remarkGfm },
    { default: remarkRehype },
  ] = await Promise.all([
    import('unified'),
    import('remark-parse'),
    import('remark-gfm'),
    import('remark-rehype'),
  ])

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)

  // 只读成本读数（#148）：只算解析器内耗时，不含模块加载——它是「长单块是否值得进一步优化」的判据。
  const startedAt = performance.now()
  const mdast = processor.parse(markdown)
  const hast = await processor.run(mdast)
  noteMarkdownParseDone({ durationMs: performance.now() - startedAt, textLength: markdown.length })
  return normalizeRoot(hast)
}

function normalizeRoot(value: unknown): MarkdownRoot {
  if (!isRecord(value) || value.type !== 'root') return { type: 'root', children: [] }
  return {
    type: 'root',
    children: normalizeChildren(value.children),
  }
}

function normalizeChildren(value: unknown): readonly MarkdownRenderNode[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(normalizeNode)
}

function normalizeNode(value: unknown): MarkdownRenderNode[] {
  if (!isRecord(value)) return []
  if (value.type === 'text') {
    return [{ type: 'text', value: typeof value.value === 'string' ? value.value : '' }]
  }
  if (value.type !== 'element' || typeof value.tagName !== 'string') return []
  return [{
    type: 'element',
    tagName: value.tagName,
    properties: isRecord(value.properties) ? { ...value.properties } : {},
    children: normalizeChildren(value.children),
  }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
