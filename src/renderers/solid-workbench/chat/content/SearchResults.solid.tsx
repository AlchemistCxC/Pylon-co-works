import { For, Show, createMemo, createSignal } from 'solid-js'
import type { ContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
import { isAllowedMediaUrl } from '../../../../domains/rendererContent/mediaSourceResolver.ts'

/**
 * C05：搜索结果与链接卡（Solid）。
 *
 * 卡面规则：
 * - 每条结果保留 source/rank/location/snippet/score；高亮按纯文本 range 标记，
 *   绝不注入 HTML（snippet 以文本节点渲染，range 只决定 <mark> 切分位置）；
 * - grouped/collapsed 只是 presentation hint——可展开原始条目，不删任何条目；
 * - URL 显示 host/title；open/copy 经注入回调（command port），危险 scheme 禁用；
 * - oversize 显示"已显示/总数"与加载更多入口。
 */

export interface SearchLinkActions {
  open?: (url: string) => void
  copy?: (text: string) => void
}

interface SearchResultEntry {
  source?: string
  rank?: number
  title?: string
  location?: { line?: number; column?: number }
  snippet?: string
  highlights?: readonly { start: number; end: number }[]
  score?: number
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}

/** 纯文本 snippet + 数字高亮 range → 文本/mark 切分数组（零 HTML 注入）。 */
function snippetSegments(snippet: string, highlights: readonly { start: number; end: number }[] | undefined): { text: string; marked: boolean }[] {
  const safe = highlights?.filter(h => Number.isInteger(h.start) && Number.isInteger(h.end) && h.start >= 0 && h.end > h.start && h.end <= snippet.length) ?? []
  if (safe.length === 0) return [{ text: snippet, marked: false }]
  const sorted = [...safe].sort((a, b) => a.start - b.start)
  const segments: { text: string; marked: boolean }[] = []
  let cursor = 0
  for (const range of sorted) {
    if (range.start < cursor) continue
    if (range.start > cursor) segments.push({ text: snippet.slice(cursor, range.start), marked: false })
    segments.push({ text: snippet.slice(range.start, range.end), marked: true })
    cursor = range.end
  }
  if (cursor < snippet.length) segments.push({ text: snippet.slice(cursor), marked: false })
  return segments
}

export function SolidSearchResultsBlock(props: { part: ContentPart; actions?: SearchLinkActions }) {
  // collapsed 是 presentation hint：初始折叠但原始条目全量可展开。
  const [expanded, setExpanded] = createSignal(false)
  const [visibleCount, setVisibleCount] = createSignal(10)

  const parsed = createMemo(() => props.part as unknown as {
    kind: string
    query?: string
    total?: number
    pagingToken?: string
    results?: readonly SearchResultEntry[]
  })

  const results = createMemo(() => parsed().results ?? [])
  const shown = () => expanded() ? results().slice(0, visibleCount()) : results().slice(0, Math.min(3, visibleCount()))
  const total = () => parsed().total ?? results().length
  const hasMore = () => visibleCount() < results().length

  return (
    <div class="term-search-results" data-collapsed={expanded() ? 'false' : 'true'}>
      <Show when={parsed().query}>
        {query => (
          <div class="term-search-head">
            <span class="term-search-query">{query()}</span>
            <span class="term-file-meta-line">{results().length}/{total()} 条</span>
          </div>
        )}
      </Show>
      <ol class="term-search-list">
        <For each={shown()}>
          {(entry, index) => (
            <li class="term-search-item">
              <span class="term-search-rank">{entry.rank ?? index() + 1}</span>
              <div class="term-search-body">
                <Show when={entry.source}>
                  {source => <span class="term-search-source">{entry.title || source()}</span>}
                </Show>
                <Show when={entry.location?.line !== undefined}>
                  <span class="term-file-range">L{entry.location!.line}</span>
                </Show>
                <Show when={entry.snippet}>
                  {snippet => (
                    <p class="term-search-snippet">
                      <For each={snippetSegments(snippet(), entry.highlights)}>
                        {segment => segment.marked ? <mark class="term-search-mark">{segment.text}</mark> : <span>{segment.text}</span>}
                      </For>
                    </p>
                  )}
                </Show>
                <Show when={entry.score !== undefined}>
                  <span class="term-file-meta-line">score {entry.score}</span>
                </Show>
                <Show when={entry.source && /^https?:\/\//i.test(entry.source)}>
                  <ExternalLinkButton url={entry.source!} label="打开" actions={props.actions} />
                </Show>
              </div>
            </li>
          )}
        </For>
      </ol>
      <div class="term-search-foot">
        <Show when={!expanded() && results().length > 3}>
          <button class="term-file-action" type="button" onClick={() => setExpanded(true)}>
            展开全部 {results().length} 条
          </button>
        </Show>
        <Show when={hasMore()}>
          <button class="term-file-action" type="button" onClick={() => setVisibleCount(count => count + 10)}>
            加载更多（已显示 {visibleCount()}/{results().length}）
          </button>
        </Show>
        <Show when={hasMore() === false && total() > results().length && parsed().pagingToken}>
          <span class="term-file-meta-line">其余 {total() - results().length} 条需分页获取</span>
        </Show>
      </div>
    </div>
  )
}

export function SolidLinkBlock(props: { part: ContentPart; actions?: SearchLinkActions }) {
  const link = createMemo(() => props.part as unknown as { kind: string; url?: string; title?: string; status?: number })
  const url = () => link().url ?? ''
  const allowed = () => isAllowedMediaUrl(url()) || /^https?:\/\//i.test(url())
  return (
    <div class="term-link-card" data-part-kind={props.part.kind}>
      <span class="term-file-icon" aria-hidden="true">🔗</span>
      <div class="term-file-meta">
        <span class="term-file-name">{link().title || hostOf(url()) || url()}</span>
        <span class="term-file-path">{url()}</span>
        <Show when={link().status !== undefined}>
          <span class="term-file-meta-line">HTTP {link().status}</span>
        </Show>
      </div>
      <div class="term-file-actions" role="group" aria-label="链接操作">
        <button
          class="term-file-action"
          type="button"
          disabled={!allowed() || props.actions?.open === undefined}
          title={allowed() ? '打开' : '协议不在白名单，已禁用'}
          onClick={() => allowed() && props.actions?.open?.(url())}
        >
          打开
        </button>
        <button
          class="term-file-action"
          type="button"
          disabled={!allowed() || props.actions?.copy === undefined}
          title={allowed() ? '复制链接' : '协议不在白名单，已禁用'}
          onClick={() => allowed() && props.actions?.copy?.(url())}
        >
          复制
        </button>
      </div>
    </div>
  )
}

function ExternalLinkButton(props: { url: string; label: string; actions?: SearchLinkActions }) {
  const allowed = () => isAllowedMediaUrl(props.url) || /^https?:\/\//i.test(props.url)
  return (
    <button
      class="term-file-action term-search-open"
      type="button"
      disabled={!allowed() || props.actions?.open === undefined}
      title={allowed() ? props.label : '协议不在白名单，已禁用'}
      onClick={() => allowed() && props.actions?.open?.(props.url)}
    >
      {props.label}
    </button>
  )
}

/** C05 入口：search-result / link 分发；其他 part 返回 null。 */
export function SolidSearchOrLink(props: { part: ContentPart; actions?: SearchLinkActions }) {
  return (
    <Show
      when={props.part.kind === 'search-result'}
      fallback={
        <Show when={props.part.kind === 'link'} fallback={null}>
          <SolidLinkBlock part={props.part} actions={props.actions} />
        </Show>
      }
    >
      <SolidSearchResultsBlock part={props.part} actions={props.actions} />
    </Show>
  )
}
