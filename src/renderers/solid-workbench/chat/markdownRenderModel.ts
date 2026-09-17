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

/**
 * 按行拼接的差量形状：1–2 个换行 + 一行纯文本（非空、不以空白开头）。
 * 行内容仍走 `PLAIN_LINE` 白名单——同理，纯文本行不可能自成块级构造。
 */
const LINE_DELTA = /^(\n{1,2})([^\n]+)$/
/** 纯文本行：与 `PLAIN_DELTA` 同源的字符集。 */
const PLAIN_LINE = /^[A-Za-z0-9\u0080-\u{10FFFF}][A-Za-z0-9\u0080-\u{10FFFF} ]*$/u
/** 行首列表标记：子弹符或有序序号 + 空格。 */
const LIST_MARKER = /^(?:([-*+])|(\d+)([.)])) /
/** 模型里的换行分隔文本节点（remark-rehype 的排版产物）。 */
const TEXT_NEWLINE: MarkdownText = { type: 'text', value: '\n' }

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
  // 行尾换行与空行是**块之间的分隔**，CommonMark 在块尾会把它们剥掉：文档末尾追加 1 个或多个
  // `\n` 不改变模型（真机实测一行边界会先来一个纯 `\n` 差量，再来的行内容才是内容）。
  const trailingNewlines = (/(\n+)$/.exec(baseText)?.[1].length ?? 0)
  const effectiveBase = trailingNewlines > 0 ? baseText.slice(0, baseText.length - trailingNewlines) : baseText
  if (/^\n+$/.test(delta)) return baseModel
  const spine = rightmostSpine(baseModel)
  if (spine === null) return null
  const { leaf, chain } = spine
  // 落点必须是「会剥掉块内容末尾空白」的容器（p / li / td / th / h1-h6 …）——下面的剥离规则依赖它。
  for (const step of chain) {
    const container = step.container
    if (container.type === 'element' && !GRAFT_SAFE_ANCESTORS.has(container.tagName)) return null
  }
  const line = LINE_DELTA.exec(delta)
  if (line !== null) {
    // 基座自带的尾随换行与差量开头的换行合起来算「这一行之前有几个换行」
    const spliced = spliceLine(effectiveBase, leaf, chain, trailingNewlines + line[1]!.length, line[2]!)
    if (spliced !== null) return spliced
    if (trailingNewlines > 0) return null // 行边界处判据不成立：交给整段重解析，别退化成续行
  }
  if (!PLAIN_DELTA.test(delta)) return null
  // CommonMark 会剥掉块内容的末尾空白（`The ` 解析出来是 `The`），拼接时同样剥掉，
  // 否则与整段重解析差一个空格——差分测试逮到过这一条。纯空白差量因此不产生任何内容。
  const appended = delta.replace(/\s+$/u, '')
  if (appended.length === 0) return baseModel
  if (trailingNewlines > 0) return null // 已经换行：追加的文字属于新的一行，不是延长旧叶子
  if (!effectiveBase.endsWith(leaf.value)) return null
  if (EXTENDABLE_PUNCTUATION.test(leaf.value.slice(-LEAF_GUARD_WINDOW))) return null
  return rebuildSpine(chain, leaf, appended)
}

/**
 * 按行拼接（差量 = 1–2 个换行 + 一行纯文本）。三条规则的**形状都取自真机参考树实测**
 * （见 `.agents/records/issue-150-line-splice.md`），任一判据不成立即返回 null 回退整段重解析：
 *
 * - **续行**（`\n` + 非标记行，落点父节点是 `p` 或 `li`）：软换行在模型里就是**同一个 text 节点内的
 *   `\n`**，所以直接延长该节点即可（列表项的 lazy continuation 与引用块内的续行同形）。
 * - **同款标记新列表项**（`\n` + 与基座最后一行**同款**的标记 + 纯文本）：在列表容器尾部把
 *   `"\n"` 分隔节点换成 `["\n", li(内容), "\n"]`。标记换款（`-`→`*`、`.`→`)`）会让解析器**拆成
 *   两个列表**，所以必须同款；松散列表（项内有 `p` 包裹）形状不同，一并回退。
 * - **新段落**（空行 + 非缩进行，或标题后的单换行 + 行）：在根级追加 `["\n", p(内容)]`
 *   ——实测「段落/列表/标题/围栏之后」都是这个形状。
 */
function spliceLine(
  baseText: string,
  leaf: MarkdownText,
  chain: readonly GraftChainStep[],
  newlines: number,
  lineContent: string,
): MarkdownRoot | null {
  const parent = chain[chain.length - 1]!.container
  const parentTag = parent.type === 'element' ? parent.tagName : ''
  const rootStep = chain[0]
  const root = rootStep?.container
  if (root === undefined || root.type !== 'root') return null
  const marker = LIST_MARKER.exec(lineContent)

  if (newlines === 1 && marker !== null) {
    // 同款标记的新列表项（标记换了款解析器会拆列表，所以要求同款）
    if (parentTag !== 'li' || chain.length !== 3) return null
    const list = chain[1]!.container
    if (list.type !== 'element' || (list.tagName !== 'ul' && list.tagName !== 'ol')) return null
    if (parent.children.length !== 1) return null // 松散列表（项内有 p 包裹）形状不同
    const previous = LIST_MARKER.exec(lastLine(baseText))
    if (previous === null) return null
    const sameMarker = marker[1] !== undefined
      ? marker[1] === previous[1]
      : previous[2] !== undefined && marker[3] === previous[3]
    if (!sameMarker) return null
    const content = lineContent.slice(marker[0].length).replace(/\s+$/u, '')
    if (content.length === 0 || !PLAIN_LINE.test(content)) return null
    const item: MarkdownRenderNode = {
      type: 'element',
      tagName: 'li',
      properties: {},
      children: [{ type: 'text', value: content }],
    }
    return rebuildChain(chain, 1, children => [...children.slice(0, -1), TEXT_NEWLINE, item, TEXT_NEWLINE])
  }

  // 标记行但判据不成立（换款、嵌套、松散…）→ 回退，绝不当作续行
  if (marker !== null) return null
  if (!PLAIN_LINE.test(lineContent)) return null

  // 续行：软换行 = 同一 text 节点内的 `\n`（列表项的 lazy continuation 与引用块内续行同形）
  if (newlines === 1 && (parentTag === 'p' || parentTag === 'li')) {
    if (!baseText.endsWith(leaf.value)) return null
    if (EXTENDABLE_PUNCTUATION.test(leaf.value.slice(-LEAF_GUARD_WINDOW))) return null
    return rebuildSpine(chain, leaf, `\n${lineContent.replace(/\s+$/u, '')}`)
  }

  // 新段落：空行之后，或标题之后的单换行（实测「段落/列表/标题/围栏之后」都是根级追加这个形状）
  const afterBlankLine = newlines === 2
  const afterHeading = newlines === 1 && /^h[1-6]$/.test(parentTag) && chain.length === 2
  if (afterBlankLine || afterHeading) {
    const lastChild = root.children[root.children.length - 1]
    if (lastChild === undefined || lastChild.type !== 'element') return null
    const paragraph: MarkdownRenderNode = {
      type: 'element',
      tagName: 'p',
      properties: {},
      children: [{ type: 'text', value: lineContent.replace(/\s+$/u, '') }],
    }
    return rebuildChain(chain, 0, children => [...children, TEXT_NEWLINE, paragraph])
  }

  return null
}

/** 文本最后一行（用于比对列表标记是否同款）。 */
function lastLine(text: string): string {
  const index = text.lastIndexOf('\n')
  return index < 0 ? text : text.slice(index + 1)
}

interface GraftChainStep {
  readonly container: MarkdownRoot | MarkdownElement
  /** 该层脊线子节点在 `container.children` 里的下标。 */
  readonly index: number
}

interface GraftSpine {
  readonly leaf: MarkdownText
  /** 从根到叶子父节点的链：每层的容器与该层所选子节点的下标。 */
  readonly chain: readonly GraftChainStep[]
}

/**
 * 取「最右内容叶子」的脊线：每层从后往前找第一个**非纯空白文本**的子节点。
 *
 * 为什么要跳过纯空白文本节点：remark-rehype 会在列表项之间与列表结尾补 `"\n"` 文本节点，
 * 它们是结构分隔符而不是内容落点——追加进去会把文字塞进分隔符里（差分测试逮到过这一条）。
 * 最右内容叶子不是文本节点（如以 `<hr>`/`<img>` 收尾）时返回 null。
 */
function rightmostSpine(model: MarkdownRoot): GraftSpine | null {
  const chain: GraftChainStep[] = []
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

/** 延长最右文本节点（纯文本追加与续行同此：软换行在模型里就是同一个 text 节点内的 `\n`）。 */
function rebuildSpine(chain: readonly GraftChainStep[], leaf: MarkdownText, delta: string): MarkdownRoot {
  const deepest = chain[chain.length - 1]!
  return rebuildChain(chain, chain.length - 1, children =>
    replaceAt(children, deepest.index, { type: 'text', value: leaf.value + delta }))
}

/**
 * 沿脊线重建：`depth` 层的子节点由 `edit` 生成，其余层只替换脊线下标处的子节点——非脊线子树结构共享，
 * 因此单次拼接是 O(深度 × 每层子节点数) 的浅拷贝。
 */
function rebuildChain(
  chain: readonly GraftChainStep[],
  depth: number,
  edit: (children: readonly MarkdownRenderNode[]) => readonly MarkdownRenderNode[],
): MarkdownRoot {
  const deepest = chain[chain.length - 1]!
  // 最深层不在编辑层时，脊线下标处的内容保持原样（S2/S3 只改上层容器）。
  let node: MarkdownRenderNode = deepest.container.children[deepest.index] ?? { type: 'root', children: [] }
  for (let level = chain.length - 1; level >= 0; level -= 1) {
    const step = chain[level]!
    const container = step.container
    const children = level === depth
      ? edit(container.children)
      : replaceAt(container.children, step.index, node)
    node = container.type === 'root'
      ? { type: 'root', children }
      : { type: 'element', tagName: container.tagName, properties: container.properties, children }
  }
  return node as MarkdownRoot
}

function replaceAt(
  children: readonly MarkdownRenderNode[],
  index: number,
  value: MarkdownRenderNode,
): readonly MarkdownRenderNode[] {
  const next = [...children]
  next[index] = value
  return next
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
