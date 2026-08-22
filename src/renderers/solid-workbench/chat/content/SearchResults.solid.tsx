import { For, Show, createMemo, createSignal, type JSX } from 'solid-js'
import type {
  ContentPart,
  LinkContentPart,
  SearchResultContentPart,
  SearchResultEntry,
} from '../../../../domains/workbench/content/contentPartSchema.ts'

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

export interface SearchLinkAppearance {
  foreground?: string
  mutedForeground?: string
  background?: string
  borderColor?: string
  fontSize?: number
  maxWidth?: number
  maxHeight?: number
  density?: 'comfortable' | 'compact'
  grouped?: boolean
  highlightPalette?: 'semantic' | 'accent' | 'neutral'
  defaultExpanded?: boolean
  pageSize?: number
  snippetLines?: number
  pathDisplay?: 'full' | 'basename' | 'hidden'
  linkOpenMode?: 'external' | 'copy-first'
  showStatus?: boolean
  reducedMotion?: boolean
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

export function SolidSearchResultsBlock(props: { part: SearchResultContentPart; actions?: SearchLinkActions; appearance?: SearchLinkAppearance }) {
  // collapsed 是 presentation hint：初始折叠但原始条目全量可展开。
  const [expanded, setExpanded] = createSignal(props.appearance?.defaultExpanded === true)
  const [loadedPages, setLoadedPages] = createSignal(1)
  const results = createMemo(() => props.part.results)
  const pageSize = () => boundedInteger(props.appearance?.pageSize, 10, 1, 100)
  const pageLimit = () => pageSize() * loadedPages()
  const shown = () => results().slice(0, expanded() ? pageLimit() : Math.min(3, pageLimit()))
  const total = () => props.part.total ?? results().length
  const hasMore = () => pageLimit() < results().length
  const appearance = () => props.appearance ?? {}
  const cardStyle = () => ({
    color: appearance().foreground ?? 'var(--text)',
    'background-color': appearance().background ?? 'transparent',
    'border-color': appearance().borderColor ?? 'var(--border)',
    'font-size': `${boundedNumber(appearance().fontSize, 13)}px`,
    'max-width': `${boundedNumber(appearance().maxWidth, 960)}px`,
    'max-height': `${boundedNumber(appearance().maxHeight, 420)}px`,
    'border-style': 'solid',
    'border-width': '1px',
    padding: appearance().density === 'compact' ? '6px' : '10px',
    overflow: 'auto',
  })
  const itemStyle = (): JSX.CSSProperties => ({
    'border-left-style': appearance().grouped === false ? 'none' : 'solid',
    'border-left-width': appearance().grouped === false ? '0' : '2px',
    'border-left-color': appearance().borderColor ?? 'var(--border)',
    'padding-block': appearance().density === 'compact' ? '4px' : '8px',
    'padding-inline': appearance().grouped === false ? '0' : '8px',
  })

  return (
    <div
      class="term-search-results"
      data-collapsed={expanded() ? 'false' : 'true'}
      data-density={appearance().density ?? 'comfortable'}
      data-grouped={appearance().grouped === false ? 'false' : 'true'}
      data-highlight-palette={appearance().highlightPalette ?? 'semantic'}
      data-reduced-motion={appearance().reducedMotion === true ? 'true' : 'false'}
      style={cardStyle()}
      role="region"
      aria-label={`搜索结果：${props.part.query || '未命名搜索'}`}
    >
      <Show when={props.part.query}>
        {query => (
          <div class="term-search-head">
            <span class="term-search-query">{query()}</span>
            <span class="term-file-meta-line">{results().length}/{total()} 条</span>
          </div>
        )}
      </Show>
      <ol class="term-search-list" style={{
        display: 'grid',
        gap: appearance().density === 'compact' ? '4px' : '8px',
      }}>
        <For each={shown()}>
          {(entry, index) => (
            <li class="term-search-item" style={itemStyle()}>
              <span class="term-search-rank">{entry.rank ?? index() + 1}</span>
              <div class="term-search-body">
                <Show when={displaySource(entry, appearance().pathDisplay ?? 'full')}>
                  {source => <span class="term-search-source" style={{ color: appearance().mutedForeground ?? 'var(--text-dim)' }}>{source()}</span>}
                </Show>
                <Show when={entry.location?.line !== undefined}>
                  <span class="term-file-range">L{entry.location!.line}</span>
                </Show>
                <Show when={entry.snippet}>
                  {snippet => (
                    <p class="term-search-snippet" style={{
                      display: '-webkit-box',
                      '-webkit-box-orient': 'vertical',
                      '-webkit-line-clamp': String(boundedInteger(appearance().snippetLines, 3, 1, 20)),
                      overflow: 'hidden',
                    }}>
                      <For each={snippetSegments(snippet(), entry.highlights)}>
                        {segment => segment.marked
                          ? <mark class="term-search-mark" style={highlightStyle(appearance().highlightPalette)}>{segment.text}</mark>
                          : <span>{segment.text}</span>}
                      </For>
                    </p>
                  )}
                </Show>
                <Show when={entry.score !== undefined}>
                  <span class="term-file-meta-line" style={{ color: appearance().mutedForeground ?? 'var(--text-dim)' }}>score {entry.score}</span>
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
        <Show when={!expanded() && results().length > Math.min(3, pageLimit())}>
          <button class="term-file-action" type="button" onClick={() => setExpanded(true)}>
            展开结果（已载入 {Math.min(pageLimit(), results().length)}/{results().length}）
          </button>
        </Show>
        <Show when={hasMore()}>
          <button class="term-file-action" type="button" onClick={() => { setExpanded(true); setLoadedPages(count => count + 1) }}>
            加载更多（已显示 {shown().length}/{results().length}）
          </button>
        </Show>
        <Show when={hasMore() === false && total() > results().length && props.part.pagingToken}>
          <span class="term-file-meta-line">其余 {total() - results().length} 条需分页获取</span>
        </Show>
      </div>
    </div>
  )
}

export function SolidLinkBlock(props: { part: LinkContentPart; actions?: SearchLinkActions; appearance?: SearchLinkAppearance }) {
  const url = () => props.part.url
  const allowed = () => isAllowedExternalLink(url())
  const copyFirst = () => props.appearance?.linkOpenMode === 'copy-first'
  const cardStyle = () => ({
    color: props.appearance?.foreground ?? 'var(--text)',
    'background-color': props.appearance?.background ?? 'transparent',
    'border-color': props.appearance?.borderColor ?? 'var(--border)',
    'font-size': `${boundedNumber(props.appearance?.fontSize, 13)}px`,
    'max-width': `${boundedNumber(props.appearance?.maxWidth, 960)}px`,
    'border-style': 'solid',
    'border-width': '1px',
    padding: props.appearance?.density === 'compact' ? '6px' : '10px',
  })
  return (
    <div class="term-link-card" data-part-kind={props.part.kind} data-density={props.appearance?.density ?? 'comfortable'}
      data-open-mode={props.appearance?.linkOpenMode ?? 'external'} style={cardStyle()}>
      <span class="term-file-icon" aria-hidden="true">🔗</span>
      <div class="term-file-meta">
        <span class="term-file-name">{props.part.title || hostOf(url()) || url()}</span>
        <span class="term-file-path" style={{ color: props.appearance?.mutedForeground ?? 'var(--text-dim)' }}>{url()}</span>
        <Show when={props.appearance?.showStatus !== false && props.part.status !== undefined}>
          <span class="term-file-meta-line">HTTP {props.part.status}</span>
        </Show>
      </div>
      <div class="term-file-actions" role="group" aria-label="链接操作">
        <Show when={copyFirst()} fallback={<><LinkOpenButton url={url()} allowed={allowed()} actions={props.actions} /><LinkCopyButton url={url()} allowed={allowed()} actions={props.actions} /></>}>
          <LinkCopyButton url={url()} allowed={allowed()} actions={props.actions} />
          <LinkOpenButton url={url()} allowed={allowed()} actions={props.actions} />
        </Show>
      </div>
    </div>
  )
}

function ExternalLinkButton(props: { url: string; label: string; actions?: SearchLinkActions }) {
  const allowed = () => isAllowedExternalLink(props.url)
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
export function SolidSearchOrLink(props: { part: ContentPart; actions?: SearchLinkActions; appearance?: SearchLinkAppearance }) {
  return (
    <Show
      when={props.part.kind === 'search-result'}
      fallback={
        <Show when={props.part.kind === 'link'} fallback={null}>
          <SolidLinkBlock part={props.part as LinkContentPart} actions={props.actions} appearance={props.appearance} />
        </Show>
      }
    >
      <SolidSearchResultsBlock part={props.part as SearchResultContentPart} actions={props.actions} appearance={props.appearance} />
    </Show>
  )
}

function LinkOpenButton(props: { url: string; allowed: boolean; actions?: SearchLinkActions }) {
  return <button class="term-file-action" type="button"
    disabled={!props.allowed || props.actions?.open === undefined}
    title={!props.allowed ? '协议不在白名单，已禁用' : props.actions?.open ? '打开' : '打开能力未接入'}
    onClick={() => props.allowed && props.actions?.open?.(props.url)}>打开</button>
}

function LinkCopyButton(props: { url: string; allowed: boolean; actions?: SearchLinkActions }) {
  return <button class="term-file-action" type="button"
    disabled={!props.allowed || props.actions?.copy === undefined}
    title={!props.allowed ? '协议不在白名单，已禁用' : props.actions?.copy ? '复制链接' : '复制能力未接入'}
    onClick={() => props.allowed && props.actions?.copy?.(props.url)}>复制</button>
}

function isAllowedExternalLink(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function displaySource(entry: SearchResultEntry, mode: NonNullable<SearchLinkAppearance['pathDisplay']>): string | undefined {
  if (mode === 'hidden') return entry.title
  if (entry.title) return entry.title
  if (mode === 'full') return entry.source
  const normalized = entry.source.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? entry.source
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, Number(value))) : fallback
}

function boundedNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function highlightStyle(palette: SearchLinkAppearance['highlightPalette']) {
  switch (palette) {
    case 'accent': return { 'background-color': 'var(--accent-soft, #dbeafe)', color: 'inherit', 'font-weight': '600' }
    case 'neutral': return { 'background-color': 'var(--surface-hover, #e5e7eb)', color: 'inherit', 'font-weight': '400' }
    default: return { 'background-color': 'var(--selection, #fef3c7)', color: 'inherit', 'font-weight': '500' }
  }
}
