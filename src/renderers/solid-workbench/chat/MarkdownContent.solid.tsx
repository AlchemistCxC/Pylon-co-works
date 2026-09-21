import { Dynamic } from 'solid-js/web'
import { For, Index, Show, createEffect, createMemo, createResource, createSignal, untrack, type JSX } from 'solid-js'
import { highlightCode } from '../../../components/chat/codeHighlight.ts'
import { sanitizeHtml } from '../../../components/chat/htmlSanitizer.ts'
import { isPlainTextContent } from '../../../components/chat/markdownFastPath.ts'
import {
  getMarkdownRenderModel,
  peekMarkdownRenderModel,
  type MarkdownElement,
  type MarkdownRenderNode,
} from './markdownRenderModel.ts'
import { splitOpenCodeFenceTail, splitStreamingMarkdownBlockEnds } from '../../../infrastructure/compute/streamingCompute.ts'
import { noteStreamingRowSet } from './streamingRowCounters.ts'

export interface MarkdownContentProps {
  text: string
  streaming?: boolean
  inline?: boolean
}

export function MarkdownContent(props: MarkdownContentProps) {
  // Bug4 流式主瓶颈：streaming 时每次 token 都对整段文本重解析/重高亮 → O(n²)。
  // 流式中把文本切成 "已完成块 stable + 增长尾块 unstable"（参考 claude-code StreamingMarkdown），
  // stable 由 content-keyed LRU 缓存复用（不重解析），unstable 是短尾只解析这一小段。
  // 非 streaming（已提交消息）保持整段一次解析，行为不变。
  //
  // C00 修复：不得用 <Show keyed> 包 split() 结果——每个 chunk 都是新对象引用，
  // keyed 会把整棵子树（含 stable 段）逐 chunk 重建。改为细粒度 accessor：
  // MarkdownSegment 只在自身 text 变化时重新解析/渲染，stable 恒定时 DOM 身份不变。
  // A Slot that started streaming remains on the incremental path when the
  // terminal update arrives. This promotes its last tail row instead of
  // replacing the complete Markdown subtree.
  const incremental = props.streaming === true

  return (
    <Show when={incremental} fallback={<MarkdownSegment text={props.text} inline={props.inline} />}>
      <StreamingMarkdownBlocks text={() => props.text} streaming={() => props.streaming === true} inline={props.inline} />
    </Show>
  )
}

interface StreamingBlockRow {
  readonly id: number
  /** P57 S3-A11：该行是否仍是增长尾块（尾块解析绕 LRU 缓存，稳定后恢复缓存）。
   *  #150 稳定性：必须是**信号**——行被提升为稳定行时要触发解析源变化（见 `MarkdownSegment`），
   *  否则已提交内容会沿用增量模型、失去「提升即全量」的自愈。 */
  tail(): boolean
  setTail(value: boolean): void
  readonly text: string
  update(text: string): void
}

/** 由当前文本推导出的一行（顺序即渲染顺序）。 */
interface RowSpec {
  readonly text: string
  readonly tail: boolean
}

interface DerivedRows {
  readonly specs: readonly RowSpec[]
  /** specs 前 stableSpecs 项来自已提交块（文本只增不变），其余至多一项是增长尾块。 */
  readonly stableSpecs: number
  /** 当前文本的段落数（稳定块 + 尾块）——行集合的上界，只读诊断用。 */
  readonly paragraphs: number
}

/**
 * 把「可见文本」推导为行描述序列——**纯函数**：同一文本 + 同一 final 恒得到同一序列。
 *
 * 为什么必须纯：发布链不保证单调（插值后的裁剪前缀、双列表短暂分叉、终态重发、resume）。
 * 只要行集合里留着独立于文本的累积历史，输入一旦回退或换挡就会留下「当前文本里并不存在
 * 的行边界」，把同一段干净文本切成每几个字一行的碎片（issue #55：实测 117 个块、其中 44 个
 * 不足 6 字，而文本只有 55 个段落；重启后同一条消息恢复正常）。
 *
 * 切分语义仍单一由 `splitStreamingMarkdownBlocks` 负责：空行切块、容器行不越界、未闭合
 * 围栏不劈开——本次不触碰它。
 *
 * 行文本不变式：每一行的文本都不以结构性空白开头或结尾（见
 * `trimRowStructuralWhitespace`），且不为空——分隔空行是行与行之间的结构，不是行内容。
 */
function deriveRowSpecs(visible: string, final: boolean): DerivedRows {
  // 热路径只取块边界偏移（ends 出口）：块内容由这里从 visible 切出——整组 stable
  // 块字符串每拍从 wasm 重分配/编组是 O(全文) 的过界流量（#220 边界收口）。
  const ends = splitStreamingMarkdownBlockEnds(visible)
  const specs: RowSpec[] = []
  let start = 0
  for (const end of ends) {
    // The splitter includes the blank-line delimiter in each stable block so the
    // accumulated prefix stays lossless.  That delimiter is structural, though—not
    // content that should become an extra `pre-wrap` line inside the row.  The shared
    // `.term-p + .term-p` cadence represents the separator; strip it from the visible
    // stable text to keep streaming geometry identical to the completed Markdown path.
    const text = trimRowStructuralWhitespace(visible.slice(start, end))
    if (text.length > 0) specs.push({ text, tail: false })
    start = end
  }
  const stableSpecs = specs.length
  const unstable = visible.slice(start)
  if (unstable.length > 0) {
    // Consecutive blank lines are collapsed by the splitter rather than becoming empty
    // renderer rows, so a tail that is still only structural whitespace contributes
    // nothing.  Its delimiter is stripped unconditionally: the old condition（只在它前面
    // 确实提交过块时才裁）会把前导空行留在行文本里，渲染成 `'\n\n快'` 一类的行。
    const text = trimRowStructuralWhitespace(unstable)
    if (text.length > 0) specs.push({ text, tail: !final })
  }
  return { specs, stableSpecs, paragraphs: ends.length + (unstable.length > 0 ? 1 : 0) }
}

function StreamingMarkdownBlocks(props: { text: () => string; streaming: () => boolean; inline?: boolean }) {
  let nextId = 1
  // 行集合 = 当前文本的函数。这里刻意不保留任何独立于文本的累积状态：旧实现里的
  // committedText / hiddenLeading / stableRows 累积 + reset() 正是漂移的来源。
  let rendered: StreamingBlockRow[] = []
  let lastText = ''
  // stable 行文本只增不变（切分不变量：边界只前进），按位缓存修剪后的最终行文本，
  // 后继发布省掉对全部已完成块的 slice+trim 重复分配；尾行永远重算，回退/换挡清空。
  let cachedStableTexts: readonly string[] = []
  const [rows, setRows] = createSignal<readonly StreamingBlockRow[]>([])

  const reconcile = (text: string, final: boolean) => {
    // 非后继输入（回退/换挡/重放）只作为只读计数，不再需要特殊分支：推导只看当前文本。
    const reset = !text.startsWith(lastText)
    lastText = text
    if (reset) cachedStableTexts = []
    // Providers may open an assistant stream with blank lines (for example right after a
    // reasoning phase). CommonMark drops them once the parser runs, but the plain fast
    // path renders each as an empty pre-wrap line, pushing the first generated characters
    // below the assistant indicator.
    const derived = deriveRowSpecs(trimLeadingBlankLines(text), final)
    const resolvedSpecs = derived.specs.map((spec, index) => cachedStableTexts[index] ?? spec.text)
    cachedStableTexts = resolvedSpecs.slice(0, derived.stableSpecs)
    // S0 只读计数：rows / textParagraphs > 1 说明行集合里出现了文本之外的边界（issue #55 判据）。
    noteStreamingRowSet({ rows: derived.specs.length, paragraphs: derived.paragraphs, reset })
    const nextRows: StreamingBlockRow[] = []
    for (let index = 0; index < resolvedSpecs.length; index += 1) {
      const specText = resolvedSpecs[index]!
      const candidate = rendered[index]
      if (candidate === undefined) {
        nextRows.push(createStreamingBlockRow(nextId++, specText, derived.specs[index]!.tail))
        continue
      }
      // 位置对账：文本未变就不碰 signal（不多余重解析），变了就地更新——保持 DOM 身份是
      // 尾块逐拍增长不闪烁、稳定块（含代码块）不重挂载的前提。
      if (candidate.text !== specText) candidate.update(specText)
      candidate.setTail(derived.specs[index]!.tail)
      nextRows.push(candidate)
    }
    rendered = nextRows
    setRows(nextRows)
  }

  createEffect(() => {
    const text = props.text()
    const final = !props.streaming()
    untrack(() => reconcile(text, final))
  })

  return <For each={rows()}>{row => <StreamingMarkdownBlock
    row={row}
    streaming={props.streaming}
    inline={props.inline}
  />}</For>
}

/** Strip fully blank leading lines; the first content line keeps its indentation. */
function trimLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[^\S\r\n]*\r?\n)+/, '')
}

/**
 * 行文本不变式：行的文本不以结构性空白（整行空白）开头或结尾。
 *
 * 分隔空行属于「行与行之间」的结构（由 `.term-p + .term-p` 的节奏承担），不属于行内容：
 * 留着它 `pre-wrap` 会多画一行，也会让流式几何与终态解析出的 Markdown 漂移。只裁整行空白，
 * **不裁末行内容里的空格与缩进**（例如代码缩进）。
 *
 * 支持 CRLF，使可见结果与 provider 的换行形式无关。
 */
function trimRowStructuralWhitespace(text: string): string {
  return text.replace(/(?:\r?\n[\t ]*)+$/u, '').replace(/^(?:\r?\n[\t ]*)+/u, '')
}

function createStreamingBlockRow(id: number, initialText: string, tail: boolean): StreamingBlockRow {
  const [text, setText] = createSignal(initialText)
  const [isTail, setIsTail] = createSignal(tail)
  return { id, tail: isTail, setTail: setIsTail, get text() { return text() }, update: setText }
}

function StreamingMarkdownBlock(props: { row: StreamingBlockRow; streaming: () => boolean; inline?: boolean }) {
  const text = () => props.row.text
  const openCodeTail = createMemo(() => props.streaming() ? splitOpenCodeFenceTail(text()) : null)
  // P57 S3-A11：增长尾块的中间态解析绕 LRU 缓存（同前缀同长度的文本永不再命中，
  // 只会挤掉 stable 块的缓存条目）；行晋升为 stable 后恢复缓存。
  const cacheModel = () => !props.row.tail()
  return <Show
    when={openCodeTail() !== null}
    fallback={<MarkdownSegment text={text} inline={props.inline} cache={cacheModel} />}
  >
    <Show when={openCodeTail()?.prefix}>
      {prefix => <MarkdownSegment text={prefix()} inline={props.inline} cache={cacheModel} />}
    </Show>
    <StreamingCodeBlock
      code={() => openCodeTail()?.code ?? ''}
      language={() => openCodeTail()?.language}
    />
  </Show>
}

/**
 * 流式尾块（未闭合围栏）的正文。
 *
 * **刻意不折叠**（用户 2026-09-20 裁决：流式期要能看着它继续长）。它是**过渡态**——
 * 回合结束后走 markdown 解析路径，由 #208 的头部折叠接管；因此"不限量"的窗口只覆盖
 * 生成期。真机实测 372 行 / 1.18 万字符的块在流式期 0 条 long task，常见规模下代价可忽略；
 * 若将来出现极端长块导致 DOM 膨胀，再引入高上限兜底（而不是直接改为折叠）。
 */
function StreamingCodeBlock(props: { language: () => string | undefined; code: () => string }) {
  const lines = () => props.code().split(String.fromCharCode(10))
  return (
    <div
      class="term-code-block"
      data-streaming-code="true"
      data-language={props.language()}
    >
      <Index each={lines()}>{line => (
        <div class="term-code-line">
          <span class="term-code-gutter">│ </span>
          <span class="term-code-text">{line() || String.fromCharCode(160)}</span>
        </div>
      )}</Index>
    </div>
  )
}

/**
 * 把一段文本解析为 markdown 渲染。streaming 稳定前缀复用 LRU 缓存，不重解析。
 *
 * P57 S3-R8（R-B8）：解析 pending 期间渲染 `model.latest`（上一次已解析模型），
 * 不再回落到原始文本——流式尾块旧模型是同文本前缀，短暂滞后无感，而原始
 * `**`/`` ` `` 标记不再泄漏到 DOM。仅首次解析（从未 resolve）渲染骨架。
 */
function MarkdownSegment(props: { text: string | (() => string); inline?: boolean; cache?: () => boolean }) {
  const text = () => typeof props.text === 'function' ? props.text() : props.text
  const shouldParse = () => !isPlainTextContent(text())
  const useCache = () => props.cache?.() ?? true
  // #212：命中**已结算**的缓存模型时同步渲染，完全不经骨架——历史行不再有一次
  // 「1em 骨架 → 真高」的高度跳变。只在走缓存的调用点有效（增长尾块恒走解析/graft）。
  const settled = () => useCache() ? peekMarkdownRenderModel(text()) : undefined
  const [model] = createResource(
    // #150 稳定性：解析源带上 `cache` 标志 ⇒ 尾块被提升为稳定行（cache false→true）时**换源重解析**，
    // 于是「已提交内容一定来自整段重解析」——增量拼接只可能影响正在长的那一行，即便某个没预料的
    // 形状上拼错了，也会在块完成那一刻被真实解析覆盖（自愈）。代价是每块多一次整段重解析（一次）。
    () => shouldParse() ? { text: text(), cache: useCache() } : undefined,
    source => getMarkdownRenderModel(source.text, {
      cache: source.cache,
      // #148：只有增长尾块（不走缓存的路径）才传「最新即胜」判据——跳过返回空模型，落进 LRU
      // 会毒化同文本的其他行。判据与 Solid 丢弃结果的 `pr === p` 条件同义：解析源是
      // `shouldParse() ? text() : undefined`，源一变它就发起新 fetch 并改写 pr，旧请求的结果
      // 必被丢弃（token 级切片、终态重发、resume 这类一 tick 内多次发布的中间态即在此被挡下）。
      isCurrent: source.cache ? undefined : () => shouldParse() && text() === source.text,
    }),
  )

  const root = () => settled() ?? model.latest

  return (
    <Show when={shouldParse()} fallback={props.inline
      ? <span class="term-p term-plain-text">{text()}</span>
      : <p class="term-p term-plain-text">{text()}</p>}>
      <Show when={root()} fallback={<div class="term-md-skeleton" aria-busy="true" />}>
        {resolved => <For each={resolved().children}>{node => <MarkdownNode node={node} />}</For>}
      </Show>
    </Show>
  )
}

function MarkdownNode(props: { node: MarkdownRenderNode }): JSX.Element {
  if (props.node.type === 'text') return props.node.value
  if (props.node.type === 'root') {
    return <For each={props.node.children}>{node => <MarkdownNode node={node} />}</For>
  }

  const node = props.node
  if (node.tagName === 'pre') {
    const code = extractCodeBlock(node)
    if (code) return <CodeBlock language={code.language} code={code.code} />
  }
  if (node.tagName === 'code') {
    return <code class="term-inline-code"><MarkdownChildren children={node.children} /></code>
  }
  if (node.tagName === 'a') {
    const href = safeHref(node.properties.href)
    return href
      ? <a href={href} target="_blank" rel="noopener noreferrer" class="term-link"><MarkdownChildren children={node.children} /></a>
      : <span><MarkdownChildren children={node.children} /></span>
  }
  if (node.tagName === 'img') {
    const src = safeImageSource(node.properties.src)
    const alt = typeof node.properties.alt === 'string' ? node.properties.alt : ''
    return src
      ? <img class="term-markdown-image" src={src} alt={alt} loading="lazy" />
      : <span class="term-markdown-image-alt">{alt}</span>
  }
  if (node.tagName === 'blockquote') {
    return <blockquote class="term-blockquote"><MarkdownChildren children={node.children} /></blockquote>
  }
  if (node.tagName === 'table') {
    return <div class="term-table-wrap"><table class="term-table"><MarkdownChildren children={node.children} /></table></div>
  }

  const tagName = allowedTagName(node.tagName)
  // CSS-02：Markdown heading 显式 class contract（§5.15 step 3）——h1-h6 输出 term-h1~term-h6，
  // 配合 ChatView.css 限定 .term-assistant 内的层级规则（Solid renderer 唯一 contract）。
  const headingClass = tagName.match(/^h[1-6]$/) ? `term-${tagName}` : undefined
  // Keep the block contract shared with the legacy React renderer.  The
  // global stylesheet intentionally resets native element margins, so relying
  // on the browser's bare `<p>`/`<li>` defaults makes a completed stream look
  // materially tighter than its plain-text streaming counterpart.
  const blockClass = tagName === 'p'
    ? 'term-p'
    : tagName === 'li'
      ? 'term-li'
      : headingClass
  return <Dynamic component={tagName} class={blockClass}><MarkdownChildren children={node.children} /></Dynamic>
}

function MarkdownChildren(props: { children: readonly MarkdownRenderNode[] }) {
  return <For each={props.children}>{node => <MarkdownNode node={node} />}</For>
}

function CodeBlock(props: { language?: string; code: string }) {
  const lines = () => props.code.split('\n')
  const [highlighted] = createResource(
    () => ({ language: props.language || 'text', code: props.code }),
    input => highlightCode(input.language, input.code).catch(() => null),
  )
  const highlightedLines = () => highlighted()?.split('\n').map(line => sanitizeHtml(line || '&nbsp;'))

  return (
    <div class="term-code-block">
        <For each={lines()}>{(line, index) => (
          <div class="term-code-line">
            <span class="term-code-gutter">│ </span>
            <Show
              when={highlightedLines()?.[index()]}
              fallback={<span class="term-code-text">{line || '\u00a0'}</span>}
            >
              {html => <span class="term-code-text" innerHTML={html()} />}
            </Show>
          </div>
        )}</For>
    </div>
  )
}

function extractCodeBlock(node: MarkdownElement): { language?: string; code: string } | null {
  const codeNode = node.children.find(child => child.type === 'element' && child.tagName === 'code')
  if (!codeNode || codeNode.type !== 'element') return null
  const classNames = normalizeClassNames(codeNode.properties.className)
  const languageClass = classNames.find(className => className.startsWith('language-'))
  return {
    language: languageClass?.slice('language-'.length),
    code: collectText(codeNode).replace(/\n$/, ''),
  }
}

function collectText(node: MarkdownRenderNode): string {
  if (node.type === 'text') return node.value
  return node.children.map(collectText).join('')
}

function normalizeClassNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []
}

function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const href = value.trim()
  if (!href) return null
  if (/^(?:https?:|mailto:)/i.test(href)) return href
  if (/^(?:\/|\.\/|\.\.\/|#)/.test(href)) return href
  // A scheme-less Markdown href is a workspace-relative resource. The
  // AgentSheet host decides whether it is contained by the active workspace
  // before preventing browser navigation and opening FileSheet.
  if (!/^[a-z][a-z\d+.-]*:/i.test(href) && ![...href].some(char => char.charCodeAt(0) <= 0x20)) return href
  return null
}

function safeImageSource(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const source = value.trim()
  if (/^https?:/i.test(source)) return source
  if (/^data:image\/(?:png|gif|jpe?g|webp|avif);base64,/i.test(source)) return source
  if (/^(?:\/|\.\/|\.\.\/)/.test(source)) return source
  return null
}

function allowedTagName(tagName: string): keyof JSX.IntrinsicElements {
  const allowed = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'strong', 'em', 'del', 'hr', 'br',
    'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span',
  ])
  return (allowed.has(tagName) ? tagName : 'span') as keyof JSX.IntrinsicElements
}
