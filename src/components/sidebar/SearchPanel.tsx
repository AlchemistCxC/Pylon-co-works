import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
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

export default function SearchPanel(props: AgentSidebarContributionProps) {
  // 查询是**这个模块自己的状态**：它不影响其它模块，也不需要上提到宿主。
  const [query, setQuery] = useState('')
  const trimmed = query.trim().toLowerCase()
  // 依赖列表用解构出的两项而非整个 props：props 每次渲染都是新对象，写进去等于每帧重算。
  const { sessions, workspaces } = props

  const groups = useMemo<readonly HitGroup[]>(() => {
    if (trimmed === '') return []
    const matches = (session: WorkspaceSession) => session.name.toLowerCase().includes(trimmed)
    const toHit = (session: WorkspaceSession): Hit => ({
      id: session.id,
      name: session.name,
      time: formatTime(session.lastReplyAt || session.lastActiveAt || session.createdAt),
    })

    const out: HitGroup[] = []
    for (const workspace of workspaces) {
      const workspaceMatches = `${workspace.name} ${workspace.rootPath}`.toLowerCase().includes(trimmed)
      const bound = sessions.filter(session => session.workspaceId === workspace.id)
      // 工作区自身命中时列出它的全部会话（与 VSCode 搜到文件名即列出该文件一致）。
      const hits = (workspaceMatches ? bound : bound.filter(matches)).map(toHit)
      if (hits.length > 0) out.push({ id: workspace.id, label: workspace.name, hits })
    }
    const loose = sessions.filter(session => !session.workspaceId)
    const looseHits = loose.filter(matches).map(toHit)
    if (looseHits.length > 0) out.push({ id: LOOSE_GROUP_ID, label: LOOSE_GROUP_LABEL, hits: looseHits })
    return out
  }, [trimmed, sessions, workspaces])

  const total = groups.reduce((sum, group) => sum + group.hits.length, 0)

  return (
    <>
      <div className="search-field">
        <Search size={12} aria-hidden="true" />
        <input
          className="search-field-input"
          placeholder="搜索会话"
          aria-label="搜索会话"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        {query !== '' && (
          <button type="button" className="search-field-clear" title="清除" aria-label="清除搜索" onClick={() => setQuery('')}>
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      {trimmed === '' && <p className="search-hint">输入会话名或工作区名开始搜索。</p>}
      {trimmed !== '' && total === 0 && <p className="search-hint">没有匹配的会话。</p>}
      {total > 0 && (
        <>
          <p className="search-count" role="status">{total} 个匹配</p>
          <div className="search-results" role="tree" aria-label="搜索结果">
            {groups.map(group => (
              <div className="search-group" key={group.id} role="group" aria-label={group.label}>
                <div className="search-group-head">
                  <span className="search-group-name">{group.label}</span>
                  <span className="search-group-count">{group.hits.length}</span>
                </div>
                {group.hits.map(hit => (
                  <button
                    key={hit.id}
                    type="button"
                    role="treeitem"
                    className={`search-hit${props.activeSessionId === hit.id ? ' active' : ''}`}
                    onClick={() => props.onSelectSession(hit.id)}
                  >
                    <span className="search-hit-name">{hit.name}</span>
                    <span className="search-hit-time">{hit.time}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
