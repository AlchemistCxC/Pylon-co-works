export type RightPanelTab = 'workspace' | 'logs' | 'activity' | 'changes'

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
export interface WorkspaceEntry {
  path: string
  label: string
  kind: 'file' | 'folder'
  expandable?: boolean
  entries?: readonly WorkspaceEntry[]
}

export interface WorkspaceTextPreview {
  relativePath: string
  content: string
  bytesRead: number
  totalBytes: number
  truncated: boolean
  encoding: string
}

export interface WorkspaceTree {
  entries: readonly WorkspaceEntry[]
  selectedPath: string | null
}

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
