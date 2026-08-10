import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import { fileTabKey, resetFileSheetTransientState, type FileTabRecord } from './fileSheetState.ts'
import FileTabView from './FileTabView'
import DiffView from './DiffView'
import DispatchBar from './DispatchBar'
import DiffCard from '../../components/chat/DiffCard'
import { classifySaveError, saveWorkspaceText } from './workspaceWrite.ts'
import { workingDiffLines, workingDiffStats } from './workingDiff.ts'

/**
 * FileViewHost — 主区统一 file/diff 宿主（ISSUE-08 D-03/D-04 + I08-A-FE-02 保存）。
 *
 * 由 FileSheetView 传入活动 tab（版本化 tab 记录），按 mode 渲染：
 * file → 发令栏 + 编辑工具栏 + 文件视图 + working-diff 面板 + 状态栏；
 * diff → DiffView（复用 DiffCard）；无 tab → 空态。
 * 真实编辑/save：基线 = 最近一次成功保存（或加载）的磁盘文本；编辑中 dirty =
 * 内容 ≠ 基线；保存带 expectedBaseline 走后端冲突检测（AC-1：外部修改不静默覆盖），
 * conflict → 覆盖保存（force）或重新加载；working-diff = 基线 vs 未保存编辑。
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
  const [editing, setEditing] = useState(false)
  const [baseline, setBaseline] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle')
  const [saveError, setSaveError] = useState('')
  const [saveAnchor, setSaveAnchor] = useState(0)
  const transport = useMemo(
    () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args as Record<string, unknown> | undefined) }),
    [],
  )
  const lineCount = fileContent ? fileContent.split('\n').length : 0
  const selectionLabel = selection
    ? selection.startLine === selection.endLine
      ? `L${selection.startLine}`
      : `L${selection.startLine}–L${selection.endLine}`
    : null
  const dirty = baseline !== null && fileContent !== baseline
  const workingPayload = useMemo(() => {
    if (baseline === null || !dirty) return null
    return { oldText: baseline, newText: fileContent, lines: workingDiffLines(baseline, fileContent) }
  }, [baseline, fileContent, dirty])
  const workingStats = useMemo(() => workingDiffStats(workingPayload?.lines ?? []), [workingPayload])

  useEffect(() => {
    if (source !== null) return
    const cleared = resetFileSheetTransientState()
    setTruncated(cleared.truncated)
    setInstruction(cleared.instruction)
    setFileContent(cleared.fileContent)
    setSelection(null)
    setEditing(false)
  }, [source])

  useEffect(() => {
    setTruncated(false)
    setEditing(false)
    setBaseline(null)
    setSaveState('idle')
    setSaveError('')
    setSelection(null)
  }, [tab?.path, tab?.mode])

  const handleSave = async (force: boolean) => {
    if (!source || !tab || tab.mode !== 'file' || baseline === null) return
    setSaveState('saving')
    setSaveError('')
    try {
      const result = await saveWorkspaceText(transport, {
        source,
        relativePath: tab.path,
        content: fileContent,
        expectedBaseline: force ? null : baseline,
        force,
      })
      if (result) {
        setFileContent(result.content)
        setBaseline(result.content)
        setSaveState('saved')
        setSaveAnchor(anchor => anchor + 1)
        setSelection(null)
      } else {
        // 响应损坏（normalize 为 null）：不卡 saving，置 error 态并可重试
        setSaveError('保存响应异常，请重试')
        setSaveState('error')
      }
    } catch (err) {
      const detail = classifySaveError(err)
      setSaveError(detail.message)
      setSaveState(detail.code === 'conflict' ? 'conflict' : 'error')
    }
  }

  const discardAndReload = () => {
    setEditing(false)
    setSaveState('idle')
    setSaveError('')
    setSelection(null)
    setSaveAnchor(anchor => anchor + 1)
  }

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
      <div className="file-edit-toolbar">
        <button
          type="button"
          className="file-edit-toggle"
          onClick={() => { setEditing(value => !value); setSelection(null) }}
          disabled={truncated || !source}
          title={truncated ? '内容不完整（truncated）不可编辑' : undefined}
        >
          {editing ? '退出编辑' : '编辑'}
        </button>
        {editing && (
          <>
            <button
              type="button"
              className="file-save-btn"
              onClick={() => void handleSave(false)}
              disabled={!dirty || saveState === 'saving'}
            >
              {saveState === 'saving' ? '保存中…' : '保存'}
            </button>
            {saveState === 'saved' && <span className="file-save-ok" role="status">已保存</span>}
          </>
        )}
        {saveState === 'error' && <span className="file-save-error" role="alert">{saveError}</span>}
      </div>
      {saveState === 'conflict' && (
        <div className="file-conflict-banner" role="alert">
          <span className="file-conflict-text">磁盘文件已被外部修改，直接保存将被拒绝。</span>
          <button type="button" className="file-conflict-force" onClick={() => void handleSave(true)}>
            覆盖保存
          </button>
          <button type="button" className="file-conflict-reload" onClick={discardAndReload}>重新加载</button>
        </div>
      )}
      {truncated && <div className="file-truncated-hint" role="status">内容不完整（truncated）</div>}
      <FileTabView
        source={source}
        path={tab.path}
        editing={editing}
        onTruncated={setTruncated}
        onContentReady={content => { setFileContent(content); setBaseline(content) }}
        onContentChange={setFileContent}
        onExternalChange={() => {
          if (fileContent !== baseline) {
            setSaveState('conflict')
            setSaveError('文件已被外部修改（保存前请选择覆盖或重新加载）')
          }
        }}
        onSelectionChange={setSelection}
        onSelectionInvalidated={() => setSelection(null)}
        saveAnchorToken={saveAnchor}
      />
      {editing && workingPayload && (
        <div className="file-working-diff">
          <DiffCard output="" payload={workingPayload} />
        </div>
      )}
      <div className="file-status-bar" role="status" aria-live="polite">
        <span className="file-status-path" title={tab.path}>{tab.path}</span>
        <span>{lineCount} 行</span>
        {editing && <span>编辑中</span>}
        {editing && dirty && <span className="file-status-dirty">+{workingStats.added} −{workingStats.removed} 未保存</span>}
        <span className={selectionLabel ? 'file-status-selection active' : 'file-status-selection'}>
          {selectionLabel ? `已选择 ${selectionLabel}` : '拖选代码以回传会话'}
        </span>
        <span>{source || '未指向会话'}</span>
      </div>
    </>
  )
}
