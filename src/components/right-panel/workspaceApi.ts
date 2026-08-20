/**
 * workspaceApi — 兼容 re-export（W2-02）。
 *
 * workspace normalize 真实定义已迁入 `infrastructure/tauri/workspaceContracts.ts`；
 * 本文件仅转发导出，供旧 RightPanel 过渡期使用（W2-12 退役后删除）。
 */

export {
  classifyWorkspaceError,
  mergeWorkspaceEntries,
  normalizeWorkspaceEntries,
  normalizeWorkspaceText,
  workspaceTreeFromEntries,
  type WorkspaceBackendEntry,
  type WorkspaceErrorCode,
  type WorkspaceErrorDetail,
  type WorkspaceTextResponse,
} from '../../infrastructure/tauri/workspaceContracts.ts'
