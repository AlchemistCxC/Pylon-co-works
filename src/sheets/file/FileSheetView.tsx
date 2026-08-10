import { useMemo, useReducer, useState } from 'react'
import { useWorkspaceStore } from '../../workspaceStore'
import { createFileSheetState, fileSheetReducer, fileTabKey, parseFileTabs, serializeFileTabs, type FileSheetSection, type FileTabRecord } from './fileSheetState.ts'
import FileSheetSidebar from './FileSheetSidebar'
import FileTree from './FileTree'
import FileTabBar from './FileTabBar'
import FileViewHost from './FileViewHost'
import GitPanel from './GitPanel'
import WorkspaceSearchPanel from './WorkspaceSearchPanel'
import ViewsPanel from './ViewsPanel'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './FileSheet.css'

/**
 * FileSheetView — FileSheet 主视图（W2-03/04，D-08 VS Code 风格改造；ISSUE-08 D-02/D-04）。
 *
 * singletonKey = file:{初始 source}（同工作区复用）；内部 targetSource 本地态。
 * metadata 承载 openTabs（版本化 tab 记录 `{version:2,tabs:[{path,mode,staged?}],activeKey}`，
 * v1 openTabs:string[] 在 parseFileTabs 内迁移为 file-mode tabs、损坏 normalize 为空）
 * 与 activeFile（右栏 FileContextPanel 反查关联会话）。
 * 布局（D-08）：左栏=活动栏 + 分区内容（文件树/SCM/搜索/视图，随分区切换）；
 * 主区=恒定 tab 条 + FileViewHost 统一渲染（文件视图 / SCM diff / 空态）。
 * SCM 点击变更 → openDiffTab（diff-mode tab，同路径 file/diff 不互相覆盖）。
 */
export default function FileSheetView({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const initialSource = sheet.singletonKey?.replace(/^file:/, '') ?? ctx.sessionSource(ctx.activeSession)
  const [state, dispatch] = useReducer(fileSheetReducer, initialSource ?? null, createFileSheetState)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const patchSheetMetadata = useWorkspaceStore(s => s.patchSheetMetadata)

  // 版本化 tab 从 metadata 恢复（损坏 → 空；v1 → file-mode tabs）
  const tabsState = useMemo(() => parseFileTabs(sheet.metadata?.openTabs), [sheet.metadata?.openTabs])
  const activeTab = useMemo(() => {
    if (tabsState.activeKey) {
      const active = tabsState.tabs.find(tab => fileTabKey(tab) === tabsState.activeKey)
      if (active) return active
    }
    return tabsState.tabs[tabsState.tabs.length - 1] ?? null
  }, [tabsState])

  const persistTabs = (tabs: FileTabRecord[], activeKey: string | null) => {
    const activeFile = tabs.find(tab => fileTabKey(tab) === activeKey)?.path
    const fallback = tabs.length > 0 ? tabs[tabs.length - 1].path : ''
    patchSheetMetadata(sheet.id, {
      openTabs: serializeFileTabs({ version: 2, tabs, activeKey }),
      activeFile: activeFile ?? fallback,
    })
  }

  const openFileTab = (path: string) => {
    const next = tabsState.tabs.some(tab => tab.mode === 'file' && tab.path === path)
      ? tabsState.tabs
      : [...tabsState.tabs, { path, mode: 'file' as const }]
    persistTabs(next, fileTabKey({ path, mode: 'file' }))
  }

  const openDiffTab = (path: string, staged: boolean) => {
    const index = tabsState.tabs.findIndex(tab => tab.mode === 'diff' && tab.path === path)
    const next = index >= 0
      ? tabsState.tabs.map((tab, i) => (i === index ? { ...tab, staged } : tab))
      : [...tabsState.tabs, { path, mode: 'diff' as const, staged }]
    persistTabs(next, fileTabKey({ path, mode: 'diff' }))
  }

  const selectTab = (key: string) => {
    if (!tabsState.tabs.some(tab => fileTabKey(tab) === key)) return
    persistTabs(tabsState.tabs, key)
  }

  const closeTab = (key: string) => {
    const remaining = tabsState.tabs.filter(tab => fileTabKey(tab) !== key)
    const activeKey = tabsState.activeKey === key
      ? (remaining.length > 0 ? fileTabKey(remaining[remaining.length - 1]) : null)
      : tabsState.activeKey
    persistTabs(remaining, activeKey)
  }

  const selectSection = (section: FileSheetSection) => dispatch({ type: 'set-section', section })
  const selectSource = (source: string | null) => dispatch({ type: 'set-source', source })

  return (
    <div className="file-sheet">
      <FileSheetSidebar
        activeSection={state.activeSection}
        targetSource={state.targetSource}
        collapsed={sidebarCollapsed}
        hidden={ctx.sidebarCollapsed}
        onSelectSection={selectSection}
        onSelectSource={selectSource}
        onCollapse={() => setSidebarCollapsed(value => !value)}
      >
        {state.activeSection === 'files' && <FileTree source={state.targetSource} activeFile={activeTab?.path ?? null} onOpen={openFileTab} />}
        {state.activeSection === 'scm' && <GitPanel source={state.targetSource} onOpenDiff={openDiffTab} />}
        {state.activeSection === 'search' && (
          <WorkspaceSearchPanel source={state.targetSource} onOpenResult={openFileTab} />
        )}
        {state.activeSection === 'views' && (
          <ViewsPanel source={state.targetSource} onOpenFile={openFileTab} />
        )}
      </FileSheetSidebar>
      <main className="file-editor">
        <FileTabBar tabs={tabsState.tabs} activeKey={tabsState.activeKey} onSelect={selectTab} onClose={closeTab} />
        <FileViewHost source={state.targetSource} tab={activeTab} onCloseTab={closeTab} />
      </main>
    </div>
  )
}
