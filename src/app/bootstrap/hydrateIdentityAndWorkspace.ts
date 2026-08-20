import type { ProfilePersistenceState } from '../../profilePersistence'
import { useIdentityStore } from '../../identityStore'
import { useWorkspaceStore } from '../../workspaceStore'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore'

/**
 * ISSUE-01 启动身份水合事务。
 *
 * 顺序是产品 contract：profiles → workspace owner hints → sessions。
 * v1 Session owner 推断依赖 workspace.sheetAgentStates，禁止把 sessions 提前。
 * CWD-03：Workspace 实体水合置于 sessions 之前（会话绑定/root 解析依赖注册表）。
 */
export async function hydrateIdentityAndWorkspace(legacy?: ProfilePersistenceState): Promise<void> {
  await useIdentityStore.getState().hydrateProfiles(legacy)
  useWorkspaceStore.getState().hydrateWorkspaceSheets()
  await useWorkspaceEntityStore.getState().hydrate()
  await useIdentityStore.getState().hydrateSessions()
}
