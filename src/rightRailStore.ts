import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

export const RIGHT_RAIL_MIN_WIDTH = 220
export const RIGHT_RAIL_MAX_WIDTH = 560
export const RIGHT_RAIL_DEFAULT_WIDTH = 320

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
  collapsed: boolean
  width: number
  activePanelId: string | null
  background: RightRailBackgroundPresentation | null
  setCollapsed: (collapsed: boolean) => void
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
    collapsed: false,
    width: RIGHT_RAIL_DEFAULT_WIDTH,
    activePanelId: null,
    background: null,
    setCollapsed: collapsed => set({ collapsed }),
    setWidth: width => set({ width: clampRightRailWidth(width) }),
    setActivePanel: activePanelId => set({ activePanelId }),
    setBackground: background => set({ background }),
  }),
  {
    name: 'pylon-right-rail',
    version: 1,
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
        collapsed: typeof state?.collapsed === 'boolean' ? state.collapsed : false,
        width: clampRightRailWidth(typeof state?.width === 'number' ? state.width : RIGHT_RAIL_DEFAULT_WIDTH),
        activePanelId: typeof state?.activePanelId === 'string' ? state.activePanelId : null,
        background: state?.background && typeof state.background === 'object' ? state.background as RightRailBackgroundPresentation : null,
      }
    },
    partialize: state => ({
      collapsed: state.collapsed,
      width: state.width,
      activePanelId: state.activePanelId,
      background: state.background,
    }),
  },
))
