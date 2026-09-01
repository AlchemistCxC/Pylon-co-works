/** Single read boundary for legacy identity/workspace layout keys. */
export const PERSISTENCE_KEY_OWNERS = Object.freeze({
  'pylon-profiles': { owner: 'identity', authority: 'sqlite', fallback: 'localStorage', version: 1 },
  'pylon-sessions': { owner: 'identity', authority: 'sqlite', fallback: 'localStorage', version: 2 },
  'pylon-workspace-sheets': { owner: 'workspace', authority: 'localStorage', fallback: 'defaults', version: 2 },
  'pylon-workspace-layout-v3': { owner: 'right-rail', authority: 'localStorage', fallback: 'legacy-layout', version: 3 },
  'pylon-right-rail': { owner: 'right-rail', authority: 'legacy', fallback: 'defaults', version: 1 },
  'pylon-theme': { owner: 'theme', authority: 'localStorage', fallback: 'defaults', version: 4 },
} as const)

/** Written after the application bootstrap has committed all legacy migrations. */
export const PERSISTENCE_MIGRATION_MARKER = 'pylon-persistence-migration-v1'

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

function readJson(storage: Pick<Storage, 'getItem'>, key: string): unknown {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    // A malformed key must not hide valid values from the other legacy owners.
    return undefined
  }
}

/** Reads all legacy layout keys once, with deterministic precedence and field-level fallback. */
export function readLegacyLayoutSnapshot(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): LegacyLayoutSnapshot {
  if (!storage) return {}
  // Once the marker is present, the versioned owners are authoritative.  Do
  // not let a stale legacy key re-enter the state during a later HMR/module
  // evaluation or after a partial storage restore.
  try {
    if (storage.getItem(PERSISTENCE_MIGRATION_MARKER) === '1') return {}
  } catch { /* storage may be readable only through individual keys */ }

  const railValue = readJson(storage, 'pylon-right-rail') as { state?: { width?: unknown } } | undefined
  const workspaceValue = readJson(storage, 'pylon-workspace-sheets') as { layout?: Record<string, unknown> } | undefined
  const themeValue = readJson(storage, 'pylon-theme') as { state?: Record<string, unknown> } | undefined
  const railState = railValue?.state
  const workspaceLayout = workspaceValue?.layout
  const themeState = themeValue?.state
  const rightWidth = finite(railState?.width)
    ? clamp(railState.width, RIGHT_MIN, RIGHT_MAX)
    : finite(themeState?.rightWidth)
      ? clamp(themeState.rightWidth, RIGHT_MIN, RIGHT_MAX)
      : undefined
  const leftWidth = finite(workspaceLayout?.sidebarWidth)
    ? clamp(workspaceLayout.sidebarWidth, LEFT_MIN, LEFT_MAX)
    : finite(themeState?.sidebarWidth)
      ? clamp(themeState.sidebarWidth, LEFT_MIN, LEFT_MAX)
      : undefined
  return {
    ...(rightWidth === undefined ? {} : { rightWidth }),
    ...(leftWidth === undefined ? {} : { leftWidth }),
    ...(typeof workspaceLayout?.rightPanelCollapsed === 'boolean' ? { rightCollapsed: workspaceLayout.rightPanelCollapsed } : {}),
    ...(typeof workspaceLayout?.sidebarCollapsed === 'boolean' ? { leftCollapsed: workspaceLayout.sidebarCollapsed } : {}),
  }
}

export function markLegacyMigrationComplete(storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.setItem(PERSISTENCE_MIGRATION_MARKER, '1') } catch { /* best effort */ }
}
