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
import { FILE_SHEET_MAX_READ_BYTES } from '../../plugins/core/file/builtinFileWorkbench.ts'
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
 * 0-A2（ADR-0023，重审 #252）：**默认可写**——「编辑/退出编辑」按钮退役，打开即可
 * 输入；强制只读仅物理例外（truncated/binary/超限 → 内核只读档）。防误改由三层承接：
 * expectedBaseline 冲突检测（不变）/ 关闭与导航守卫（FileSheetView，不变）/ 写冲突锁
 * （0-A3）。working-diff 面板在有未保存改动时出现，diff 文本 300ms 防抖按需取。
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
  const [truncTotalBytes, setTruncTotalBytes] = useState<number | null>(null)
  const [instruction, setInstruction] = useState('')
  const [summary, setSummary] = useState<KernelSummary>(IDLE_SUMMARY)
  // 0-A3 写冲突锁：locked = agent 写盘冷却期（内核只读）；override = 逃生口
  //（恢复编辑但锁内保存仍禁用，防半成品文件写回）。
  const [writeLocked, setWriteLocked] = useState(false)
  const [lockOverride, setLockOverride] = useState(false)
  const [workingText, setWorkingText] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle')
  const [saveError, setSaveError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [saveReceipt, setSaveReceipt] = useState<FileSaveReceipt | null>(null)
  const saveReceiptVersion = useRef(0)
  const apiRef = useRef<FileCodeEditorApi | null>(null)
  const dirty = summary.dirty
  const editable = !truncated && (!writeLocked || lockOverride)
  const saveBlockedByLock = writeLocked
  const tabKey = tab ? fileTabKey(tab) : null
  const lineCount = summary.lineCount
  const selection = summary.selection
  const selectionLabel = selection
    ? selection.startLine === selection.endLine
      ? `L${selection.startLine}`
      : `L${selection.startLine}–L${selection.endLine}`
    : null

  // working-diff 按需计算：仅在 dirty 时，键击静默 300ms 后取一次全文串。
  // 依赖 summary（内核仅在 dirty/选区/行列真变化时发新摘要）→ 防抖天然生效。
  useEffect(() => {
    if (!summary.dirty || baseline === null) {
      setWorkingText(null)
      return
    }
    const timer = window.setTimeout(() => setWorkingText(apiRef.current?.getDoc() ?? ''), 300)
    return () => window.clearTimeout(timer)
  }, [summary, baseline])

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
    setTruncTotalBytes(null)
    setInstruction(cleared.instruction)
    setSummary(IDLE_SUMMARY)
    setWorkingText(null)
    setWriteLocked(false)
    setLockOverride(false)
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
    if (saveBlockedByLock) return
    if (!apiRef.current) return
    const operationIdentity = viewIdentity
    const content = apiRef.current.getDoc()
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
    setSaveState('idle')
    setSaveError('')
    setSelection(null)
    setReloadToken(token => token + 1)
  }

  const setSelection = (value: KernelSummary['selection']) => {
    setSummary(previous => (previous.selection === value ? previous : { ...previous, selection: value }))
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
        {writeLocked && !lockOverride && (
          <button
            type="button"
            className="file-lock-override"
            onClick={() => setLockOverride(true)}
            title="锁定期间保存仍被禁用（防半成品文件写回）；解锁后可保存"
          >
            仍要编辑
          </button>
        )}
        <button
          type="button"
          className="file-save-btn"
          onClick={() => void handleSave(false)}
          disabled={!dirty || saveState === 'saving' || saveBlockedByLock}
          title={truncated ? '内容不完整（truncated）不可编辑' : saveBlockedByLock ? 'Agent 正在修改此文件，保存暂停' : '保存（Ctrl/⌘+S）'}
        >
          {saveState === 'saving' ? '保存中…' : '保存'}
        </button>
        {saveState === 'saved' && <span className="file-save-ok" role="status">已保存</span>}
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
      {truncated && (
        <div className="file-truncated-hint" role="status">
          {truncTotalBytes
            ? `文件约 ${(truncTotalBytes / 1048576).toFixed(1)} MB，仅预览前 ${FILE_SHEET_MAX_READ_BYTES / 1048576} MB（内容不完整，不可编辑）`
            : '内容不完整（truncated）'}
        </div>
      )}
      <FileTabView
        target={target}
        provider={fileProvider}
        context={context}
        path={tab.path}
        revealLine={tab.line}
        writable={editable}
        baseline={baseline ?? undefined}
        onTruncated={(value, info) => {
          // A truncated response is intentionally read-only.  Never grant an
          // incomplete buffer an editable surface.
          setTruncated(value)
          setTruncTotalBytes(value && info ? info.totalBytes : null)
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
        onWriteLockChange={setWriteLocked}
        onSave={() => {
          if (dirty && saveState !== 'saving') void handleSave(false)
        }}
        saveAnchorToken={reloadToken}
        saveReceipt={saveReceipt}
        apiRef={apiRef}
      />
      {workingPayload && (
        <div className="file-working-diff">
          <DiffCard output="" payload={workingPayload} />
        </div>
      )}
      <div className="file-status-bar" role="status" aria-live="polite">
        <span className="file-status-path" title={tab.path}>{tab.path}</span>
        <span>{lineCount} 行</span>
        {summary.cursor && <span>Ln {summary.cursor.line}, Col {summary.cursor.col}</span>}
        {dirty && <span className="file-status-dirty">+{workingStats.added} −{workingStats.removed} 未保存</span>}
        <span className={selectionLabel ? 'file-status-selection active' : 'file-status-selection'}>
          {selectionLabel ? `已选择 ${selectionLabel}` : '拖选代码以回传会话'}
        </span>
        {writeLocked && (
          <span className="file-status-write-lock" role="status">
            {lockOverride ? 'Agent 正在修改此文件（解锁后可保存）' : 'Agent 正在修改此文件，编辑已暂停'}
          </span>
        )}
        <span>{target?.source || '未指向会话'}</span>
      </div>
    </>
  )
}
