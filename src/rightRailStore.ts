import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export const RIGHT_RAIL_MIN_WIDTH = 220
export const RIGHT_RAIL_MAX_WIDTH = 560
export const RIGHT_RAIL_DEFAULT_WIDTH = 320
export const LEFT_RAIL_MIN_WIDTH = 160
export const LEFT_RAIL_MAX_WIDTH = 520
export const LEFT_RAIL_DEFAULT_WIDTH = 250
const LEGACY_RIGHT_RAIL_KEY = 'pylon-right-rail'
const LEGACY_THEME_KEY = 'pylon-theme'
const LEGACY_WORKSPACE_KEY = 'pylon-workspace-sheets'

function readLegacyWidth(): number {
  try {
    const oldRail = localStorage.getItem(LEGACY_RIGHT_RAIL_KEY)
    if (oldRail) {
      const parsed = JSON.parse(oldRail) as { state?: { width?: unknown } }
      if (typeof parsed.state?.width === 'number') return clampRightRailWidth(parsed.state.width)
    }
    const theme = localStorage.getItem(LEGACY_THEME_KEY)
    if (theme) {
      const parsed = JSON.parse(theme) as { state?: { rightWidth?: unknown } }
      if (typeof parsed.state?.rightWidth === 'number') return clampRightRailWidth(parsed.state.rightWidth)
    }
  } catch { /* storage unavailable or malformed legacy data */ }
  return RIGHT_RAIL_DEFAULT_WIDTH
}

function readLegacyCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(LEGACY_WORKSPACE_KEY)
    const parsed = raw ? JSON.parse(raw) as { layout?: { rightPanelCollapsed?: unknown } } : null
    return typeof parsed?.layout?.rightPanelCollapsed === 'boolean' ? parsed.layout.rightPanelCollapsed : false
  } catch { return false }
}

function readLegacyLeftWidth(): number {
  try {
    const raw = localStorage.getItem(LEGACY_WORKSPACE_KEY)
    const parsed = raw ? JSON.parse(raw) as { layout?: { sidebarWidth?: unknown } } : null
    if (typeof parsed?.layout?.sidebarWidth === 'number') return Math.min(LEFT_RAIL_MAX_WIDTH, Math.max(LEFT_RAIL_MIN_WIDTH, Math.round(parsed.layout.sidebarWidth)))
    const theme = localStorage.getItem(LEGACY_THEME_KEY)
    const themeParsed = theme ? JSON.parse(theme) as { state?: { sidebarWidth?: unknown } } : null
    if (typeof themeParsed?.state?.sidebarWidth === 'number') return Math.min(LEFT_RAIL_MAX_WIDTH, Math.max(LEFT_RAIL_MIN_WIDTH, Math.round(themeParsed.state.sidebarWidth)))
  } catch { /* storage unavailable or malformed legacy data */ }
  return LEFT_RAIL_DEFAULT_WIDTH
}

function readLegacyLeftCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(LEGACY_WORKSPACE_KEY)
    const parsed = raw ? JSON.parse(raw) as { layout?: { sidebarCollapsed?: unknown } } : null
    return typeof parsed?.layout?.sidebarCollapsed === 'boolean' ? parsed.layout.sidebarCollapsed : false
  } catch { return false }
}

export type RightRailBackgroundSizing = 'fit' | 'fill' | 'stretch'

export interface RightRailBackgroundPresentation {
  readonly src: string
  readonly sizing: RightRailBackgroundSizing
  /** Width of the rail when the asset was imported. */
  readonly baseWidth: number
  readonly naturalWidth?: number
  readonly naturalHeight?: number
}

interface RightRailState {
  leftRailWidth: number
  leftRailCollapsed: boolean
  collapsed: boolean
  width: number
  activePanelId: string | null
  background: RightRailBackgroundPresentation | null
  setCollapsed: (collapsed: boolean) => void
  setLeftRailWidth: (width: number) => void
  setLeftRailCollapsed: (collapsed: boolean) => void
  setWidth: (width: number) => void
  setActivePanel: (panelId: string | null) => void
  setBackground: (background: RightRailBackgroundPresentation | null) => void
}

export function clampRightRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RIGHT_RAIL_DEFAULT_WIDTH
  return Math.min(RIGHT_RAIL_MAX_WIDTH, Math.max(RIGHT_RAIL_MIN_WIDTH, Math.round(width)))
}

/** Application-level right rail state. It intentionally lives outside Sheet state. */
export const useRightRailStore = create<RightRailState>()(persist(
  (set) => ({
    // Preserve the v2 layout default while the legacy SheetRightSlot adapter
    // is still active. The migration phase may choose to default this to true.
    collapsed: readLegacyCollapsed(),
    leftRailWidth: readLegacyLeftWidth(),
    leftRailCollapsed: readLegacyLeftCollapsed(),
    width: readLegacyWidth(),
    activePanelId: null,
    background: null,
    setCollapsed: collapsed => set({ collapsed }),
    setLeftRailWidth: width => set({ leftRailWidth: Math.min(LEFT_RAIL_MAX_WIDTH, Math.max(LEFT_RAIL_MIN_WIDTH, Math.round(width))) }),
    setLeftRailCollapsed: leftRailCollapsed => set({ leftRailCollapsed }),
    setWidth: width => set({ width: clampRightRailWidth(width) }),
    setActivePanel: activePanelId => set({ activePanelId }),
    setBackground: background => set({ background }),
  }),
  {
    name: 'pylon-workspace-layout-v3',
    version: 3,
    storage: createJSONStorage(() => ({
      getItem: key => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: key => localStorage.removeItem(key),
    })),
    migrate: (persisted: unknown) => {
      const state = (persisted && typeof persisted === 'object' && 'state' in persisted)
        ? (persisted as { state?: Record<string, unknown> }).state
        : undefined
      return {
        collapsed: typeof state?.collapsed === 'boolean' ? state.collapsed : readLegacyCollapsed(),
        leftRailWidth: typeof state?.leftRailWidth === 'number' ? Math.min(LEFT_RAIL_MAX_WIDTH, Math.max(LEFT_RAIL_MIN_WIDTH, Math.round(state.leftRailWidth))) : readLegacyLeftWidth(),
        leftRailCollapsed: typeof state?.leftRailCollapsed === 'boolean' ? state.leftRailCollapsed : readLegacyLeftCollapsed(),
        width: clampRightRailWidth(typeof state?.width === 'number' ? state.width : readLegacyWidth()),
        activePanelId: typeof state?.activePanelId === 'string' ? state.activePanelId : null,
        background: state?.background && typeof state.background === 'object' ? state.background as RightRailBackgroundPresentation : null,
      }
    },
    partialize: state => ({
      collapsed: state.collapsed,
      leftRailWidth: state.leftRailWidth,
      leftRailCollapsed: state.leftRailCollapsed,
      width: state.width,
      activePanelId: state.activePanelId,
      background: state.background,
    }),
  },
))
