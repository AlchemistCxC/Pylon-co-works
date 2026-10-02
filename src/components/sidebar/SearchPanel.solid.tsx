/** @jsxImportSource solid-js */
import { createMemo, createSignal, For, Show } from 'solid-js'
import { LucideIcon } from '../LucideIcon.solid.tsx'
import { createSolidMount } from '../../host/solidBridge.solid'
import { formatTime } from '../../utils/relativeTime'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/**
 * 搜索模块（VSCode 搜索侧栏那一类**专属工具面板**）。
 *
 * 与「会话模块里嵌一行搜索」的区别是结构性的：它自己拥有查询、自己呈现结果。因此
 * - 会话列表**不再被过滤**（同一个查询驱动两处呈现只会让人分不清哪个是「结果」）；
 * - 输入框在这里是**带框**的——专属面板的输入框就该长得像输入框，这正是它从会话列表里
 *   搬出来的原因（用户：「目前的框已经不适合 ui 界面了」→ 框没问题，位置错了）。
 *
 * 结果按工作区分组（对应 VSCode 的「按文件分组」），命中计数显示在输入框右侧，
 * 点击命中项直接选中该会话。
 */

interface Hit { readonly id: string; readonly name: string; readonly time: string }
interface HitGroup { readonly id: string; readonly label: string; readonly hits: readonly Hit[] }

const LOOSE_GROUP_ID = '__loose__'
const LOOSE_GROUP_LABEL = '无工作区'

/** SearchPanel — 搜索模块（#515 Solid 实体；DOM/aria 契约与 React 版逐字同构）。 */
export default function SearchPanel(props: AgentSidebarContributionProps) {
  // 查询是**这个模块自己的状态**：它不影响其它模块，也不需要上提到宿主。
  const [query, setQuery] = createSignal('')
  const trimmed = createMemo(() => query().trim().toLowerCase())

  const groups = createMemo<readonly HitGroup[]>(() => {
    const needle = trimmed()
    if (needle === '') return []
    const matches = (session: WorkspaceSession) => session.name.toLowerCase().includes(needle)
    const toHit = (session: WorkspaceSession): Hit => ({
      id: session.id,
      name: session.name,
      time: formatTime(session.lastReplyAt || session.lastActiveAt || session.createdAt),
    })

    const out: HitGroup[] = []
    for (const workspace of props.workspaces) {
      const workspaceMatches = `${workspace.name} ${workspace.rootPath}`.toLowerCase().includes(needle)
      const bound = props.sessions.filter(session => session.workspaceId === workspace.id)
      // 工作区自身命中时列出它的全部会话（与 VSCode 搜到文件名即列出该文件一致）。
      const hits = (workspaceMatches ? bound : bound.filter(matches)).map(toHit)
      if (hits.length > 0) out.push({ id: workspace.id, label: workspace.name, hits })
    }
    const loose = props.sessions.filter(session => !session.workspaceId)
    const looseHits = loose.filter(matches).map(toHit)
    if (looseHits.length > 0) out.push({ id: LOOSE_GROUP_ID, label: LOOSE_GROUP_LABEL, hits: looseHits })
    return out
  })

  const total = () => groups().reduce((sum, group) => sum + group.hits.length, 0)

  return (
    <>
      <div class="search-field">
        <LucideIcon name="Search" size={12} />
        <input
          class="search-field-input"
          placeholder="搜索会话"
          aria-label="搜索会话"
          value={query()}
          onInput={event => setQuery(event.currentTarget.value)}
        />
        <Show when={query() !== ''}>
          <button type="button" class="search-field-clear" title="清除" aria-label="清除搜索" onClick={() => setQuery('')}>
            <LucideIcon name="X" size={12} />
          </button>
        </Show>
      </div>

      <Show when={trimmed() === ''}><p class="search-hint">输入会话名或工作区名开始搜索。</p></Show>
      <Show when={trimmed() !== '' && total() === 0}><p class="search-hint">没有匹配的会话。</p></Show>
      <Show when={total() > 0}>
        <>
          <p class="search-count" role="status">{total()} 个匹配</p>
          <div class="search-results" role="tree" aria-label="搜索结果">
            <For each={groups()}>{group => (
              <div class="search-group" role="group" aria-label={group.label}>
                <div class="search-group-head">
                  <span class="search-group-name">{group.label}</span>
                  <span class="search-group-count">{group.hits.length}</span>
                </div>
                <For each={group.hits}>{hit => (
                  <button
                    type="button"
                    role="treeitem"
                    class={`search-hit${props.activeSessionId === hit.id ? ' active' : ''}`}
                    onClick={() => props.onSelectSession(hit.id)}
                  >
                    <span class="search-hit-name">{hit.name}</span>
                    <span class="search-hit-time">{hit.time}</span>
                  </button>
                )}</For>
              </div>
            )}</For>
          </div>
        </>
      </Show>
    </>
  )
}

/** React 薄桥（SearchPanel.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export const renderSearchPanel = createSolidMount(SearchPanel)
