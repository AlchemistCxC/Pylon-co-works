import type { ProfilePersistenceState } from '../../profilePersistence.ts'
import { useIdentityStore } from '../../identityStore.ts'
import { useWorkspaceStore } from '../../workspaceStore.ts'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore.ts'
import { markLegacyMigrationComplete } from '../../infrastructure/persistence/legacyKeyMigration.ts'

export type HydrationStage = 'profiles' | 'workspace-sheets' | 'workspace-entities' | 'sessions'
export interface HydrationResult {
  readonly completedStages: readonly HydrationStage[]
}

let pendingLegacy: ProfilePersistenceState | undefined
let inFlight: Promise<HydrationResult> | undefined
let completedStages: HydrationStage[] = []

/** Persist rehydration reports legacy profile payload; bootstrap consumes it exactly once. */
export function reportLegacyProfilePayload(payload: ProfilePersistenceState | undefined): void {
  if (payload && !pendingLegacy) pendingLegacy = payload
}

export function consumeLegacyProfilePayload(): ProfilePersistenceState | undefined {
  const payload = pendingLegacy
  pendingLegacy = undefined
  return payload
}

/** Test/HMR seam: clears completed stage memory after an application teardown. */
export function resetHydrationCoordinator(): void {
  if (inFlight) return
  completedStages = []
  pendingLegacy = undefined
}

/**
 * ISSUE-01 启动身份水合事务。
 *
 * 顺序是产品 contract：profiles → workspace owner hints → sessions。
 * v1 Session owner 推断依赖 workspace.sheetAgentStates，禁止把 sessions 提前。
 * CWD-03：Workspace 实体水合置于 sessions 之前（会话绑定/root 解析依赖注册表）。
 */
export function hydrateIdentityAndWorkspace(legacy?: ProfilePersistenceState): Promise<HydrationResult> {
  if (inFlight) return inFlight
  const run = async (): Promise<HydrationResult> => {
    if (!completedStages.includes('profiles')) {
      await useIdentityStore.getState().hydrateProfiles(legacy ?? consumeLegacyProfilePayload())
      completedStages = [...completedStages, 'profiles']
    }
    if (!completedStages.includes('workspace-sheets')) {
      useWorkspaceStore.getState().hydrateWorkspaceSheets()
      completedStages = [...completedStages, 'workspace-sheets']
    }
    if (!completedStages.includes('workspace-entities')) {
      await useWorkspaceEntityStore.getState().hydrate()
      completedStages = [...completedStages, 'workspace-entities']
    }
    if (!completedStages.includes('sessions')) {
      await useIdentityStore.getState().hydrateSessions()
      completedStages = [...completedStages, 'sessions']
    }
    markLegacyMigrationComplete()
    return Object.freeze({ completedStages: Object.freeze([...completedStages]) })
  }
  inFlight = run().finally(() => { inFlight = undefined })
  return inFlight
}
