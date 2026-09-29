/**
 * layoutRailsStore — 工作台壳层布局/显隐偏好真值源（原 components/right-panel/rightRailStore.ts）。
 *
 * 结构审查 A-V8：该 store 同时持有左栏宽度/折叠与右栏面板态，目录名却叫 right-panel、
 * 文件名却叫 rightRailStore——名从实改为 layoutRailsStore 并落位 domains/workspace
 * （domains/workspace/workspaceStore 原本反向依赖组件目录，一并归正）。
 * 公开钩子名 useRightRailStore 暂保留以控本次扰动面。
 *
 * A-V12：桌面宠物显隐（showPet）从 workspaceStore 的手写 localStorage key
 * （pylon-workspace-show-pet）并入本 store——同属「工作台壳层偏好」，收敛到域内
 * zustand persist 单一机制；持久化键名不变（ADR-0009），envelope version 3→4，
 * migrate 一次性从旧 key 搬家并删除。
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { readLegacyLayoutSnapshot } from '../../infrastructure/persistence/legacyKeyMigration.ts'

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
  showPet: boolean
  setCollapsed: (collapsed: boolean) => void
  setLeftRailWidth: (width: number) => void
  setLeftRailCollapsed: (collapsed: boolean) => void
  setWidth: (width: number) => void
  setActivePanel: (panelId: string | null) => void
  setBackground: (background: RightRailBackgroundPresentation | null) => void
  setShowPet: (show: boolean) => void
}

export function clampRightRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RIGHT_RAIL_DEFAULT_WIDTH
  return Math.min(RIGHT_RAIL_MAX_WIDTH, Math.max(RIGHT_RAIL_MIN_WIDTH, Math.round(width)))
}

/** #154：左栏宽度的唯一 clamp——store setter 与拖拽手柄共用，避免两处各算一套边界。 */
export function clampLeftRailWidth(width: number): number {
  if (!Number.isFinite(width)) return LEFT_RAIL_DEFAULT_WIDTH
  return Math.min(LEFT_RAIL_MAX_WIDTH, Math.max(LEFT_RAIL_MIN_WIDTH, Math.round(width)))
}

/** v4 一次性搬家：旧 showPet 手写 key（'true'/'false' 字面量，缺省 true），搬完即删。 */
function migrateLegacyShowPet(): boolean {
  try {
    const raw = localStorage.getItem('pylon-workspace-show-pet')
    localStorage.removeItem('pylon-workspace-show-pet')
    return raw === 'false' ? false : true
  } catch {
    return true
  }
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
    showPet: true,
    setCollapsed: collapsed => set({ collapsed }),
    setLeftRailWidth: width => set({ leftRailWidth: clampLeftRailWidth(width) }),
    setLeftRailCollapsed: leftRailCollapsed => set({ leftRailCollapsed }),
    setWidth: width => set({ width: clampRightRailWidth(width) }),
    setActivePanel: activePanelId => set({ activePanelId }),
    setBackground: background => set({ background }),
    setShowPet: showPet => set({ showPet }),
  }),
  {
    name: 'pylon-workspace-layout-v3',
    version: 4,
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
        leftRailWidth: clampLeftRailWidth(typeof state?.leftRailWidth === 'number' ? state.leftRailWidth : legacyLayout.leftWidth ?? LEFT_RAIL_DEFAULT_WIDTH),
        leftRailCollapsed: typeof state?.leftRailCollapsed === 'boolean' ? state.leftRailCollapsed : legacyLayout.leftCollapsed ?? false,
        width: clampRightRailWidth(typeof state?.width === 'number' ? state.width : legacyLayout.rightWidth ?? RIGHT_RAIL_DEFAULT_WIDTH),
        activePanelId: typeof state?.activePanelId === 'string' ? state.activePanelId : null,
        background: state?.background && typeof state.background === 'object' ? state.background as RightRailBackgroundPresentation : null,
        showPet: typeof state?.showPet === 'boolean' ? state.showPet : migrateLegacyShowPet(),
      }
    },
    partialize: state => ({
      collapsed: state.collapsed,
      leftRailWidth: state.leftRailWidth,
      leftRailCollapsed: state.leftRailCollapsed,
      width: state.width,
      activePanelId: state.activePanelId,
      background: state.background,
      showPet: state.showPet,
    }),
  },
))
