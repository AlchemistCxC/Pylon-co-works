import { lazy } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createWorkspaceClient } from '../../../infrastructure/tauri/workspaceClient.ts'
import { normalizeWorkspaceText } from '../../../infrastructure/tauri/workspaceContracts.ts'
import { normalizeWorkspaceSearchResults } from '../../../infrastructure/tauri/workspaceSearchContracts.ts'
import { normalizeGitHistory, normalizeGitOperationResult, normalizeGitStatusWithBranch } from '../../../infrastructure/tauri/gitContracts.ts'
import type { FileWorkbenchContribution } from '../../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { WorkspaceEntry } from '../../../components/right-panel/rightPanelTypes.ts'
import { fileTabViewType } from '../../../sheets/file/fileSheetState.ts'

const views = () => import('./builtinFileWorkbenchViews.tsx')
const SessionsActivity = lazy(() => views().then(module => ({ default: module.SessionsActivity })))
const ExplorerActivity = lazy(() => views().then(module => ({ default: module.ExplorerActivity })))
const SearchActivity = lazy(() => views().then(module => ({ default: module.SearchActivity })))
const ScmActivity = lazy(() => views().then(module => ({ default: module.ScmActivity })))
const ViewsActivity = lazy(() => views().then(module => ({ default: module.ViewsActivity })))
const FileViewHost = lazy(() => import('../../../sheets/file/FileViewHost.tsx'))
const client = createWorkspaceClient({ invoke: (command, args) => invoke(command, args as Record<string, unknown> | undefined) })

export const builtinFileProvider = {
  id: 'builtin.file.workspace-provider', canHandle: () => true,
  // createWorkspaceClient 已完成 wire → WorkspaceEntry 归一化；这里不能再次按 wire
  // 形状归一化，否则 name/relativePath 已变成 label/path 后会被全部过滤为空。
  listEntries: async (target: Parameters<typeof client.listEntries>[0], path: string, _signal?: AbortSignal) => await client.listEntries(target, path) as WorkspaceEntry[],
  readText: async (target: Parameters<typeof client.readText>[0], path: string, _signal?: AbortSignal) => normalizeWorkspaceText(await client.readText(target, path)),
  writeText: async (target: Parameters<typeof client.writeText>[0], input: Parameters<typeof client.writeText>[1], _signal?: AbortSignal) => normalizeWorkspaceText(await client.writeText(target, input)),
  search: async (target: Parameters<typeof client.search>[0], query: string, _signal?: AbortSignal) => normalizeWorkspaceSearchResults(await client.search(target, query)),
}
export const builtinGitProvider = {
  id: 'builtin.git.workspace', canHandle: () => true,
  status: async (target: Parameters<typeof client.gitStatusWithBranch>[0], _signal?: AbortSignal) => normalizeGitStatusWithBranch(await client.gitStatusWithBranch(target)),
  history: async (target: Parameters<typeof client.gitHistory>[0], _options?: { limit?: number }, _signal?: AbortSignal) => normalizeGitHistory(await client.gitHistory(target)),
  diff: async (target: Parameters<typeof client.gitDiff>[0], input: { path: string; staged: boolean }, _signal?: AbortSignal) => String(await client.gitDiff(target, input.path, input.staged)),
  stage: async (target: Parameters<typeof client.gitStage>[0], paths: string[], _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitStage(target, paths)),
  unstage: async (target: Parameters<typeof client.gitUnstage>[0], paths: string[], _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitUnstage(target, paths)),
  commit: async (target: Parameters<typeof client.gitCommit>[0], message: string, _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitCommit(target, message)),
  createBranch: async (target: Parameters<typeof client.gitCreateBranch>[0], name: string, _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitCreateBranch(target, name)),
  switchBranch: async (target: Parameters<typeof client.gitSwitchBranch>[0], name: string, _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitSwitchBranch(target, name)),
  pull: async (target: Parameters<typeof client.gitPull>[0], _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitPull(target)),
  push: async (target: Parameters<typeof client.gitPush>[0], _signal?: AbortSignal) => normalizeGitOperationResult(await client.gitPush(target)),
}

export const BUILTIN_FILE_WORKBENCH_CONTRIBUTIONS: readonly FileWorkbenchContribution[] = [
  { kind: 'activity', id: 'builtin.file.sessions', label: '会话', description: '切换工作区会话', order: 10, icon: 'sessions', renderKind: 'first-party-react', component: SessionsActivity },
  { kind: 'activity', id: 'builtin.file.explorer', label: '文件', description: '浏览工作区文件', order: 20, icon: 'files', renderKind: 'first-party-react', component: ExplorerActivity },
  { kind: 'activity', id: 'builtin.file.search', label: '搜索', description: '搜索工作区内容', order: 30, icon: 'search', renderKind: 'first-party-react', component: SearchActivity },
  { kind: 'activity', id: 'builtin.file.scm', label: 'SCM', description: '查看完整 Git 状态和历史', order: 40, icon: 'scm', renderKind: 'first-party-react', component: ScmActivity },
  { kind: 'activity', id: 'builtin.file.views', label: '视图', description: '查看 Agent 最近触碰文件', order: 50, icon: 'views', renderKind: 'first-party-react', component: ViewsActivity },
  { kind: 'file-provider', id: builtinFileProvider.id, priority: 100, fallback: true, provider: builtinFileProvider },
  { kind: 'git-provider', id: builtinGitProvider.id, priority: 100, fallback: true, provider: builtinGitProvider },
  { kind: 'renderer', id: 'builtin.file.text-renderer', priority: 100, fallback: true, canRender: input => fileTabViewType(input.tab) === 'file.text', renderKind: 'first-party-react', component: FileViewHost, onError: () => 'fallback' },
  { kind: 'renderer', id: 'builtin.file.git-diff-renderer', priority: 100, fallback: false, canRender: input => fileTabViewType(input.tab) === 'git.diff', renderKind: 'first-party-react', component: FileViewHost, onError: () => 'fallback' },
]
