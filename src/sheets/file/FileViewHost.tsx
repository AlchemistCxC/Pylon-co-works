import { useEffect, useState } from 'react'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import { fileTabKey, resetFileSheetTransientState, type FileTabRecord } from './fileSheetState.ts'
import FileTabView from './FileTabView'
import DiffView from './DiffView'
import DispatchBar from './DispatchBar'

/**
 * FileViewHost — 主区统一 file/diff 宿主（ISSUE-08 D-03/D-04）。
 *
 * 由 FileSheetView 传入活动 tab（版本化 tab 记录），按 mode 渲染：
 * file → 发令栏 + 文件视图 + 状态栏；diff → DiffView（复用 DiffCard）；无 tab → 空态。
 * 承载编辑器瞬态（truncated/instruction/selection/fileContent）：source 清空时重置
 * （与 FileSheet 目标清除语义一致）；切换 tab 重置 truncated 提示（重新加载后自会刷新）。
 */
export default function FileViewHost({ source, tab, onCloseTab }: {
  source: string | null
  tab: FileTabRecord | null
  onCloseTab: (key: string) => void
}) {
  const [truncated, setTruncated] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [selection, setSelection] = useState<DispatchSelection | null>(null)
  const [fileContent, setFileContent] = useState('')
  const lineCount = fileContent ? fileContent.split('\n').length : 0
  const selectionLabel = selection
    ? selection.startLine === selection.endLine
      ? `L${selection.startLine}`
      : `L${selection.startLine}–L${selection.endLine}`
    : null

  useEffect(() => {
    if (source !== null) return
    const cleared = resetFileSheetTransientState()
    setTruncated(cleared.truncated)
    setInstruction(cleared.instruction)
    setFileContent(cleared.fileContent)
    setSelection(null)
  }, [source])

  useEffect(() => {
    setTruncated(false)
  }, [tab?.path, tab?.mode])

  if (!tab) {
    return (
      <div className="file-tab-empty">
        <div className="file-empty-card">
          <div className="file-empty-mark" aria-hidden="true">{'</>'}</div>
          <strong>打开一个文件开始阅读</strong>
          <span>从左侧文件树选择文件，或切换到 SCM 查看改动。</span>
          <span className="file-empty-shortcut">选中文本后，可在下方发令栏发送给当前会话</span>
        </div>
      </div>
    )
  }

  if (tab.mode === 'diff') {
    return (
      <DiffView
        source={source}
        path={tab.path}
        staged={tab.staged ?? false}
        onClose={() => onCloseTab(fileTabKey(tab))}
      />
    )
  }

  return (
    <>
      <DispatchBar
        targetSource={source}
        filePath={tab.path}
        selection={selection}
        content={fileContent}
        instruction={instruction}
        onInstructionChange={setInstruction}
        onSelectionChange={setSelection}
        onClearSelection={() => setSelection(null)}
      />
      {truncated && <div className="file-truncated-hint" role="status">内容不完整（truncated）</div>}
      <FileTabView
        source={source}
        path={tab.path}
        onTruncated={setTruncated}
        onContentReady={setFileContent}
        onSelectionInvalidated={() => setSelection(null)}
      />
      <div className="file-status-bar" role="status" aria-live="polite">
        <span className="file-status-path" title={tab.path}>{tab.path}</span>
        <span>{lineCount} 行</span>
        <span className={selectionLabel ? 'file-status-selection active' : 'file-status-selection'}>
          {selectionLabel ? `已选择 ${selectionLabel}` : '拖选代码以回传会话'}
        </span>
        <span>{source || '未指向会话'}</span>
      </div>
    </>
  )
}
