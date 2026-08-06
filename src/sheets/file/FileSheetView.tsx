import { useMemo, useReducer, useState } from 'react'
import { useWorkspaceStore } from '../../workspaceStore'
import { createFileSheetState, fileSheetReducer, parseOpenTabs, serializeOpenTabs, type FileSheetSection } from './fileSheetState.ts'
import FileSheetSidebar from './FileSheetSidebar'
import FileTree from './FileTree'
import FileTabBar from './FileTabBar'
import FileTabView from './FileTabView'
import GitPanel from './GitPanel'
import DiffView from './DiffView'
import WorkspaceSearchPanel from './WorkspaceSearchPanel'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './FileSheet.css'

/**
 * FileSheetView — FileSheet 主视图（W2-03/04）。
 *
 * singletonKey = file:{初始 source}（同工作区复用）；内部 targetSource 本地态。
 * metadata 承载 openTabs（JSON 串）/activeFile/truncated（W2-04 组合 action
 * patchSheetMetadata 原子合并、损坏 JSON normalize 为空）。文件树懒加载 + 多 tab +
 * 只读代码/md 视图（消费 8 编辑器 cssVar）。
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

  const filesSection = (
    <main className="file-main">
      {state.targetSource && (
        <>
          <FileTree source={state.targetSource} onOpen={openTab} />
          <FileTabBar openTabs={openTabs} activeFile={activeFile} onSelect={selectTab} onClose={closeTab} />
          {activeFile ? (
            <>
              {truncated && <div className="file-truncated-hint" role="status">内容不完整（truncated）</div>}
              <FileTabView source={state.targetSource} path={activeFile} onTruncated={setTruncated} />
            </>
          ) : (
            <div className="file-tab-empty">打开一个文件开始阅读</div>
          )}
        </>
      )}
    </main>
  )

  const scmSection = state.targetSource ? (
    <main className="file-main file-main-split">
      <GitPanel source={state.targetSource} onOpenDiff={(path, staged) => setActiveDiff({ path, staged })} />
      {activeDiff && (
        <DiffView
          source={state.targetSource}
          path={activeDiff.path}
          staged={activeDiff.staged}
          onClose={() => setActiveDiff(null)}
        />
      )}
    </main>
  ) : <main className="file-main"><p className="file-section-hint">未指向会话</p></main>

  return (
    <div className="file-sheet">
      <FileSheetSidebar
        activeSection={state.activeSection}
        targetSource={state.targetSource}
        onSelectSection={selectSection}
        onSelectSource={selectSource}
      />
      {state.activeSection === 'files' ? filesSection : state.activeSection === 'scm' ? scmSection : state.activeSection === 'search' ? (
        <main className="file-main"><WorkspaceSearchPanel source={state.targetSource} onOpenResult={openTab} /></main>
      ) : (
        <main className="file-main">
          <div className="file-main-kicker">FILE SHEET</div>
          <h2 className="file-main-title">{state.targetSource || '未指向会话'}</h2>
          <p className="file-main-hint">当前分区：{state.activeSection}（W2-06 接线）</p>
        </main>
      )}
    </div>
  )
}
