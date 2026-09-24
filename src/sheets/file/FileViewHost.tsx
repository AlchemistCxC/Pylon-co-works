import { useEffect, useMemo, useRef, useState } from 'react'
import { fileTabKey, fileTabViewType, resetFileSheetTransientState, type FileTabRecord } from './fileSheetState.ts'
import FileTabView, { type FileSaveReceipt, type FileCodeEditorApi, type KernelSummary } from './FileTabView'
import DiffView from './DiffView'
import DispatchBar from './DispatchBar'
import DiffCard from '../../components/chat/DiffCard'
import { classifySaveError } from './workspaceWrite.ts'
import { workingDiffLines, workingDiffStats } from './workingDiff.ts'
import type { AgentContext } from '../../agentContext'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider, GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { legacyFileProvider, legacyGitProvider, legacyTarget } from './legacyFileProvider.ts'
import { workspaceTargetKey } from '../../domains/workspace/workspaceTarget.ts'

const IDLE_SUMMARY: KernelSummary = { dirty: false, selection: null, lineCount: 0, cursor: null }

/**
 * FileViewHost — 主区统一 file/diff 宿主（ISSUE-08 D-03/D-04 + I08-A-FE-02 保存）。
 *
 * 由 FileSheetView 传入活动 tab（版本化 tab 记录），按 viewType 渲染：
 * file → 发令栏 + 编辑工具栏 + 文件视图 + working-diff 面板 + 状态栏；
 * diff → DiffView（复用 DiffCard）；无 tab → 空态。
 * 0-A1 内核合一后本宿主**不再持有内容全文 state**：编辑事实来自内核 KernelSummary
 * （dirty = doc.eq(baselineDoc) 结构共享比较），保存/working-diff 经 apiRef 句柄按需
 * 取全文（键击路径零全文串）。基线 = 最近一次成功保存（或加载）的磁盘文本；编辑中
 * dirty → 保存带 expectedBaseline 走后端冲突检测（AC-1：外部修改不静默覆盖），
 * conflict → 覆盖保存（force）或重新加载。
 * #252（阶段〇保留）：打开默认只读——「编辑」显式进可写态；working-diff 面板仅在
 * 编辑态且有未保存改动时出现，diff 文本 300ms 防抖按需取（键击路径零全文串）。
 */
export default function FileViewHost({ target: explicitTarget, source, fileProvider: explicitFileProvider, gitProvider: explicitGitProvider, tab, context, onCloseTab, onDirtyChange, onSavingChange }: {
  target?: WorkspaceTarget | null
  /** @deprecated direct component compatibility. */ source?: string | null
  fileProvider?: FileProvider | null
  gitProvider?: GitProvider | null
  context?: AgentContext | null
  tab: FileTabRecord | null
  onCloseTab: (key: string) => void
  onDirtyChange?: (key: string, dirty: boolean) => void
  onSavingChange?: (key: string, saving: boolean) => void
}) {
  const target = explicitTarget === undefined ? legacyTarget(source) : explicitTarget
  const fileProvider = explicitFileProvider === undefined && source ? legacyFileProvider : explicitFileProvider ?? null
  const gitProvider = explicitGitProvider === undefined && source ? legacyGitProvider : explicitGitProvider ?? null
  const viewIdentity = `${workspaceTargetKey(target) ?? 'unbound'}:${tab ? fileTabKey(tab) : 'empty'}`
  const currentViewIdentity = useRef(viewIdentity)
  currentViewIdentity.current = viewIdentity
  const [truncated, setTruncated] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [summary, setSummary] = useState<KernelSummary>(IDLE_SUMMARY)
  const [workingText, setWorkingText] = useState<string | null>(null)
  // #252：打开文件默认只读预览——阅读是 File 工作台的高频路径，显式点「编辑」才
  // 进入编辑态（高危的「可写入真实仓库文件」状态不设为默认态）。
  const [editing, setEditing] = useState(false)
  const [baseline, setBaseline] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle')
  const [saveError, setSaveError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [saveReceipt, setSaveReceipt] = useState<FileSaveReceipt | null>(null)
  const saveReceiptVersion = useRef(0)
  const apiRef = useRef<FileCodeEditorApi | null>(null)
  const dirty = summary.dirty
  const tabKey = tab ? fileTabKey(tab) : null
  const lineCount = summary.lineCount
  const selection = summary.selection
  const selectionLabel = selection
    ? selection.startLine === selection.endLine
      ? `L${selection.startLine}`
      : `L${selection.startLine}–L${selection.endLine}`
    : null

  // working-diff 按需计算：仅在编辑态且 dirty 时，键击静默 300ms 后取一次全文串。
  // 依赖 summary（内核仅在 dirty/选区/行列真变化时发新摘要）→ 防抖天然生效。
  useEffect(() => {
    if (!editing || !summary.dirty || baseline === null) {
      setWorkingText(null)
      return
    }
    const timer = window.setTimeout(() => setWorkingText(apiRef.current?.getDoc() ?? ''), 300)
    return () => window.clearTimeout(timer)
  }, [summary, editing, baseline])

  const workingPayload = useMemo(() => {
    if (baseline === null || workingText === null || !dirty) return null
    return { oldText: baseline, newText: workingText, lines: workingDiffLines(baseline, workingText) }
  }, [baseline, workingText, dirty])
  const workingStats = useMemo(() => workingDiffStats(workingPayload?.lines ?? []), [workingPayload])

  useEffect(() => {
    if (!tabKey) return
    onDirtyChange?.(tabKey, dirty)
    return () => onDirtyChange?.(tabKey, false)
  }, [dirty, onDirtyChange, tabKey])

  useEffect(() => {
    if (!tabKey) return
    onSavingChange?.(tabKey, saveState === 'saving')
    return () => onSavingChange?.(tabKey, false)
  }, [onSavingChange, saveState, tabKey])

  useEffect(() => {
    const cleared = resetFileSheetTransientState()
    setTruncated(cleared.truncated)
    setInstruction(cleared.instruction)
    setSummary(IDLE_SUMMARY)
    setWorkingText(null)
    setEditing(false)
    setBaseline(null)
    setSaveState('idle')
    setSaveError('')
    setSaveReceipt(null)
  }, [viewIdentity])

  const handleSummaryChange = (next: KernelSummary) => {
    setSummary(next)
  }

  const handleSave = async (force: boolean) => {
    if (!target || !fileProvider?.writeText || !tab || fileTabViewType(tab) !== 'file.text' || baseline === null) return
    const operationIdentity = viewIdentity
    const content = apiRef.current?.getDoc() ?? ''
    const contentAtStart = content
    setSaveState('saving')
    setSaveError('')
    try {
      const result = await fileProvider.writeText(target, {
        relativePath: tab.path,
        content,
        expectedBaseline: force ? null : baseline,
        force,
      })
      if (currentViewIdentity.current !== operationIdentity) return
      if (result) {
        const hasNewerEdits = (apiRef.current?.getDoc() ?? '') !== contentAtStart
        setBaseline(result.content)
        setSaveState(hasNewerEdits ? 'idle' : 'saved')
        setSaveReceipt({
          version: ++saveReceiptVersion.current,
          expectedContent: contentAtStart,
          persistedContent: result.content,
        })
        if (!hasNewerEdits) setSummary(previous => ({ ...previous, selection: null }))
      } else {
        // 响应损坏（normalize 为 null）：不卡 saving，置 error 态并可重试
        setSaveError('保存响应异常，请重试')
        setSaveState('error')
      }
    } catch (err) {
      if (currentViewIdentity.current !== operationIdentity) return
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
    setReloadToken(token => token + 1)
  }

  const setSelection = (value: KernelSummary['selection']) => {
    setSummary(previous => (previous.selection === value ? previous : { ...previous, selection: value }))
  }

  // #252：退出编辑即离开「可写面」。有未保存改动时先确认——确认则丢弃并重拉磁盘
  // （与 conflict 的「重新加载」同一条 discard 路径），取消则留在编辑态。
  const handleExitEdit = () => {
    if (dirty && !window.confirm('放弃未保存的修改并退出编辑吗？')) return
    if (dirty) discardAndReload()
    else {
      setEditing(false)
      setSelection(null)
    }
  }

  const handleToggleEdit = () => {
    if (editing) handleExitEdit()
    else {
      setSelection(null)
      setEditing(true)
    }
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

  if (fileTabViewType(tab) === 'git.diff') {
    return (
      <DiffView
        target={target}
        provider={gitProvider}
        path={tab.path}
        staged={tab.staged ?? false}
        onClose={() => onCloseTab(fileTabKey(tab))}
      />
    )
  }

  return (
    <>
      <DispatchBar
        targetSource={target?.source ?? null}
        targetSessionId={target?.sessionId ?? null}
        context={context}
        filePath={tab.path}
        selection={selection}
        getContent={() => apiRef.current?.getDoc() ?? ''}
        instruction={instruction}
        onInstructionChange={setInstruction}
        onClearSelection={() => setSelection(null)}
      />
      <div className="file-edit-toolbar">
        <button
          type="button"
          className="file-edit-toggle"
          onClick={handleToggleEdit}
          disabled={truncated || !target || saveState === 'saving'}
          title={truncated ? '内容不完整（truncated）不可编辑' : saveState === 'saving' ? '保存进行中，请稍候' : undefined}
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
              title="保存（Ctrl/⌘+S）"
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
        target={target}
        provider={fileProvider}
        context={context}
        path={tab.path}
        revealLine={tab.line}
        editing={editing}
        baseline={baseline ?? undefined}
        onTruncated={value => {
          setTruncated(value)
          // A truncated response is intentionally read-only.  Never grant an
          // incomplete buffer an editable surface, whatever mode was active.
          if (value) setEditing(false)
        }}
        onContentReady={content => { setBaseline(content) }}
        onExternalChange={() => {
          if (dirty) {
            setSaveState('conflict')
            setSaveError('文件已被外部修改（保存前请选择覆盖或重新加载）')
          }
        }}
        onSelectionInvalidated={() => setSelection(null)}
        onSummaryChange={handleSummaryChange}
        onSave={() => {
          if (dirty && saveState !== 'saving') void handleSave(false)
        }}
        saveAnchorToken={reloadToken}
        saveReceipt={saveReceipt}
        apiRef={apiRef}
      />
      {editing && workingPayload && (
        <div className="file-working-diff">
          <DiffCard output="" payload={workingPayload} />
        </div>
      )}
      <div className="file-status-bar" role="status" aria-live="polite">
        <span className="file-status-path" title={tab.path}>{tab.path}</span>
        <span>{lineCount} 行</span>
        {summary.cursor && <span>Ln {summary.cursor.line}, Col {summary.cursor.col}</span>}
        {editing && <span>编辑中</span>}
        {editing && dirty && <span className="file-status-dirty">+{workingStats.added} −{workingStats.removed} 未保存</span>}
        <span className={selectionLabel ? 'file-status-selection active' : 'file-status-selection'}>
          {selectionLabel ? `已选择 ${selectionLabel}` : '拖选代码以回传会话'}
        </span>
        <span>{target?.source || '未指向会话'}</span>
      </div>
    </>
  )
}
