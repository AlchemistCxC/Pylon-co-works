/**
 * CWD-03（冻结语义）：Workspace rootPath 变更事务。
 *
 * 用户裁决：会话 cwd 创建后不再变更。rootPath 更新只影响「之后新建/绑定」的会话；
 * 既有绑定会话保持各自创建时冻结的 cwd，不 close、不 reload、不改 workdir。
 */
import { useWorkspaceEntityStore } from '../../workspaceEntityStore'
import { reportRuntimeError } from '../../runtimeError.ts'

export type WorkspaceRootChangeResult =
  | { ok: true }
  | { ok: false; reason: 'error'; message: string }

export interface WorkspaceRootStorePort {
  updateWorkspace(workspaceId: string, partial: { rootPath: string }): void | Promise<void>
}

export interface WorkspaceRootTransactionPorts {
  workspace: WorkspaceRootStorePort
  reportError?: (action: string, error: unknown) => void
}

export async function applyWorkspaceRootChange(
  workspaceId: string,
  newRootPath: string,
  ports?: WorkspaceRootTransactionPorts,
): Promise<WorkspaceRootChangeResult> {
  try {
    await (ports?.workspace ?? useWorkspaceEntityStore.getState()).updateWorkspace(workspaceId, { rootPath: newRootPath })
    return { ok: true }
  } catch (error) {
    ;(ports?.reportError ?? reportRuntimeError)('更新 Workspace 根目录', error)
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}
