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
    listEntries: (source: string, relativePath: string): Promise<unknown> =>
      transport.invoke('list_workspace_entries', { source, relativePath }).then(normalizeWorkspaceEntries),
    readText: (source: string, relativePath: string): Promise<unknown> =>
      transport.invoke('read_workspace_text', { source, relativePath }).then(normalizeWorkspaceText),
    search: (source: string, query: string): Promise<unknown> =>
      transport.invoke('workspace_search', { source, query }).then(normalizeWorkspaceSearchResults),
    gitStatus: (source: string): Promise<unknown> => transport.invoke('git_status', { source }).then(normalizeGitStatus),
    gitHistory: (source: string): Promise<unknown> => transport.invoke('git_history', { source }).then(normalizeGitHistory),
    gitDiff: (source: string, path: string, staged: boolean): Promise<unknown> =>
      transport.invoke('git_diff', { source, path, staged }),
  }
}

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>
