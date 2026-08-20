import { invoke } from '@tauri-apps/api/core'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { FileProvider, GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import { normalizeWorkspaceEntries, normalizeWorkspaceText } from '../../infrastructure/tauri/workspaceContracts.ts'
import { normalizeWorkspaceSearchResults } from '../../infrastructure/tauri/workspaceSearchContracts.ts'
import { normalizeGitHistory, normalizeGitOperationResult, normalizeGitStatusWithBranch } from '../../infrastructure/tauri/gitContracts.ts'

/** @deprecated Direct-component test adapter. Production FileSheet always supplies registry providers. */
export function legacyTarget(source: string | null | undefined): WorkspaceTarget | null {
  return source ? { sessionId: `legacy:${source}`, agentId: 'legacy', source, legacyWorkdir: source } : null
}
export const legacyFileProvider: FileProvider = {
  id: 'legacy.test.file-provider', canHandle: () => true,
  listEntries: async (target, relativePath) => normalizeWorkspaceEntries(await invoke('list_workspace_entries', { source: target.source, relativePath })),
  readText: async (target, relativePath) => normalizeWorkspaceText(await invoke('read_workspace_text', { source: target.source, relativePath })),
  writeText: async (target, input) => normalizeWorkspaceText(await invoke('write_workspace_text', { source: target.source, ...input, expectedBaseline: input.expectedBaseline ?? null, force: input.force ?? false })),
  search: async (target, query) => normalizeWorkspaceSearchResults(await invoke('workspace_search', { source: target.source, query })),
}
export const legacyGitProvider: GitProvider = {
  id: 'legacy.test.git-provider', canHandle: () => true,
  status: async target => normalizeGitStatusWithBranch(await invoke('git_status_with_branch', { source: target.source })),
  history: async target => normalizeGitHistory(await invoke('git_history', { source: target.source })),
  diff: async (target, input) => String(await invoke('git_diff', { source: target.source, path: input.path, staged: input.staged })),
  stage: async (target, paths) => normalizeGitOperationResult(await invoke('git_stage', { source: target.source, paths })),
  unstage: async (target, paths) => normalizeGitOperationResult(await invoke('git_unstage', { source: target.source, paths })),
  commit: async (target, message) => normalizeGitOperationResult(await invoke('git_commit', { source: target.source, message })),
  createBranch: async (target, name) => normalizeGitOperationResult(await invoke('git_create_branch', { source: target.source, name })),
  switchBranch: async (target, name) => normalizeGitOperationResult(await invoke('git_switch_branch', { source: target.source, name })),
  pull: async target => normalizeGitOperationResult(await invoke('git_pull', { source: target.source })),
  push: async target => normalizeGitOperationResult(await invoke('git_push', { source: target.source })),
}
