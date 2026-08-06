/**
 * FileTabBar — 多文件 tab 条（W2-04，S24 方案 A）。
 *
 * openTabs/activeFile 存 sheet metadata（可序列化、重启恢复）；关闭/切换经
 * FileSheetView 的 patchSheetMetadata 原子合并。最后一个 tab 关闭后 activeFile=null。
 */
export default function FileTabBar({ openTabs, activeFile, onSelect, onClose }: {
  openTabs: readonly string[]
  activeFile: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
}) {
  if (openTabs.length === 0) return null
  return (
    <div className="file-tab-bar" role="tablist" aria-label="已打开文件">
      {openTabs.map(path => (
        <span
          key={path}
          role="tab"
          aria-selected={activeFile === path}
          className={`file-tab ${activeFile === path ? 'active' : ''}`}
          onClick={() => onSelect(path)}
          title={path}
        >
          <span className="file-tab-name">{path.split('/').pop()}</span>
          <button
            type="button"
            className="file-tab-close"
            aria-label={`关闭 ${path}`}
            onClick={event => { event.stopPropagation(); onClose(path) }}
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  )
}
