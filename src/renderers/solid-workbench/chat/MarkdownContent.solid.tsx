import { Dynamic } from 'solid-js/web'
import { For, Index, Show, createEffect, createMemo, createResource, createSignal, untrack, type JSX } from 'solid-js'
import { highlightCode } from '../../../components/chat/codeHighlight.ts'
import { sanitizeHtml } from '../../../components/chat/htmlSanitizer.ts'
import { isPlainTextContent } from '../../../components/chat/markdownFastPath.ts'
import {
  getMarkdownRenderModel,
  type MarkdownElement,
  type MarkdownRenderNode,
} from './markdownRenderModel.ts'
import { splitOpenCodeFenceTail, splitStreamingMarkdownBlocks } from './streamingMarkdownSplit.ts'

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
  readonly text: string
  update(text: string): void
}

function StreamingMarkdownBlocks(props: { text: () => string; streaming: () => boolean; inline?: boolean }) {
  let nextId = 1
  let committedText = ''
  let stableRows: StreamingBlockRow[] = []
  let tailRow = createStreamingBlockRow(nextId++, '')
  const [rows, setRows] = createSignal<readonly StreamingBlockRow[]>([])

  const reset = (text: string, final: boolean) => {
    committedText = ''
    stableRows = []
    tailRow = createStreamingBlockRow(nextId++, '')
    reconcile(text, final)
  }

  const reconcile = (text: string, final: boolean) => {
    if (!text.startsWith(committedText)) {
      reset(text, final)
      return
    }
    const pending = text.slice(committedText.length)
    const split = splitStreamingMarkdownBlocks(pending)
    for (const block of split.stableBlocks) {
      tailRow.update(block)
      stableRows.push(tailRow)
      committedText += block
      tailRow = createStreamingBlockRow(nextId++, '')
    }
    tailRow.update(split.unstable)
    if (final && split.unstable.length > 0) {
      stableRows.push(tailRow)
      committedText += split.unstable
      tailRow = createStreamingBlockRow(nextId++, '')
    }
    setRows(split.unstable.length > 0 && !final ? [...stableRows, tailRow] : [...stableRows])
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

function createStreamingBlockRow(id: number, initialText: string): StreamingBlockRow {
  const [text, setText] = createSignal(initialText)
  return { id, get text() { return text() }, update: setText }
}

function StreamingMarkdownBlock(props: { row: StreamingBlockRow; streaming: () => boolean; inline?: boolean }) {
  const text = () => props.row.text
  const openCodeTail = createMemo(() => props.streaming() ? splitOpenCodeFenceTail(text()) : null)
  return <Show
    when={openCodeTail() !== null}
    fallback={<MarkdownSegment text={text} inline={props.inline} />}
  >
    <Show when={openCodeTail()?.prefix}>
      {prefix => <MarkdownSegment text={prefix()} inline={props.inline} />}
    </Show>
    <StreamingCodeBlock
      code={() => openCodeTail()?.code ?? ''}
      language={() => openCodeTail()?.language}
    />
  </Show>
}

function StreamingCodeBlock(props: { language: () => string | undefined; code: () => string }) {
  const lines = () => props.code().split('\n')
  return (
    <div
      class="term-code-block"
      data-streaming-code="true"
      data-language={props.language()}
    >
      <Index each={lines()}>{line => (
        <div class="term-code-line">
          <span class="term-code-gutter">│ </span>
          <span>{line() || '\u00a0'}</span>
        </div>
      )}</Index>
    </div>
  )
}

/** 把一段文本解析为 markdown 渲染。streaming 稳定前缀复用 LRU 缓存，不重解析。 */
function MarkdownSegment(props: { text: string | (() => string); inline?: boolean }) {
  const text = () => typeof props.text === 'function' ? props.text() : props.text
  const shouldParse = () => !isPlainTextContent(text())
  const [model] = createResource(
    () => shouldParse() ? text() : undefined,
    getMarkdownRenderModel,
  )

  return (
    <Show when={shouldParse()} fallback={props.inline
      ? <span class="term-p term-plain-text">{text()}</span>
      : <p class="term-p term-plain-text">{text()}</p>}>
      <Show when={model()} fallback={props.inline
        ? <span class="term-p term-plain-text">{text()}</span>
        : <p class="term-p term-plain-text">{text()}</p>}>
        {root => <For each={root().children}>{node => <MarkdownNode node={node} />}</For>}
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
  // 配合 ChatView.css 限定 .term-assistant 内的层级规则（与 React renderer 同 contract）。
  const headingClass = tagName.match(/^h[1-6]$/) ? `term-${tagName}` : undefined
  return <Dynamic component={tagName} class={headingClass}><MarkdownChildren children={node.children} /></Dynamic>
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
              fallback={<span>{line || '\u00a0'}</span>}
            >
              {html => <span innerHTML={html()} />}
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
