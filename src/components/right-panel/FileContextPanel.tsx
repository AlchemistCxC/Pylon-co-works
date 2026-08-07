import { useWorkspaceStore } from '../../workspaceStore'
import { useIdentityStore } from '../../identityStore'
import { sourcesForPath } from '../../domains/file/fileRelations'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import './ContextPanel.css'

/**
 * FileContextPanel — file 右栏（W2-12，FE-AUD-022 反查）。
 *
 * 读取当前 FileSheet 的 activeFile（metadata），反查所有改动过它的会话
 * （path → sources，Windows 路径统一 normalize）；点击关联会话 → 返回
 * Agent Sheet 并选中该会话。不猜全局 activeSession。
 */
export default function FileContextPanel({ ctx }: { ctx: SheetContext }) {
  // 当前 FileSheet 的 activeFile（不猜全局 activeSession——报告 5D.2）
  const activeFile = useWorkspaceStore(state => {
    const fileSheets = state.workspaceSheets.sheets.filter(sheet => sheet.kind === 'file')
    const active = fileSheets.find(sheet => sheet.id === state.workspaceSheets.activeSheetId) ?? fileSheets[0]
    return active?.metadata?.activeFile ?? null
  })
  // zustand v5 useStore 的 selector 返回值即 useSyncExternalStore 快照：`?? []` 每次返回
  // 新数组 → Object.is 不等 → forceStoreRerender 死循环。选整个 record（引用稳定），派生留组件体。
  const touchedFilesRecord = useWorkspaceStore(s => s.touchedFiles)
  const relatedSources = activeFile ? sourcesForPath(touchedFilesRecord, activeFile) : []
  const sessions = useIdentityStore(s => s.sessions)
  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'

  return (
    <div className="context-panel-body">
      <div className="file-section-title">关联会话（{activeFile ?? '无文件'}）</div>
      {!activeFile ? (
        <p className="file-section-hint">打开一个文件后显示改动过它的会话</p>
      ) : relatedSources.length === 0 ? (
        <p className="file-section-hint">暂无会话改动此文件</p>
      ) : (
        <ul className="search-result-list">
          {relatedSources.map(source => {
            const session = sessions.find(item => item.source === source)
            return (
              <li key={source}>
                <button
                  type="button"
                  className="search-result-row"
                  onClick={() => {
                    ctx.selectSession(session?.id ?? null)
                    ctx.openSheet({ kind: 'agent', title: session?.name || source, agentId: activeAgent })
                  }}
                >
                  <span className="search-result-path">{source}</span>
                  <span className="search-result-text">{session?.name ?? '外部会话'}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
