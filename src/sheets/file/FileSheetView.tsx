import { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import { useIdentityStore } from '../../identityStore'
import { useWorkspaceStore } from '../../workspaceStore'
import { createFileSheetState, fileSheetReducer, fileTabKey, fileTabViewType, parseFileTabs, serializeFileTabs, type FileTabRecord } from './fileSheetState.ts'
import FileSheetSidebar from './FileSheetSidebar'
import FileTabBar from './FileTabBar'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import { workspaceTargetFromSession, workspaceTargetKey } from '../../domains/workspace/workspaceTarget.ts'
import { getFileWorkbenchRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { listFileActivities, resolveFileProvider, resolveFileViewRenderer, resolveGitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchResolver.ts'
import type { FileActivityProps, FileViewRendererProps } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import FileViewRenderBoundary from './FileViewRenderBoundary.tsx'
import { registerWorkspaceLiveCloseGuard } from '../../workspace-sheets/workspaceLiveCloseGuards.ts'

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
  const sessions = useIdentityStore(s => s.sessions)
  const metadataHasTarget = Object.prototype.hasOwnProperty.call(sheet.metadata ?? {}, 'targetSessionId')
  const metadataTarget = metadataHasTarget
    ? (sheet.metadata?.targetSessionId || null)
    : undefined
  const stateHasTarget = typeof sheet.state === 'object' && sheet.state !== null && 'targetSessionId' in sheet.state
  const legacyStateTarget = stateHasTarget
    ? (typeof (sheet.state as { targetSessionId?: unknown }).targetSessionId === 'string'
        ? (sheet.state as { targetSessionId: string }).targetSessionId || null
        : null)
    : undefined
  const singletonSessionId = sheet.singletonKey?.match(/^file:session:(.+)$/)?.[1]
  const legacySource = sheet.singletonKey?.match(/^file:(?!session:)(.+)$/)?.[1]
  // metadata is FileSheet's current authority. sheet.state is legacy fallback only; an
  // explicitly persisted empty metadata value means "unbound" and must not revive singleton.
  const persistedSessionId = metadataHasTarget
    ? metadataTarget ?? null
    : stateHasTarget
      ? legacyStateTarget ?? null
      : singletonSessionId
        ?? (legacySource ? ctx.sessionBySource(legacySource)?.id : undefined)
        ?? ctx.activeSession
        ?? null
  const [state, dispatch] = useReducer(fileSheetReducer, persistedSessionId, createFileSheetState)
  useEffect(() => {
    if (state.targetSessionId !== persistedSessionId) {
      dispatch({ type: 'set-target-session', sessionId: persistedSessionId })
    }
  }, [persistedSessionId, state.targetSessionId])
  const targetSession = sessions.find(session => session.id === state.targetSessionId)
  const target = useMemo(() => workspaceTargetFromSession(targetSession), [targetSession])
  useSyncExternalStore(getFileWorkbenchRegistry().subscribe.bind(getFileWorkbenchRegistry()), getFileWorkbenchRegistry().getSnapshot.bind(getFileWorkbenchRegistry()))
  const activities = listFileActivities(target)
  const selectedActivity = activities.find(activity => activity.id === state.activeSection) ?? activities[0] ?? null
  const fileProvider = resolveFileProvider(target)
  const gitProvider = resolveGitProvider(target)
  // I09-A-FE-02（D-01/D-08）：折叠唯一来源 ctx.sidebarCollapsed（titlebar 统一控制），
  // 消除"本地 collapsed + ctx 当 hidden"的双层状态
  const sidebarCollapsed = ctx.sidebarCollapsed
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
  const [dirtyTabKeys, setDirtyTabKeys] = useState<ReadonlySet<string>>(() => new Set())
  const dirtyTabKeysRef = useRef(dirtyTabKeys)
  dirtyTabKeysRef.current = dirtyTabKeys
  const onDirtyChange = useCallback((key: string, dirty: boolean) => {
    setDirtyTabKeys(current => {
      const hasKey = current.has(key)
      if (hasKey === dirty) return current
      const next = new Set(current)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const discardDirty = (key: string) => setDirtyTabKeys(current => {
    if (!current.has(key)) return current
    const next = new Set(current)
    next.delete(key)
    return next
  })
  const canLeaveActiveTab = (nextKey: string | null) => {
    const currentKey = activeTab ? fileTabKey(activeTab) : null
    if (!currentKey || currentKey === nextKey || !dirtyTabKeys.has(currentKey)) return true
    if (!window.confirm('当前文件有未保存修改。放弃修改并继续吗？')) return false
    discardDirty(currentKey)
    return true
  }
  useEffect(() => {
    if (dirtyTabKeys.size === 0) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [dirtyTabKeys.size])
  useEffect(() => registerWorkspaceLiveCloseGuard(sheet.id, () => {
    if (dirtyTabKeysRef.current.size === 0) return true
    return window.confirm('此 File Sheet 有未保存修改。放弃修改并关闭吗？')
  }), [sheet.id])
  const [failedRendererIds, setFailedRendererIds] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => setFailedRendererIds(new Set()), [target?.sessionId, tabsState.activeKey])
  const viewRenderer = resolveFileViewRenderer(target, activeTab, failedRendererIds)
  const ActivityComponent = selectedActivity?.renderKind === 'first-party-react' ? selectedActivity.component as ComponentType<FileActivityProps> : null
  const ViewComponent = viewRenderer?.renderKind === 'first-party-react' ? viewRenderer.component as ComponentType<FileViewRendererProps> : null
  const viewInstanceKey = `${workspaceTargetKey(target) ?? 'unbound'}:${activeTab ? fileTabKey(activeTab) : 'empty'}`

  const readCurrentTabs = () => {
    const currentSheet = useWorkspaceStore.getState().workspaceSheets.sheets.find(item => item.id === sheet.id)
    return parseFileTabs(currentSheet?.metadata?.openTabs)
  }

  const persistTabs = (tabs: FileTabRecord[], activeKey: string | null, targetSessionId = state.targetSessionId) => {
    const activeFile = tabs.find(tab => fileTabKey(tab) === activeKey)?.path
    const fallback = tabs.length > 0 ? tabs[tabs.length - 1].path : ''
    patchSheetMetadata(sheet.id, {
      openTabs: serializeFileTabs({ version: 3, tabs, activeKey }),
      activeFile: activeFile ?? fallback,
      targetSessionId: targetSessionId ?? '',
    })
  }

  const openFileTab = (path: string, line?: number) => {
    const nextKey = fileTabKey({ path, viewType: 'file.text' })
    if (!canLeaveActiveTab(nextKey)) return
    const current = readCurrentTabs()
    const index = current.tabs.findIndex(tab => fileTabViewType(tab) === 'file.text' && tab.path === path)
    const revealLine = Number.isInteger(line) && (line ?? 0) > 0 ? line : undefined
    const next = index >= 0
      ? current.tabs.map((tab, tabIndex) => tabIndex === index && revealLine !== undefined ? { ...tab, line: revealLine } : tab)
      : [...current.tabs, { path, viewType: 'file.text', ...(revealLine === undefined ? {} : { line: revealLine }) }]
    persistTabs(next, nextKey)
  }

  const openDiffTab = (path: string, staged: boolean) => {
    const nextKey = fileTabKey({ path, viewType: 'git.diff' })
    if (!canLeaveActiveTab(nextKey)) return
    const current = readCurrentTabs()
    const index = current.tabs.findIndex(tab => fileTabViewType(tab) === 'git.diff' && tab.path === path)
    const next = index >= 0
      ? current.tabs.map((tab, i) => (i === index ? { ...tab, staged } : tab))
      : [...current.tabs, { path, viewType: 'git.diff', staged }]
    persistTabs(next, nextKey)
  }

  const selectTab = (key: string) => {
    if (!canLeaveActiveTab(key)) return
    const current = readCurrentTabs()
    if (!current.tabs.some(tab => fileTabKey(tab) === key)) return
    persistTabs(current.tabs, key)
  }

  const closeTab = (key: string) => {
    if (dirtyTabKeys.has(key)) {
      if (!window.confirm('当前文件有未保存修改。放弃修改并关闭吗？')) return
      discardDirty(key)
    }
    const current = readCurrentTabs()
    const remaining = current.tabs.filter(tab => fileTabKey(tab) !== key)
    const activeKey = current.activeKey === key
      ? (remaining.length > 0 ? fileTabKey(remaining[remaining.length - 1]) : null)
      : current.activeKey
    persistTabs(remaining, activeKey)
  }

  const selectSection = (section: string) => dispatch({ type: 'set-section', section })
  const selectSource = (sessionId: string | null) => {
    if (sessionId === state.targetSessionId) return
    if (dirtyTabKeys.size > 0 && !window.confirm('当前工作区有未保存修改。放弃修改并切换工作区吗？')) return
    setDirtyTabKeys(new Set())
    dispatch({ type: 'set-target-session', sessionId })
    // A path is meaningful only inside its owning workspace. Rebinding old tabs to a
    // new target can read or write an unrelated same-named file, so target switches
    // atomically clear the old workspace's tab set.
    persistTabs([], null, sessionId)
    // 从“会话”分区选择目标的用户意图是浏览该工作区；选择完成后直接进入 Explorer，
    // 否则 FileTree 不会挂载，也就永远不会发起根目录读取。
    if (sessionId) dispatch({ type: 'set-section', section: 'builtin.file.explorer' })
  }

  // Context is derived only from the selected persisted Session owner; never from active runtime state.
  const sheetContext = useMemo(() => target ? { agentId: target.agentId, source: target.source } : null, [target])

  const isolatedActivityInput = useMemo(() => ({
    target,
    targetSessionId: state.targetSessionId,
    sessions,
    context: sheetContext,
    activeFile: activeTab?.path ?? null,
  }), [target, state.targetSessionId, sessions, sheetContext, activeTab?.path])

  const onActivityEvent = (event: string, detail: unknown) => {
    if (event === 'select-target') selectSource(typeof detail === 'string' ? detail : null)
    else if (event === 'open-file' && typeof detail === 'string') openFileTab(detail)
    else if (event === 'open-file' && detail && typeof detail === 'object' && 'path' in detail) {
      const input = detail as { path: unknown; line?: unknown }
      if (typeof input.path === 'string') openFileTab(input.path, typeof input.line === 'number' ? input.line : undefined)
    }
    else if (event === 'open-diff' && detail && typeof detail === 'object' && 'path' in detail) {
      const input = detail as { path: unknown; staged?: unknown }
      if (typeof input.path === 'string') openDiffTab(input.path, input.staged === true)
    }
  }

  return (
    <div className="file-sheet">
      <FileSheetSidebar
        activeSection={state.activeSection}
        activities={activities}
        collapsed={sidebarCollapsed}
        onSelectSection={selectSection}
      >
        <Suspense fallback={<div className="file-section-panel"><p className="file-section-hint">加载 File Workbench…</p></div>}>
          {ActivityComponent
            ? <ActivityComponent target={target} targetSessionId={state.targetSessionId} sessions={sessions} context={sheetContext} activeFile={activeTab?.path ?? null} fileProvider={fileProvider} gitProvider={gitProvider} onSelectTarget={selectSource} onOpenFile={openFileTab} onOpenDiff={openDiffTab} />
            : selectedActivity?.renderKind === 'isolated-surface'
              ? <IsolatedPluginSurface surfaceId={selectedActivity.surfaceId} className="file-section-panel" input={isolatedActivityInput} onEvent={onActivityEvent} />
              : <div className="file-section-panel"><p className="file-section-hint">没有可用的 File Workbench activity</p></div>}
        </Suspense>
      </FileSheetSidebar>
      <main className="file-editor">
        <FileTabBar tabs={tabsState.tabs} activeKey={tabsState.activeKey} onSelect={selectTab} onClose={closeTab} />
        <Suspense fallback={<div className="file-tab-empty">加载文件视图…</div>}>
          {activeTab && viewRenderer
            ? <FileViewRenderBoundary
                rendererId={viewRenderer.id}
                onError={viewRenderer.onError ?? (() => 'fallback')}
                onFallback={rendererId => setFailedRendererIds(current => new Set([...current, rendererId]))}
              >
                {ViewComponent
                  ? <ViewComponent key={viewInstanceKey} target={target} context={sheetContext} tab={activeTab} fileProvider={fileProvider} gitProvider={gitProvider} onCloseTab={closeTab} onDirtyChange={onDirtyChange} />
                  : viewRenderer.renderKind === 'isolated-surface'
                    ? <IsolatedPluginSurface key={viewInstanceKey} surfaceId={viewRenderer.surfaceId} className="file-view-isolated" input={{ target, context: sheetContext, tab: activeTab }} onEvent={(event, detail) => {
                        if (event === 'close-tab' && typeof detail === 'string') closeTab(detail)
                        else if (event === 'dirty-state' && typeof detail === 'boolean') onDirtyChange(fileTabKey(activeTab), detail)
                      }} />
                    : null}
              </FileViewRenderBoundary>
            : <div className="file-tab-empty"><div className="file-empty-card"><strong>{activeTab ? '没有可用的文件视图 renderer' : '打开一个文件开始阅读'}</strong></div></div>}
        </Suspense>
      </main>
    </div>
  )
}
