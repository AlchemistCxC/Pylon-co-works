import type { AgentContext } from '../../agentContext.ts'
import type { WorkspaceSession } from '../../domains/session/workspaceSession.ts'
import type { WorkspaceEntry, WorkspaceTextPreview } from '../../components/right-panel/rightPanelTypes.ts'
import type { WorkspaceSearchResult } from '../../infrastructure/tauri/workspaceSearchContracts.ts'
import type { GitCommit, GitOperationResult, GitStatusWithBranch } from '../../infrastructure/tauri/gitContracts.ts'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileTabRecord } from '../../sheets/file/fileSheetState.ts'

export interface FileProvider {
  id: string
  canHandle(target: WorkspaceTarget): boolean
  listEntries(target: WorkspaceTarget, relativePath: string, signal?: AbortSignal): Promise<WorkspaceEntry[]>
  readText(target: WorkspaceTarget, relativePath: string, signal?: AbortSignal): Promise<WorkspaceTextPreview | null>
  writeText?(target: WorkspaceTarget, input: { relativePath: string; content: string; expectedBaseline?: string | null; force?: boolean }, signal?: AbortSignal): Promise<WorkspaceTextPreview | null>
  search?(target: WorkspaceTarget, query: string, signal?: AbortSignal): Promise<WorkspaceSearchResult[]>
}

export interface GitProvider {
  id: string
  canHandle(target: WorkspaceTarget): boolean | Promise<boolean>
  status(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitStatusWithBranch>
  history(target: WorkspaceTarget, options?: { limit?: number }, signal?: AbortSignal): Promise<GitCommit[]>
  diff(target: WorkspaceTarget, input: { path: string; staged: boolean }, signal?: AbortSignal): Promise<string>
  stage?(target: WorkspaceTarget, paths: string[], signal?: AbortSignal): Promise<GitOperationResult>
  unstage?(target: WorkspaceTarget, paths: string[], signal?: AbortSignal): Promise<GitOperationResult>
  commit?(target: WorkspaceTarget, message: string, signal?: AbortSignal): Promise<GitOperationResult>
  createBranch?(target: WorkspaceTarget, name: string, signal?: AbortSignal): Promise<GitOperationResult>
  switchBranch?(target: WorkspaceTarget, name: string, signal?: AbortSignal): Promise<GitOperationResult>
  pull?(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitOperationResult>
  push?(target: WorkspaceTarget, signal?: AbortSignal): Promise<GitOperationResult>
}

export interface FileActivityProps {
  target: WorkspaceTarget | null
  targetSessionId: string | null
  sessions: readonly WorkspaceSession[]
  context: AgentContext | null
  activeFile: string | null
  fileProvider: FileProvider | null
  gitProvider: GitProvider | null
  onSelectTarget: (sessionId: string | null) => void
  onOpenFile: (path: string, line?: number) => void
  onOpenDiff: (path: string, staged: boolean) => void
}

interface FileActivityBase {
  kind: 'activity'
  id: string
  label: string
  description: string
  order: number
  icon: 'sessions' | 'files' | 'search' | 'scm' | 'views'
  when?: (target: WorkspaceTarget | null) => boolean
}

export type FileActivityContribution = FileActivityBase & (
  | { renderKind: 'first-party-react'; component: unknown }
  | { renderKind: 'isolated-surface'; surfaceId: string }
)

export interface FileViewRendererProps {
  target: WorkspaceTarget | null
  context: AgentContext | null
  tab: FileTabRecord
  fileProvider: FileProvider | null
  gitProvider: GitProvider | null
  onCloseTab: (key: string) => void
  /** Reports unsaved editor state so the host can guard destructive navigation. */
  onDirtyChange?: (key: string, dirty: boolean) => void
  /** Reports an in-flight write; hosts must not discard/unmount the editor mid-save. */
  onSavingChange?: (key: string, saving: boolean) => void
}

interface FileViewRendererBase {
  kind: 'renderer'
  id: string
  priority: number
  fallback: boolean
  canRender(input: { target: WorkspaceTarget; tab: FileTabRecord }): boolean
  onError?: (error: unknown) => 'fallback' | 'rethrow'
}

export type FileViewRendererDefinition = FileViewRendererBase & (
  | { renderKind: 'first-party-react'; component: unknown }
  | { renderKind: 'isolated-surface'; surfaceId: string }
)

export type FileWorkbenchContribution =
  | FileActivityContribution
  | ({ kind: 'file-provider'; provider: FileProvider; id: string; priority: number; fallback: boolean })
  | ({ kind: 'git-provider'; provider: GitProvider; id: string; priority: number; fallback: boolean })
  | FileViewRendererDefinition
