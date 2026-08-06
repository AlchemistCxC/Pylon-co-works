import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { classifyWorkspaceError, mergeWorkspaceEntries, normalizeWorkspaceEntries } from '../../infrastructure/tauri/workspaceContracts.ts'
import type { WorkspaceEntry, WorkspaceTree } from '../../components/right-panel/rightPanelTypes'

/**
 * FileTree — 文件树（W2-04）。
 *
 * list_workspace_entries 懒加载（目录 >1000 上限报错显示并允许换目录，不做前端递归
 * 全扫）；点击文件 → onOpen(path)（打开 tab 由 FileSheetView 承接 metadata）。symlink
 * 条目不自行 resolve（仍传后端相对 path，让后端 containment 校验）。
 */
export default function FileTree({ source, onOpen }: { source: string | null; onOpen: (path: string) => void }) {
  const [tree, setTree] = useState<WorkspaceTree>({ entries: [], selectedPath: null })
  const [error, setError] = useState('')

  const load = useCallback(async (relativePath?: string) => {
    if (!source) return
    try {
      const raw = await invoke('list_workspace_entries', { source, relativePath })
      const entries = normalizeWorkspaceEntries(raw)
      setTree(previous => relativePath
        ? { entries: mergeWorkspaceEntries(previous.entries, relativePath, entries), selectedPath: relativePath }
        : { entries, selectedPath: null })
      setError('')
    } catch (err) {
      setError(classifyWorkspaceError(err).message)
      reportRuntimeError('读取工作区', err)
    }
  }, [source])

  useEffect(() => {
    setTree({ entries: [], selectedPath: null })
    void load()
  }, [load])

  const openFile = (path: string) => {
    if (!source) return
    void invoke('read_workspace_text', { source, relativePath: path }).catch(err => {
      reportRuntimeError('读取文件', err)
    })
    onOpen(path)
  }

  const renderEntries = (entries: readonly WorkspaceEntry[], depth: number): React.ReactNode[] => entries.map(entry => (
    <div key={entry.path} className="file-tree-node" style={{ paddingLeft: depth * 14 + 8 }}>
      {entry.kind === 'folder'
        ? <button type="button" className="file-tree-row file-tree-folder" onClick={() => load(entry.path)} title={entry.path}>
            <span className="file-tree-caret">{entry.expandable === false ? '▾' : '▸'}</span>
            <span className="file-tree-kind" aria-hidden="true">D</span>
            <span className="file-tree-label">{entry.label}</span>
          </button>
        : <button type="button" className="file-tree-row file-tree-file" onClick={() => openFile(entry.path)} title={entry.path}>
            <span className="file-tree-caret file-tree-caret-spacer" aria-hidden="true" />
            <span className="file-tree-kind" aria-hidden="true">F</span>
            <span className="file-tree-label">{entry.label}</span>
          </button>}
      {entry.kind === 'folder' && entry.entries && renderEntries(entry.entries, depth + 1)}
    </div>
  ))

  return (
    <div className="file-tree">
      {error && <div className="file-tree-error" role="alert">{error}</div>}
      {!source && <p className="file-tree-hint">未指向会话</p>}
      {source && tree.entries.length === 0 && !error && <p className="file-tree-hint">空目录</p>}
      {renderEntries(tree.entries, 0)}
    </div>
  )
}
