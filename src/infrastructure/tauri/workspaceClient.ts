/**
 * workspaceClient — 工作区/文件域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * list_workspace_entries / read_workspace_text / workspace_search /
 * git_status / git_history / git_diff 的 command/payload 收口 + normalize。
 */
import type { ClientTransport } from '../acp/agentClient.ts'
import { normalizeWorkspaceEntries, normalizeWorkspaceText } from './workspaceContracts.ts'
import { normalizeGitStatus, normalizeGitHistory, normalizeGitOperationResult, normalizeGitStatusWithBranch } from './gitContracts.ts'
import { normalizeWorkspaceSearchResults } from './workspaceSearchContracts.ts'
import { normalizeWorkspaceShape, type Workspace } from '../../workspaceEntities.ts'
import type { WorkspaceTargetWire } from '../../domains/workspace/workspaceTarget.ts'

export function createWorkspaceClient(transport: ClientTransport) {
  /** @deprecated string form only keeps direct legacy tests compiling; production passes WorkspaceTarget. */
  const targetArgs = (target: WorkspaceTargetWire | string) => typeof target === 'string' ? { source: target } : { target }
  const normalizeWorkspaceList = (raw: unknown): Workspace[] =>
    Array.isArray(raw) ? raw.map(normalizeWorkspaceShape).filter((w): w is Workspace => w !== null) : []
  return {
    listEntries: (target: WorkspaceTargetWire | string, relativePath: string): Promise<unknown> =>
      transport.invoke('list_workspace_entries', { ...targetArgs(target), relativePath }).then(normalizeWorkspaceEntries),
    readText: (target: WorkspaceTargetWire | string, relativePath: string): Promise<unknown> =>
      transport.invoke('read_workspace_text', { ...targetArgs(target), relativePath }).then(normalizeWorkspaceText),
    writeText: (target: WorkspaceTargetWire, input: { relativePath: string; content: string; expectedBaseline?: string | null; force?: boolean }): Promise<unknown> =>
      transport.invoke('write_workspace_text', { target, ...input }).then(normalizeWorkspaceText),
    search: (target: WorkspaceTargetWire, query: string): Promise<unknown> =>
      transport.invoke('workspace_search', { target, query }).then(normalizeWorkspaceSearchResults),
    gitStatus: (target: WorkspaceTargetWire | string): Promise<unknown> => transport.invoke('git_status', targetArgs(target)).then(normalizeGitStatus),
    gitStatusWithBranch: (target: WorkspaceTargetWire | string): Promise<unknown> =>
      transport.invoke('git_status_with_branch', targetArgs(target)).then(normalizeGitStatusWithBranch),
    gitHistory: (target: WorkspaceTargetWire): Promise<unknown> => transport.invoke('git_history', { target }).then(normalizeGitHistory),
    gitDiff: (target: WorkspaceTargetWire | string, path: string, staged: boolean): Promise<unknown> =>
      transport.invoke('git_diff', { ...targetArgs(target), path, staged }),
    gitStage: (target: WorkspaceTargetWire, paths: string[]): Promise<unknown> =>
      transport.invoke('git_stage', { target, paths }).then(normalizeGitOperationResult),
    gitUnstage: (target: WorkspaceTargetWire, paths: string[]): Promise<unknown> =>
      transport.invoke('git_unstage', { target, paths }).then(normalizeGitOperationResult),
    gitCommit: (target: WorkspaceTargetWire, message: string): Promise<unknown> =>
      transport.invoke('git_commit', { target, message }).then(normalizeGitOperationResult),
    gitCreateBranch: (target: WorkspaceTargetWire, name: string): Promise<unknown> =>
      transport.invoke('git_create_branch', { target, name }).then(normalizeGitOperationResult),
    gitSwitchBranch: (target: WorkspaceTargetWire, name: string): Promise<unknown> =>
      transport.invoke('git_switch_branch', { target, name }).then(normalizeGitOperationResult),
    gitPull: (target: WorkspaceTargetWire): Promise<unknown> =>
      transport.invoke('git_pull', { target }).then(normalizeGitOperationResult),
    gitPush: (target: WorkspaceTargetWire): Promise<unknown> =>
      transport.invoke('git_push', { target }).then(normalizeGitOperationResult),
    // CWD-03：Workspace 实体命令（方案 C）
    getWorkspaceRoot: (target: WorkspaceTargetWire): Promise<unknown> => transport.invoke('get_workspace_root', { target }),
    createWorkspace: (agentId: string, name: string, rootPath: string): Promise<Workspace> =>
      transport.invoke('workspace_create', { agentId, name, rootPath }).then(normalizeWorkspaceShape).then(workspace => {
        if (!workspace) throw new Error('workspace_create 返回无效形状')
        return workspace
      }),
    listWorkspaces: (): Promise<Workspace[]> =>
      transport.invoke('workspace_list', {}).then(normalizeWorkspaceList),
    updateWorkspace: (workspaceId: string, patch: { name?: string; rootPath?: string }): Promise<Workspace> =>
      transport.invoke('workspace_update', { workspaceId, ...patch }).then(normalizeWorkspaceShape).then(workspace => {
        if (!workspace) throw new Error('workspace_update 返回无效形状')
        return workspace
      }),
    deleteWorkspace: (workspaceId: string): Promise<void> =>
      transport.invoke('workspace_delete', { workspaceId }).then(() => undefined),
  }
}

export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>
