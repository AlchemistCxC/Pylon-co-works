import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { createWorkspaceClient } from '../../infrastructure/tauri/workspaceClient'
import { classifyWorkspaceError, mergeWorkspaceEntries, normalizeWorkspaceEntries } from '../../infrastructure/tauri/workspaceContracts.ts'
import type { WorkspaceEntry, WorkspaceTree } from '../../components/right-panel/rightPanelTypes'
import FileTypeIcon from './FileTypeIcon'

/**
 * FileTree — 懒加载、可双向折叠的工作区文件树。
 *
 * 已加载子树保留在内存，折叠只隐藏 descendants；再次展开不重复请求。缩进封顶并强制
 * label ellipsis，深层目录不会撑宽 FileSheet 左栏。
 */
export default function FileTree({ source, activeFile, onOpen }: {
  source: string | null
  activeFile: string | null
  onOpen: (path: string) => void
}) {
  const [tree, setTree] = useState<WorkspaceTree>({ entries: [], selectedPath: null })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')

  const load = useCallback(async (relativePath?: string) => {
    if (!source) return
    const key = relativePath ?? ''
    setLoading(previous => new Set(previous).add(key))
    try {
      const raw = await createWorkspaceClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).listEntries(relativePath ?? '')
      const entries = normalizeWorkspaceEntries(raw)
      setTree(previous => relativePath
        ? { entries: mergeWorkspaceEntries(previous.entries, relativePath, entries), selectedPath: previous.selectedPath }
        : { entries, selectedPath: previous.selectedPath })
      setError('')
    } catch (err) {
      setError(classifyWorkspaceError(err).message)
      reportRuntimeError('读取工作区', err)
    } finally {
      setLoading(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }, [source])

  useEffect(() => {
    setTree({ entries: [], selectedPath: null })
    setExpanded(new Set())
    setLoading(new Set())
    void load()
  }, [load])

  const toggleFolder = async (entry: WorkspaceEntry) => {
    if (expanded.has(entry.path)) {
      setExpanded(previous => {
        const next = new Set(previous)
        next.delete(entry.path)
        return next
      })
      return
    }
    if (!entry.entries) await load(entry.path)
    setExpanded(previous => new Set(previous).add(entry.path))
  }

  const openFile = (path: string) => {
    if (!source) return
    setTree(previous => ({ ...previous, selectedPath: path }))
    void createWorkspaceClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).readText(path).catch(err => {
      reportRuntimeError('读取文件', err)
    })
    onOpen(path)
  }

  const renderEntries = (entries: readonly WorkspaceEntry[], depth: number): React.ReactNode[] => entries.map(entry => {
    const isFolder = entry.kind === 'folder'
    const isExpanded = isFolder && expanded.has(entry.path)
    const isLoading = isFolder && loading.has(entry.path)
    const isActive = !isFolder && (activeFile === entry.path || tree.selectedPath === entry.path)
    return (
      <div key={entry.path} className="file-tree-node">
        <button
          type="button"
          className={`file-tree-row ${isFolder ? 'file-tree-folder' : 'file-tree-file'} ${isActive ? 'active' : ''}`}
          style={{ '--file-tree-depth': Math.min(depth, 8) } as React.CSSProperties}
          onClick={() => isFolder ? void toggleFolder(entry) : openFile(entry.path)}
          title={entry.path}
          aria-expanded={isFolder ? isExpanded : undefined}
        >
          <span className={`file-tree-caret ${!isFolder ? 'file-tree-caret-spacer' : ''}`} aria-hidden="true">
            {isFolder && (isLoading ? '…' : isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          </span>
          <span className="file-tree-kind" aria-hidden="true">
            {isFolder
              ? isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />
              : <FileTypeIcon path={entry.path} size={14} />}
          </span>
          <span className="file-tree-label">{entry.label}</span>
        </button>
        {isFolder && isExpanded && entry.entries && (
          <div className="file-tree-children">{renderEntries(entry.entries, depth + 1)}</div>
        )}
      </div>
    )
  })

  return (
    <div className="file-tree">
      <div className="file-panel-heading">
        <span>EXPLORER</span>
        <span className="file-panel-count">{tree.entries.length}</span>
      </div>
      {error && <div className="file-tree-error" role="alert">{error}</div>}
      {!source && (
        <div className="sheet-empty-state file-tree-empty-state" role="status">
          <div className="sheet-empty-mark" aria-hidden="true">⌁</div>
          <strong>尚未选择工作区</strong>
          <span>先从会话分区选择一个 source，再浏览文件。</span>
        </div>
      )}
      {source && tree.entries.length === 0 && !error && !loading.has('') && (
        <div className="sheet-empty-state file-tree-empty-state" role="status">
          <div className="sheet-empty-mark" aria-hidden="true">⌁</div>
          <strong>工作区为空</strong>
          <span>当前 source 没有可浏览的文件。</span>
        </div>
      )}
      <div className="file-tree-rows">{renderEntries(tree.entries, 0)}</div>
    </div>
  )
}
