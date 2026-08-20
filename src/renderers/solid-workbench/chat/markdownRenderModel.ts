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

export function getMarkdownRenderModel(markdown: string): Promise<MarkdownRoot> {
  const cached = renderModelCache.get(markdown)
  if (cached) {
    renderModelCache.delete(markdown)
    renderModelCache.set(markdown, cached)
    return cached
  }

  const pending = buildMarkdownRenderModel(markdown)
  renderModelCache.set(markdown, pending)
  while (renderModelCache.size > MAX_CACHE_ENTRIES) {
    const oldest = renderModelCache.keys().next().value
    if (oldest === undefined) break
    renderModelCache.delete(oldest)
  }
  return pending
}

export function clearMarkdownRenderModelCache(): void {
  renderModelCache.clear()
}

async function buildMarkdownRenderModel(markdown: string): Promise<MarkdownRoot> {
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

  const mdast = processor.parse(markdown)
  const hast = await processor.run(mdast)
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
