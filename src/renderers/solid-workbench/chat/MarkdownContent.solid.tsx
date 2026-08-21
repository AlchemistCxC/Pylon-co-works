import { Dynamic } from 'solid-js/web'
import { For, Show, createMemo, createResource, type JSX } from 'solid-js'
import { highlightCode } from '../../../components/chat/codeHighlight.ts'
import { sanitizeHtml } from '../../../components/chat/htmlSanitizer.ts'
import { isPlainTextContent } from '../../../components/chat/markdownFastPath.ts'
import {
  getMarkdownRenderModel,
  type MarkdownElement,
  type MarkdownRenderNode,
} from './markdownRenderModel.ts'
import { splitStreamingMarkdown } from './streamingMarkdownSplit.ts'

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
  const split = createMemo(() => props.streaming === true
    ? splitStreamingMarkdown(props.text)
    : null)

  return (
    <Show when={props.streaming === true ? split() : null} keyed fallback={<MarkdownSegment text={props.text} inline={props.inline} />}>
      {value => {
        const { stable, unstable } = value
        return (
          <>
            {stable ? <MarkdownSegment text={stable} inline={props.inline} /> : <MarkdownSegment text="" inline={props.inline} />}
            {unstable ? <MarkdownSegment text={unstable} inline={props.inline} /> : null}
          </>
        )
      }}
    </Show>
  )
}

/** 把一段文本解析为 markdown 渲染。streaming 稳定前缀复用 LRU 缓存，不重解析。 */
function MarkdownSegment(props: { text: string; inline?: boolean }) {
  const shouldParse = () => !isPlainTextContent(props.text)
  const [model] = createResource(
    () => shouldParse() ? props.text : undefined,
    getMarkdownRenderModel,
  )

  return (
    <Show when={shouldParse()} fallback={props.inline
      ? <span class="term-p term-plain-text">{props.text}</span>
      : <p class="term-p term-plain-text">{props.text}</p>}>
      <Show when={model()} fallback={props.inline
        ? <span class="term-p term-plain-text">{props.text}</span>
        : <p class="term-p term-plain-text">{props.text}</p>}>
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
  const isMultiLine = () => lines().length > 1
  const [highlighted] = createResource(
    () => isMultiLine() ? { language: props.language || 'text', code: props.code } : undefined,
    input => highlightCode(input.language, input.code).catch(() => null),
  )
  const highlightedLines = () => highlighted()?.split('\n').map(line => sanitizeHtml(line || '&nbsp;'))

  return (
    <Show when={isMultiLine()} fallback={<code class="term-inline-code">{props.code}</code>}>
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
    </Show>
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

function allowedTagName(tagName: string): keyof JSX.IntrinsicElements {
  const allowed = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'strong', 'em', 'del', 'hr', 'br',
    'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span',
  ])
  return (allowed.has(tagName) ? tagName : 'span') as keyof JSX.IntrinsicElements
}
