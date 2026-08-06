import { useWorkspaceStore } from '../../workspaceStore'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'

/**
 * FileContextPanel — file 右栏（W2-12，F2-F 反查）。
 *
 * touchedFiles 反向视图：文件→会话（当前 FileSheet 的 source 下关联的会话改动文件）。
 * 数据源同 AgentContextPanel 的 touchedFiles（单一数据源，双向视图）。
 */
export default function FileContextPanel({ ctx }: { ctx: SheetContext }) {
  const source = ctx.sessionSource(ctx.activeSession)
  // zustand v5 useStore 的 selector 返回值即 useSyncExternalStore 快照：`?? []` 每次返回
  // 新数组 → Object.is 不等 → forceStoreRerender 死循环。选整个 record（引用稳定），派生留组件体。
  const touchedFilesRecord = useWorkspaceStore(s => s.touchedFiles)
  const touchedFiles = source ? touchedFilesRecord[source] ?? [] : []

  return (
    <div className="context-panel-body">
      <div className="file-section-title">关联文件（本会话）</div>
      {touchedFiles.length === 0 ? (
        <p className="file-section-hint">agent 尚未改动文件</p>
      ) : (
        <ul className="search-result-list">
          {touchedFiles.map(file => (
            <li key={`${file.path}:${file.at}`}>
              <span className="search-result-path">{file.path}</span>
              <span className="search-result-text">{file.toolKind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
