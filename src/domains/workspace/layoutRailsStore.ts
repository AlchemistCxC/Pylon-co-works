/**
 * layoutRailsStore — 工作台壳层布局/显隐偏好真值源（原 components/right-panel/rightRailStore.ts）。
 *
 * 结构审查 A-V8：该 store 同时持有左栏宽度/折叠与右栏面板态，目录名却叫 right-panel、
 * 文件名却叫 rightRailStore——名从实改为 layoutRailsStore 并落位 domains/workspace
 * （domains/workspace/workspaceStore 原本反向依赖组件目录，一并归正）。
 * 公开钩子名 useRightRailStore 暂保留以控本次扰动面。
 *
 * 历史：A-V12 曾把桌面宠物显隐（showPet）并入本 store（envelope v3→4）；
 * #483 宠物链整体删除后该字段退役。envelope version 维持 4（v3 migrate 仍服务
 * 布局字段）；旧 `pylon-workspace-show-pet` key 成为无害孤儿，不再主动清理。
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

/** #154：左栏宽度的唯一 clamp——store setter 与拖拽手柄共用，避免两处各算一套边界。 */
export function clampLeftRailWidth(width: number): number {
  if (!Number.isFinite(width)) return LEFT_RAIL_DEFAULT_WIDTH
  return Math.min(LEFT_RAIL_MAX_WIDTH, Math.max(LEFT_RAIL_MIN_WIDTH, Math.round(width)))
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
    setLeftRailWidth: width => set({ leftRailWidth: clampLeftRailWidth(width) }),
    setLeftRailCollapsed: leftRailCollapsed => set({ leftRailCollapsed }),
    setWidth: width => set({ width: clampRightRailWidth(width) }),
    setActivePanel: activePanelId => set({ activePanelId }),
    setBackground: background => set({ background }),
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
      // #483：v4 曾含 showPet（A-V12）；宠物链删除后 migrate 不再产出该字段，
      // 旧 envelope 里的残留值被静默丢弃。
      return {
        collapsed: typeof state?.collapsed === 'boolean' ? state.collapsed : legacyLayout.rightCollapsed ?? false,
        leftRailWidth: clampLeftRailWidth(typeof state?.leftRailWidth === 'number' ? state.leftRailWidth : legacyLayout.leftWidth ?? LEFT_RAIL_DEFAULT_WIDTH),
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
