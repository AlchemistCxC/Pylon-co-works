/**
 * workspaceClient — 工作区/文件域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * list_workspace_entries / read_workspace_text / workspace_search /
 * git_status / git_history / git_diff 的 command/payload 收口 + normalize。
 */
import { ClientTransport } from '../acp/agentClient'
import { normalizeWorkspaceEntries, normalizeWorkspaceText } from './workspaceContracts'
import { normalizeGitStatus, normalizeGitHistory } from './gitContracts'
import { normalizeWorkspaceSearchResults } from './workspaceSearchContracts'

export function createWorkspaceClient(transport: ClientTransport) {
  return {
    listEntries: (relativePath: string): Promise<unknown> =>
      transport.invoke('list_workspace_entries', { relativePath }).then(normalizeWorkspaceEntries),
    readText: (relativePath: string): Promise<unknown> =>
      transport.invoke('read_workspace_text', { relativePath }).then(normalizeWorkspaceText),
    search: (query: string): Promise<unknown> =>
      transport.invoke('workspace_search', { query }).then(normalizeWorkspaceSearchResults),
    gitStatus: (): Promise<unknown> => transport.invoke('git_status').then(normalizeGitStatus),
    gitHistory: (): Promise<unknown> => transport.invoke('git_history').then(normalizeGitHistory),
    gitDiff: (payload: Record<string, unknown>): Promise<unknown> => transport.invoke('git_diff', payload),
  }
}

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>
