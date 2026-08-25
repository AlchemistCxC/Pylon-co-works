import { fileTabKey, fileTabViewType, type FileTabRecord } from './fileSheetState.ts'

/**
 * FileTabBar — 版本化 tab 条（ISSUE-08 D-02/D-04）。
 *
 * tabs/activeKey 存 sheet metadata（`{version:2,tabs:[{path,mode,staged?}],activeKey}`，
 * 可序列化、重启恢复）。tab 单例 key = `${mode}:${path}`：同路径 file/diff 并存为
 * 两个 tab 且不互相覆盖；关闭/切换均以 key 回调 FileSheetView 的 patchSheetMetadata。
 */
export default function FileTabBar({ tabs, activeKey, dirtyKeys, savingKeys, onSelect, onClose }: {
  tabs: readonly FileTabRecord[]
  activeKey: string | null
  dirtyKeys?: ReadonlySet<string>
  savingKeys?: ReadonlySet<string>
  onSelect: (key: string) => void
  onClose: (key: string) => void
}) {
  if (tabs.length === 0) return null
  return (
    <div className="file-tab-bar" role="tablist" aria-label="已打开文件">
      {tabs.map(tab => {
        const key = fileTabKey(tab)
        const isDiff = fileTabViewType(tab) === 'git.diff'
        const label = isDiff ? `${tab.path}（diff）` : tab.path
        const dirty = dirtyKeys?.has(key) === true
        const saving = savingKeys?.has(key) === true
        return (
          <span
            key={key}
            role="tab"
            aria-selected={activeKey === key}
            className={`file-tab ${activeKey === key ? 'active' : ''} ${isDiff ? 'file-tab-diff' : ''} ${dirty ? 'dirty' : ''} ${saving ? 'saving' : ''}`}
            data-dirty={dirty ? 'true' : undefined}
            data-saving={saving ? 'true' : undefined}
            onClick={() => onSelect(key)}
            title={label}
          >
            <span className="file-tab-name">{tab.path.split('/').pop()}</span>
            {isDiff && <span className="file-tab-mode">{tab.staged ? 'staged' : 'unstaged'}</span>}
            {saving
              ? <span className="file-tab-state saving" role="status" aria-label={`正在保存 ${label}`}>…</span>
              : dirty
                ? <span className="file-tab-state dirty" role="status" aria-label={`未保存 ${label}`}>●</span>
                : null}
            <button
              type="button"
              className="file-tab-close"
              aria-label={`关闭 ${label}`}
              disabled={saving}
              onClick={event => { event.stopPropagation(); onClose(key) }}
            >
              ✕
            </button>
          </span>
        )
      })}
    </div>
  )
}
