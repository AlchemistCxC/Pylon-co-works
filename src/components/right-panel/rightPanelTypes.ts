export type RightPanelTab = 'workspace' | 'logs' | 'activity' | 'changes'

import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import type { RendererSettingOption, SettingsSchema, SettingsValue } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'

// ── #515 Solid 迁移桥面类型（React 薄桥与 Solid 实体共用的中立类型落点；
//    放这里是因为两侧文件互相 import 会把对方的 JSX 拉进自己的 tsconfig 程序）──

/** MessageSearchBar 的 props（原 MessageSearchBar.tsx 内联接口，实体化后中立化）。 */
export interface MessageSearchBarProps {
  query: string
  matchIndex: number
  matchCount: number
  onQueryChange: (query: string) => void
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}

/** AgentContextPanel 的 props（原内联形状，实体化后中立化）。 */
export interface AgentContextPanelProps {
  sheet: SheetRecord
  ctx: SheetContext
}

/** ContextPanelHost 的 props（原内联形状，实体化后中立化）。 */
export interface ContextPanelHostProps {
  sheet: SheetRecord
  ctx: SheetContext
  activePanelId?: string | null
}

/** RightRailHost 的 props（原内联形状，实体化后中立化）。 */
export interface RightRailHostProps {
  sheet: SheetRecord | null
  ctx: SheetContext
  activeAgent?: string
}

/**
 * ContextPanelPluginIsland（React 岛）输入：右栏激活面板的贡献体。
 *
 * 面板外壳（aside/头部/切换器）由 Solid 实体渲染；本岛只承载**内容**——两类贡献的
 * 渲染面都在 React 运行时（first-party 组件 / IsolatedPluginSurface + Renderer 设置
 * schema 面 + PluginContributionBoundary）。依赖变化由 Solid 侧 effect 调 `rerender()`。
 */
export interface ContextPanelPluginIslandInput {
  contributionId: string
  ownerRuntimeInstanceId: string
  renderKind: 'first-party-react' | 'isolated-surface'
  surfaceId?: string
  /** first-party 贡献组件（运行时边界不透明；岛内直接渲染，契约同 React 版）。 */
  component?: unknown
  sheet: SheetRecord
  ctx: SheetContext
  schema?: SettingsSchema
  /** adapter 快照投影（无 adapter 时 values/unavailable 为空对象）。 */
  values: Readonly<Record<string, SettingsValue>>
  unavailable: Readonly<Record<string, { readonly value?: SettingsValue; readonly code: string; readonly message: string }>>
  /** choice/multi-choice/color 字段的 option 投影（Solid 侧算好，岛内原样消费）。 */
  schemaOptions: Readonly<Record<string, readonly RendererSettingOption[]>>
  onSettingChange(key: string, value: SettingsValue): void
  onSettingReset(key: string): void
  onRestoreUnavailable(key: string): void
  /** IsolatedPluginSurface 的宿主事件回派（host:collapse / host:select-session / settings:*）。 */
  onSurfaceEvent(event: string, detail: unknown): void
}

export interface RightPanelTabDefinition {
  id: RightPanelTab
  label: string
}

export interface PanelStatusProps {
  kind: 'loading' | 'empty' | 'error'
  title: string
  detail?: string
  retry?: () => void
}

/** Backend-agnostic data used to render the Workspace tree. */
import type { WorkspaceTextPreview, WorkspaceTree } from '../../contracts/workspaceFiles.ts'

export type { WorkspaceEntry, WorkspaceTextPreview, WorkspaceTree } from '../../contracts/workspaceFiles.ts'

export type WorkspaceViewState =
  | { status: 'no-session' }
  | { status: 'unwired' }
  | { status: 'loading'; tree?: WorkspaceTree }
  | { status: 'empty'; tree: WorkspaceTree }
  | { status: 'ready'; tree: WorkspaceTree; selectedText?: WorkspaceTextPreview }
  | { status: 'error'; message: string; tree?: WorkspaceTree; selectedText?: WorkspaceTextPreview }

export type WorkspaceViewEvent =
  | { type: 'begin-loading' }
  | { type: 'loaded'; tree: WorkspaceTree }
  | { type: 'loaded-text'; text: WorkspaceTextPreview }
  | { type: 'failed'; message: string }
  | { type: 'clear-session' }
  | { type: 'select'; path: string | null }

export function createWorkspaceViewState(sessionId: string | null): WorkspaceViewState {
  return sessionId === null ? { status: 'no-session' } : { status: 'unwired' }
}

export function transitionWorkspaceView(
  state: WorkspaceViewState,
  event: WorkspaceViewEvent,
): WorkspaceViewState {
  if (event.type === 'clear-session') return { status: 'no-session' }
  if (event.type === 'begin-loading') {
    return state.status === 'no-session' ? state : { status: 'loading', tree: 'tree' in state ? state.tree : undefined }
  }
  if (event.type === 'loaded') {
    return event.tree.entries.length === 0 ? { status: 'empty', tree: event.tree } : { status: 'ready', tree: event.tree }
  }
  if (event.type === 'loaded-text' && state.status !== 'no-session' && 'tree' in state && state.tree) {
    return state.status === 'error'
      ? { status: 'error', message: state.message, tree: state.tree, selectedText: event.text }
      : { status: 'ready', tree: state.tree, selectedText: event.text }
  }
  if (event.type === 'failed') {
    return { status: 'error', message: event.message, tree: 'tree' in state ? state.tree : undefined }
  }
  if (event.type === 'select' && 'tree' in state && state.tree) {
    return { ...state, tree: { ...state.tree, selectedPath: event.path } }
  }
  return state
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogsScope {
  sessionId: string
  source: string
}

/** Minimal, backend-agnostic data used to render one log row. */
export interface LogEntry {
  id: string
  time: string
  level: LogLevel
  source: string
  message: string
}

export interface LogsView {
  entries: readonly LogEntry[]
}

export type LogsViewState =
  | { status: 'no-session' }
  | { status: 'unwired'; scope: LogsScope }
  | { status: 'loading'; scope: LogsScope; view?: LogsView }
  | { status: 'empty'; scope: LogsScope; view: LogsView }
  | { status: 'ready'; scope: LogsScope; view: LogsView }
  | { status: 'error'; scope: LogsScope; message: string; view?: LogsView }

export type LogsViewEvent =
  | { type: 'begin-loading' }
  | { type: 'loaded'; entries: readonly LogEntry[] }
  | { type: 'failed'; message: string }
  | { type: 'set-scope'; scope: LogsScope }
  | { type: 'clear-session' }

export function createLogsViewState(scope: LogsScope | null): LogsViewState {
  return scope === null ? { status: 'no-session' } : { status: 'unwired', scope }
}

export function transitionLogsView(
  state: LogsViewState,
  event: LogsViewEvent,
): LogsViewState {
  if (event.type === 'clear-session') return { status: 'no-session' }
  if (event.type === 'set-scope') return { status: 'unwired', scope: event.scope }
  if (state.status === 'no-session') return state

  if (event.type === 'begin-loading') {
    return 'view' in state && state.view
      ? { status: 'loading', scope: state.scope, view: state.view }
      : { status: 'loading', scope: state.scope }
  }
  if (event.type === 'loaded') {
    const view: LogsView = { entries: event.entries }
    return event.entries.length === 0
      ? { status: 'empty', scope: state.scope, view }
      : { status: 'ready', scope: state.scope, view }
  }
  if (event.type === 'failed') {
    return 'view' in state && state.view
      ? { status: 'error', scope: state.scope, message: event.message, view: state.view }
      : { status: 'error', scope: state.scope, message: event.message }
  }
  return state
}
