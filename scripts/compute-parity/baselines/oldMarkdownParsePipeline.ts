// ─────────────────────────────────────────────────────────────────────────────
// 【雕刻基线】迁移前的 TS markdown 解析管线（unified/remark，issue #220 WP4）。
//
// 出处：`git show 76cbc819^:src/renderers/solid-workbench/chat/markdownRenderModel.ts`
// 中**纯解析路径**的逐字拷贝：渲染模型类型（原 L8-27）、`normalizeRoot` /
// `normalizeChildren` / `normalizeNode` / `isRecord`（原 L521-548）、
// `buildMarkdownRenderModel` 的 unified 处理器装配与 parse/run 调用（原 L474-510）。
// 剥离的部分（不属于「解析」这一计算面，出处文件里也只服务渲染编排）：
// LRU/settled 缓存、增量 graft、`markdownParseCounters` 观测、`isCurrent` 让位判据。
// 动态 import（unified/remark-*）与包版本逐字保留（依赖仍在 package.json）。
//
// 仅服务 `scripts/compute-parity/` 脚手架，不在任何生产路径。
// 要修解析逻辑请改 Rust 计算核（src-tauri/pylon-markdown，comrak）。
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * 原 `buildMarkdownRenderModel` 的解析核（逐字；只去掉计数与让位判据）：
 * remark-parse（mdast）→ remark-gfm → remark-rehype（hast）→ normalizeRoot。
 */
export async function parseMarkdownTs(markdown: string): Promise<MarkdownRoot> {
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

// ── 以下逐字取自原 L521-548 ──────────────────────────────────────────────────

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
