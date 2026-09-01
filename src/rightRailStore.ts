import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { readLegacyLayoutSnapshot } from './infrastructure/persistence/legacyKeyMigration.ts'

export const RIGHT_RAIL_MIN_WIDTH = 220
export const RIGHT_RAIL_MAX_WIDTH = 560
export const RIGHT_RAIL_DEFAULT_WIDTH = 320
export const LEFT_RAIL_MIN_WIDTH = 160
export const LEFT_RAIL_MAX_WIDTH = 520
export const LEFT_RAIL_DEFAULT_WIDTH = 250
const legacyLayout = readLegacyLayoutSnapshot()

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
    // Preserve the v2 layout default so existing workspaces keep the rail open
    // after the v3 migration.
    collapsed: legacyLayout.rightCollapsed ?? false,
    leftRailWidth: legacyLayout.leftWidth ?? LEFT_RAIL_DEFAULT_WIDTH,
    leftRailCollapsed: legacyLayout.leftCollapsed ?? false,
    width: legacyLayout.rightWidth ?? RIGHT_RAIL_DEFAULT_WIDTH,
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
        collapsed: typeof state?.collapsed === 'boolean' ? state.collapsed : legacyLayout.rightCollapsed ?? false,
        leftRailWidth: typeof state?.leftRailWidth === 'number' ? Math.min(LEFT_RAIL_MAX_WIDTH, Math.max(LEFT_RAIL_MIN_WIDTH, Math.round(state.leftRailWidth))) : legacyLayout.leftWidth ?? LEFT_RAIL_DEFAULT_WIDTH,
        leftRailCollapsed: typeof state?.leftRailCollapsed === 'boolean' ? state.leftRailCollapsed : legacyLayout.leftCollapsed ?? false,
        width: clampRightRailWidth(typeof state?.width === 'number' ? state.width : legacyLayout.rightWidth ?? RIGHT_RAIL_DEFAULT_WIDTH),
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
