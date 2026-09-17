import {
  noteMarkdownParseCacheHit,
  noteMarkdownParseDone,
  noteMarkdownParseGrafted,
  noteMarkdownParseSkipped,
} from './markdownParseCounters.ts'

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
  /**
   * #150 增量 graft：纯文本追加直接拼接上一模型，不跑解析器（判据见 `graftMarkdownModel`）。
   * 默认只在 `cache: false`（增长尾块）路径启用——stable/已提交文本不长个，走 LRU 就够。
   * 传 `false` 强制整段重解析（差分测试的参照路径，也是回滚开关）。
   */
  readonly incremental?: boolean
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

  // #150：增长尾块的纯文本追加直接拼接到上一模型，不跑解析器（判据见 graftMarkdownModel）。
  if (options.cache === false && options.incremental !== false) {
    const grafted = tryGraftMarkdownModel(markdown)
    if (grafted !== null) {
      noteMarkdownParseGrafted()
      return Promise.resolve(grafted)
    }
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
  } else if (options.incremental !== false) {
    // 尾块路径：整段重解析的结果留作下一次 graft 的基座（跳过/失败的请求不留）。
    pending.then(
      model => { if (model !== SKIPPED_MARKDOWN_ROOT) rememberGraftBase(markdown, model) },
      () => {},
    )
  }
  return pending
}

export function clearMarkdownRenderModelCache(): void {
  renderModelCache.clear()
  graftBases.clear()
}

/**
 * #150 增量 graft：增长尾块每收到一个新文本就整段重解析（单个块揭示期间的总解析量约 N²/4 字符；
 * 真机实测一个 3368 字的列表块累计解析 ≈ 3 秒 CPU，是整块一次解析的约 800 倍），而流式揭示里
 * 约九成的发布只是在末尾追加纯文本字符。
 *
 * 只有在**可判定为「纯文本追加」**时（判据见 `graftMarkdownModel`）才把差量拼到上一模型上，其余
 * 一律回退整段重解析——回退只是慢，拼错是渲染漂移，取舍永远偏向后者的反面。
 */
const GRAFT_BASE_LIMIT = 32
/** 取基座时由新到旧最多探测的候选数（同一行的上一状态通常就在最前面）。 */
const GRAFT_BASE_PROBES = 4
/** 叶子尾部守卫窗口：能「被纯文本字符延长」的构造（URL/实体/转义）其触发符都在末尾这几字里。 */
const LEAF_GUARD_WINDOW = 32

/**
 * 允许出现在增量差量里的字符（白名单）：ASCII 字母/数字、半角空格、以及全部非 ASCII 字符。
 *
 * 为什么这样切：CommonMark 的行内/块级构造只由 ASCII 标点触发，行尾只认 U+000A/U+000D，
 * 因此「不含 ASCII 标点与控制字符的追加」不可能改变已有解析的结构（该判据由差分测试看守）。
 * 用白名单而不是黑名单，是为了让控制字符（`\n` `\r` `\t`）与 DEL 天然落在外面。
 */
const PLAIN_DELTA = /^[A-Za-z0-9\u0080-\u{10FFFF} ]+$/u

/**
 * 可参与「被延长」的构造的 ASCII 标点（不含空白）。用于叶子尾部守卫：
 * GFM 自动链接、实体补全、转义补全、未闭合标记的收尾，其触发符都在尾部这几字里。
 */
const EXTENDABLE_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

/** 允许作为 graft 落点的祖先元素：追加纯文本不会改变这些容器的语义（表格单元格同理）。 */
const GRAFT_SAFE_ANCESTORS = new Set([
  'p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'div', 'span', 'ul', 'ol', 'table', 'tbody', 'thead', 'tr',
])

/** 尾块文本 → 已解析模型（MRU）：graft 的基座，只由尾块路径写入。 */
const graftBases = new Map<string, MarkdownRoot>()

function rememberGraftBase(text: string, model: MarkdownRoot): void {
  graftBases.delete(text)
  graftBases.set(text, model)
  while (graftBases.size > GRAFT_BASE_LIMIT) {
    const oldest = graftBases.keys().next().value
    if (oldest === undefined) break
    graftBases.delete(oldest)
  }
}

/** 尝试用基座拼出新文本的模型；没有可用基座（或判据不通过）时返回 null，调用方回退整段重解析。 */
function tryGraftMarkdownModel(text: string): MarkdownRoot | null {
  const candidates = [...graftBases.keys()].reverse()
  let probes = 0
  for (const baseText of candidates) {
    if (probes >= GRAFT_BASE_PROBES) break
    if (baseText.length >= text.length || !text.startsWith(baseText)) continue
    probes += 1
    const baseModel = graftBases.get(baseText)
    if (baseModel === undefined) continue
    const grafted = graftMarkdownModel(baseText, baseModel, text)
    if (grafted === null) continue
    rememberGraftBase(text, grafted)
    return grafted
  }
  return null
}

/**
 * 增量拼接的**全部判据**（任一不成立即返回 null）：
 *
 * 1. 新文本是基座的严格后继，差量非空；
 * 2. 差量不含可触发 markdown 构造的字符（见 `STRUCTURAL_CHAR`）——追加的确实是纯文本；
 * 3. 基座文本不以换行结尾（行首是块级构造的触发位，此时差量还可能开启新块）；
 * 4. 基座模型的落点是「最右内容文本节点」：每层从后往前跳过纯空白文本节点（列表项之间与列表
 *    结尾的 `"\n"` 是结构分隔符，不是内容落点），且祖先链只含 `GRAFT_SAFE_ANCESTORS` 里的容器
 *    （落在 `a`/`code`/`strong`/`em`/`del` 等行内元素里时，追加会改变该元素语义或属性，
 *    如自动链接的 href）；
 * 5. 差量末尾空白按 CommonMark 的块末剥离规则去掉后再拼接（纯空白差量直接复用基座模型）；
 * 6. 基座文本以该文本节点的值结尾——文档末尾确实落在它内部（以 `**`、`` ` ``、`|`、实体、
 *    转义收尾时该判据自动失败：渲染值与原文不一致）；
 * 7. 该文本节点末尾 `LEAF_GUARD_WINDOW` 字内没有 ASCII 标点（挡住「纯文本字符延长已有构造」：
 *    GFM 自动链接、实体补全、转义补全、未闭合标记的收尾）。
 */
function graftMarkdownModel(baseText: string, baseModel: MarkdownRoot, text: string): MarkdownRoot | null {
  if (!text.startsWith(baseText)) return null
  const delta = text.slice(baseText.length)
  if (delta.length === 0) return null
  if (!PLAIN_DELTA.test(delta)) return null
  if (/[\r\n]$/.test(baseText)) return null
  const spine = rightmostSpine(baseModel)
  if (spine === null) return null
  const { leaf, chain } = spine
  // 落点必须是「会剥掉块内容末尾空白」的容器（p / li / td / th / h1-h6 …）——下面的剥离规则依赖它。
  for (const step of chain) {
    const container = step.container
    if (container.type === 'element' && !GRAFT_SAFE_ANCESTORS.has(container.tagName)) return null
  }
  // CommonMark 会剥掉块内容的末尾空白（`The ` 解析出来是 `The`），拼接时同样剥掉，
  // 否则与整段重解析差一个空格——差分测试逮到过这一条。纯空白差量因此不产生任何内容。
  const appended = delta.replace(/\s+$/u, '')
  if (appended.length === 0) return baseModel
  if (!baseText.endsWith(leaf.value)) return null
  if (EXTENDABLE_PUNCTUATION.test(leaf.value.slice(-LEAF_GUARD_WINDOW))) return null
  return rebuildSpine(chain, leaf, appended)
}

interface GraftSpine {
  readonly leaf: MarkdownText
  /** 从根到叶子父节点的链：每层的容器与该层所选子节点的下标。 */
  readonly chain: readonly { readonly container: MarkdownRoot | MarkdownElement; readonly index: number }[]
}

/**
 * 取「最右内容叶子」的脊线：每层从后往前找第一个**非纯空白文本**的子节点。
 *
 * 为什么要跳过纯空白文本节点：remark-rehype 会在列表项之间与列表结尾补 `"\n"` 文本节点，
 * 它们是结构分隔符而不是内容落点——追加进去会把文字塞进分隔符里（差分测试逮到过这一条）。
 * 最右内容叶子不是文本节点（如以 `<hr>`/`<img>` 收尾）时返回 null。
 */
function rightmostSpine(model: MarkdownRoot): GraftSpine | null {
  const chain: { container: MarkdownRoot | MarkdownElement; index: number }[] = []
  let container: MarkdownRoot | MarkdownElement = model
  for (;;) {
    let index: number = container.children.length - 1
    while (index >= 0) {
      const candidate: MarkdownRenderNode = container.children[index]!
      if (candidate.type === 'text' && candidate.value.trim().length === 0) index -= 1
      else break
    }
    const last: MarkdownRenderNode | undefined = index >= 0 ? container.children[index] : undefined
    if (last === undefined) return null
    chain.push({ container, index })
    if (last.type === 'text') return { leaf: last, chain }
    container = last
  }
}

/** 拷贝脊线并延长最右文本节点；其余子树结构共享（O(深度 × 每层子节点数) 的浅拷贝）。 */
function rebuildSpine(
  chain: readonly { readonly container: MarkdownRoot | MarkdownElement; readonly index: number }[],
  leaf: MarkdownText,
  delta: string,
): MarkdownRoot {
  let node: MarkdownRenderNode = { type: 'text', value: leaf.value + delta }
  for (let position = chain.length - 1; position >= 1; position -= 1) {
    const step = chain[position]!
    const container = step.container
    if (container.type !== 'element') break
    const children = [...container.children]
    children[step.index] = node
    node = {
      type: 'element',
      tagName: container.tagName,
      properties: container.properties,
      children,
    }
  }
  const rootStep = chain[0]!
  const root = rootStep.container
  if (root.type !== 'root') return { type: 'root', children: [node] }
  const children = [...root.children]
  children[rootStep.index] = node
  return { type: 'root', children }
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
