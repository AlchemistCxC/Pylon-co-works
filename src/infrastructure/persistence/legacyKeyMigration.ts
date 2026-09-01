/** Single read boundary for legacy identity/workspace layout keys. */
export const PERSISTENCE_KEY_OWNERS = Object.freeze({
  'pylon-profiles': { owner: 'identity', authority: 'sqlite', fallback: 'localStorage', version: 1 },
  'pylon-sessions': { owner: 'identity', authority: 'sqlite', fallback: 'localStorage', version: 2 },
  'pylon-workspace-sheets': { owner: 'workspace', authority: 'localStorage', fallback: 'defaults', version: 2 },
  'pylon-workspace-layout-v3': { owner: 'right-rail', authority: 'localStorage', fallback: 'legacy-layout', version: 3 },
  'pylon-right-rail': { owner: 'right-rail', authority: 'legacy', fallback: 'defaults', version: 1 },
  'pylon-theme': { owner: 'theme', authority: 'localStorage', fallback: 'defaults', version: 4 },
} as const)

export interface LegacyLayoutSnapshot {
  rightWidth?: number
  leftWidth?: number
  rightCollapsed?: boolean
  leftCollapsed?: boolean
}

const RIGHT_MIN = 220
const RIGHT_MAX = 560
const LEFT_MIN = 160
const LEFT_MAX = 520
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)))

/** Reads all legacy layout keys once, with deterministic precedence and malformed-data fallback. */
export function readLegacyLayoutSnapshot(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): LegacyLayoutSnapshot {
  if (!storage) return {}
  try {
    const rail = storage.getItem('pylon-right-rail')
    const railState = rail ? (JSON.parse(rail) as { state?: { width?: unknown } }).state : undefined
    const workspace = storage.getItem('pylon-workspace-sheets')
    const workspaceLayout = workspace ? (JSON.parse(workspace) as { layout?: Record<string, unknown> }).layout : undefined
    const theme = storage.getItem('pylon-theme')
    const themeState = theme ? (JSON.parse(theme) as { state?: Record<string, unknown> }).state : undefined
    const rightWidth = finite(railState?.width) ? clamp(railState.width, RIGHT_MIN, RIGHT_MAX) : finite(themeState?.rightWidth) ? clamp(themeState.rightWidth, RIGHT_MIN, RIGHT_MAX) : undefined
    const leftWidth = finite(workspaceLayout?.sidebarWidth) ? clamp(workspaceLayout.sidebarWidth, LEFT_MIN, LEFT_MAX) : finite(themeState?.sidebarWidth) ? clamp(themeState.sidebarWidth, LEFT_MIN, LEFT_MAX) : undefined
    return {
      ...(rightWidth === undefined ? {} : { rightWidth }),
      ...(leftWidth === undefined ? {} : { leftWidth }),
      ...(typeof workspaceLayout?.rightPanelCollapsed === 'boolean' ? { rightCollapsed: workspaceLayout.rightPanelCollapsed } : {}),
      ...(typeof workspaceLayout?.sidebarCollapsed === 'boolean' ? { leftCollapsed: workspaceLayout.sidebarCollapsed } : {}),
    }
  } catch { return {} }
}

export function markLegacyMigrationComplete(storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.setItem('pylon-persistence-migration-v1', '1') } catch { /* best effort */ }
}
