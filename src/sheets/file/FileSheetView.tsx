import { useMemo, useReducer, useState } from 'react'
import { useWorkspaceStore } from '../../workspaceStore'
import { createFileSheetState, fileSheetReducer, parseOpenTabs, serializeOpenTabs, type FileSheetSection } from './fileSheetState.ts'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import FileSheetSidebar from './FileSheetSidebar'
import FileTree from './FileTree'
import FileTabBar from './FileTabBar'
import FileTabView from './FileTabView'
import GitPanel from './GitPanel'
import DiffView from './DiffView'
import WorkspaceSearchPanel from './WorkspaceSearchPanel'
import DispatchBar from './DispatchBar'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './FileSheet.css'

/**
 * FileSheetView — FileSheet 主视图（W2-03/04，D-08 VS Code 风格改造）。
 *
 * singletonKey = file:{初始 source}（同工作区复用）；内部 targetSource 本地态。
 * metadata 承载 openTabs（JSON 串）/activeFile/truncated（W2-04 组合 action
 * patchSheetMetadata 原子合并、损坏 JSON normalize 为空）。
 * 布局（D-08）：左栏=活动栏 + 分区内容（文件树/SCM/搜索，随分区切换）；
 * 主区=恒定文件视图（tab 条 + 编辑器 + 发令栏），SCM 打开 diff 时主区显示 diff。
 */
export default function FileSheetView({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const initialSource = sheet.singletonKey?.replace(/^file:/, '') ?? ctx.sessionSource(ctx.activeSession)
  const [state, dispatch] = useReducer(fileSheetReducer, initialSource ?? null, createFileSheetState)
  const patchSheetMetadata = useWorkspaceStore(s => s.patchSheetMetadata)

  // metadata 容错：损坏 JSON → 空（不清整个 persistence）
  const openTabs = useMemo(() => parseOpenTabs(sheet.metadata?.openTabs), [sheet.metadata?.openTabs])
  const activeFile = sheet.metadata?.activeFile ?? null
  const [truncated, setTruncated] = useState(false)
  const [activeDiff, setActiveDiff] = useState<{ path: string; staged: boolean } | null>(null)
  const [instruction, setInstruction] = useState('')
  const [selection, setSelection] = useState<DispatchSelection | null>(null)
  const [fileContent, setFileContent] = useState('')

  const selectSection = (section: FileSheetSection) => dispatch({ type: 'set-section', section })
  const selectSource = (source: string) => dispatch({ type: 'set-source', source })

  const openTab = (path: string) => {
    const next = openTabs.includes(path) ? openTabs : [...openTabs, path]
    patchSheetMetadata(sheet.id, { openTabs: serializeOpenTabs(next), activeFile: path })
    setTruncated(false)
  }
  const selectTab = (path: string) => {
    patchSheetMetadata(sheet.id, { activeFile: path })
    setTruncated(false)
  }
  const closeTab = (path: string) => {
    const next = openTabs.filter(tab => tab !== path)
    const nextActive = activeFile === path ? (next[next.length - 1] ?? null) : activeFile
    patchSheetMetadata(sheet.id, {
      openTabs: serializeOpenTabs(next),
      ...(nextActive ? { activeFile: nextActive } : {}),
    })
    if (!nextActive) setTruncated(false)
  }

  return (
    <div className="file-sheet">
      <FileSheetSidebar
        activeSection={state.activeSection}
        targetSource={state.targetSource}
        onSelectSection={selectSection}
        onSelectSource={selectSource}
      >
        {state.activeSection === 'files' && <FileTree source={state.targetSource} onOpen={openTab} />}
        {state.activeSection === 'scm' && (
          <GitPanel source={state.targetSource} onOpenDiff={(path, staged) => setActiveDiff({ path, staged })} />
        )}
        {state.activeSection === 'search' && (
          <WorkspaceSearchPanel source={state.targetSource} onOpenResult={openTab} />
        )}
        {state.activeSection === 'views' && (
          <div className="file-section-panel">
            <div className="file-section-title">视图</div>
            <p className="file-section-hint">视图分区（W2-04 起接线）</p>
          </div>
        )}
      </FileSheetSidebar>
      <main className="file-editor">
        <FileTabBar openTabs={openTabs} activeFile={activeFile} onSelect={selectTab} onClose={closeTab} />
        {activeDiff ? (
          <DiffView source={state.targetSource} path={activeDiff.path} staged={activeDiff.staged} onClose={() => setActiveDiff(null)} />
        ) : activeFile ? (
          <>
            <DispatchBar
              targetSource={state.targetSource}
              filePath={activeFile}
              selection={selection}
              content={fileContent}
              instruction={instruction}
              onInstructionChange={setInstruction}
              onSelectionChange={setSelection}
              onClearSelection={() => setSelection(null)}
            />
            {truncated && <div className="file-truncated-hint" role="status">内容不完整（truncated）</div>}
            <FileTabView source={state.targetSource} path={activeFile} onTruncated={setTruncated} onContentReady={setFileContent} />
          </>
        ) : (
          <div className="file-tab-empty">打开一个文件开始阅读</div>
        )}
      </main>
    </div>
  )
}
