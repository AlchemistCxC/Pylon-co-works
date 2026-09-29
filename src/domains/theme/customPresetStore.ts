/**
 * customPresetStore — 用户自建预设独立持久化域（#448 PR5，#321 决议「收敛到后端权威」）。
 *
 * 从 themeStore（pylon-theme 键）拆出 `customPresets` + `zonePresetEntries` 两个用户
 * 资产切片：此前它们随主题设置混存于 zustand persist 直连 localStorage——无 CAS、
 * 无备份，WebView 存储被清即全丢。现在：
 * - localStorage：独立键 `pylon-custom-presets`（v1），storage adapter 内置一次性
 *   搬家——本键无数据时从旧 `pylon-theme` 内嵌字段提取（新键有数据不反向覆盖；
 *   旧键残留由 themeStore 的 partialize 白名单在下一次主题写盘时自然修剪）；
 * - Tauri：`custom-presets` user_data key 为权威（hydrate 对账 + 写穿桥由
 *   infrastructure/persistence/customPresetRepository 接线，启动时安装）。
 *
 * 拆独立 store 而非整包迁移（issue 约束）：避开 themeDomainMigrate/alignThemeStructure
 * 的重绑——预设切片没有版本化 schema 需求（字段集由 CustomPreset/ZonePresetEntry
 * 领域 normalize 兜底）。
 *
 * 跨 store 事务：保存/应用预设要读当前主题、删除预设要回写主题的 appliedPreset/
 * custom 标记——经 `presetCombinedApi`（合成 get + 按字段路由 set）注入
 * presetActions/presetReducer 既有纯函数，事务骨架零改动。
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { CustomPreset } from './customPresets.ts'
import type { ThemeState } from './themeStore.ts'
import { useStore } from './themeStore.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import {
  cleanupZonePresetEntries,
  createZonePresetEntryId,
  normalizeZonePresetEntries,
  pickZoneFields,
  removeZonePresetEntryReducer,
  type ZonePresetEntry,
} from './zones/index.ts'
import { removeCustomPresetReducer } from './presetReducer.ts'
import { applyCustomPresetAction, saveCustomPresetAction } from './presetActions.ts'
import { normalizeCustomPresets } from './customPresets.ts'
import { stashedLegacyPresets } from './legacyPresetStash.ts'
import type { PresetApplyResult } from './presetBundle.ts'

export const CUSTOM_PRESET_STORAGE_KEY = 'pylon-custom-presets'
const LEGACY_THEME_STORAGE_KEY = 'pylon-theme'

export interface CustomPresetState {
  customPresets: CustomPreset[]
  /** 区域预设池的自定义条目（值快照；出厂条目是构建时派生表，不入库）。 */
  zonePresetEntries: ZonePresetEntry[]
  saveCustomPreset: (name: string, id?: string) => string
  applyCustomPreset: (id: string) => Promise<PresetApplyResult>
  removeCustomPreset: (id: string) => void
  /** 「存当前为自定义区域预设」——快照读 themeStore 当前值，条目落本 store。 */
  saveZonePresetEntry: (mode: ZonePresetEntry['mode'], zone: ZonePresetEntry['zone'], label: string) => string | null
  /** 读入容错 + 自动清理值快照里的已删字段键（无变化则不动状态）。 */
  pruneZonePresetEntries: () => void
  removeZonePresetEntry: (id: string) => void
}

/**
 * 一次性搬家：旧 `pylon-theme` 内嵌的预设字段 → 本键。**读序无关的双保险**：
 * - 优先读 legacyPresetStash（themeStore 的 migrate 钩子在写回洗掉字段前暂存的原值）；
 * - 暂存为空再现场读 pylon-theme（读取若先于 themeStore 的 migrate 写回，现场还是原值）。
 * 「本键有数据不反向覆盖」由 own 优先保证；搬家落盘新键后 own 恒在，不再走本路径。
 */
function readLegacyPresetsStorageValue(): string | null {
  try {
    const stashed = stashedLegacyPresets()
    if (stashed) {
      return JSON.stringify({ state: stashed, version: 1 })
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_THEME_STORAGE_KEY) ?? 'null') as
      | { state?: { customPresets?: unknown; zonePresetEntries?: unknown } }
      | null
    const presets = legacy?.state?.customPresets
    const zones = legacy?.state?.zonePresetEntries
    if (!Array.isArray(presets) && !Array.isArray(zones)) return null
    return JSON.stringify({
      state: {
        customPresets: Array.isArray(presets) ? presets : [],
        zonePresetEntries: Array.isArray(zones) ? zones : [],
      },
      version: 1,
    })
  } catch {
    return null
  }
}

export const useCustomPresetStore = create<CustomPresetState>()(persist(
  (set, get) => ({
    customPresets: [],
    zonePresetEntries: [],

    // 预设事务动作：骨架在 presetActions/presetReducer（纯函数），此处注入合成
    // store api（get = 两 store 合并视图；set = customPresets/zonePresetEntries 落
    // 本 store、其余落 themeStore）。
    saveCustomPreset: (name, id) => saveCustomPresetAction(name, id, presetCombinedApi()),
    applyCustomPreset: id => applyCustomPresetAction(id, presetCombinedApi()),

    removeCustomPreset: (id) => {
      // reducer 同时产出主题侧回写（appliedPreset/custom 标记）与预设列表删除
      const patch = removeCustomPresetReducer(presetCombinedApi().get(), id)
      useStore.setState({ appliedPreset: patch.appliedPreset, custom: patch.custom })
      set({ customPresets: patch.customPresets })
    },

    saveZonePresetEntry: (mode, zone, label) => {
      const cleanLabel = label.trim()
      if (!cleanLabel) return null
      const theme = useStore.getState()
      const existing = normalizeZonePresetEntries(get().zonePresetEntries)
      const id = createZonePresetEntryId(mode, zone, Date.now(), existing.map(entry => entry.id))
      const entry: ZonePresetEntry = {
        id,
        mode,
        zone,
        label: cleanLabel.slice(0, 40),
        values: structuredClone(pickZoneFields(theme, zone)),
      }
      set({ zonePresetEntries: [...existing, entry] })
      return id
    },
    pruneZonePresetEntries: () => set(state => {
      const entries = cleanupZonePresetEntries(normalizeZonePresetEntries(state.zonePresetEntries))
      return entries === state.zonePresetEntries ? {} : { zonePresetEntries: entries }
    }),
    removeZonePresetEntry: (id) => {
      const current = Array.isArray(get().zonePresetEntries) ? get().zonePresetEntries : []
      const patch = removeZonePresetEntryReducer({
        zonePresetEntries: current,
        appliedPreset: useStore.getState().appliedPreset,
        custom: useStore.getState().custom,
      }, id)
      if (patch.zonePresetEntries === current) return
      // 出厂条目不可删的闸门在 reducer；命中删除时才回写主题侧标记（可选字段）
      const themePatch: Partial<Pick<ThemeState, 'appliedPreset' | 'custom'>> = {}
      if (patch.appliedPreset !== undefined) themePatch.appliedPreset = patch.appliedPreset
      if (patch.custom !== undefined) themePatch.custom = patch.custom
      if (Object.keys(themePatch).length > 0) useStore.setState(themePatch)
      set({ zonePresetEntries: patch.zonePresetEntries })
    },
  }),
  {
    name: CUSTOM_PRESET_STORAGE_KEY,
    version: 1,
    storage: createJSONStorage(() => ({
      // 本键优先（不反向覆盖）；无数据 → 搬家值（暂存优先，见函数注释）
      getItem: key => {
        try {
          const own = localStorage.getItem(key)
          if (own != null) return own
          return readLegacyPresetsStorageValue()
        } catch { return null }
      },
      setItem: (key, value) => {
        try {
          localStorage.setItem(key, value)
          resolveRuntimeErrors({ key: 'app:custom-preset-persistence', source: 'customPreset.persistence' })
        } catch (error) {
          // 写盘失败可见（ErrorCenter 聚合）；不 throw——内存态继续（与 themeStore 同语义）
          reportRuntimeError('保存自定义预设', error, undefined, {
            key: 'app:custom-preset-persistence',
            scope: { kind: 'app', id: 'custom-presets' },
            source: 'customPreset.persistence',
          })
        }
      },
      removeItem: key => localStorage.removeItem(key),
    })),
    // 预设切片无版本化 schema：持久化形状即领域类型 + 领域归一（customPresets 的
    // id namespace 迁移 / zonePresetEntries 的值快照清洗——自 themeDomainMigrate
    // 移交，#448 PR5）。旧 pylon-theme 侧仅保留 appliedPreset 引用一致性改写。
    merge: (persisted, current) => ({
      ...current,
      ...(persisted && typeof persisted === 'object'
        ? {
            customPresets: Array.isArray((persisted as { customPresets?: unknown }).customPresets)
              ? normalizeCustomPresets((persisted as { customPresets: unknown[] }).customPresets)
              : current.customPresets,
            zonePresetEntries: normalizeZonePresetEntries((persisted as { zonePresetEntries?: unknown }).zonePresetEntries ?? current.zonePresetEntries),
          }
        : {}),
    }),
    partialize: state => ({
      customPresets: state.customPresets,
      zonePresetEntries: state.zonePresetEntries,
    }),
  },
))

/** 合成 store api：get = 两 store 合并视图；set 按字段路由（预设切片 ⇄ 主题字段）。 */
function presetCombinedApi() {
  return {
    get: (): ThemeState & CustomPresetState => ({ ...useStore.getState(), ...useCustomPresetStore.getState() }),
    set: (partial: Partial<ThemeState & CustomPresetState> | ((state: ThemeState & CustomPresetState) => Partial<ThemeState & CustomPresetState>)): void => {
      const patch = typeof partial === 'function' ? partial(presetCombinedApi().get()) : partial
      const { customPresets, zonePresetEntries, ...themePatch } = patch as Partial<ThemeState & CustomPresetState>
      if (customPresets !== undefined || zonePresetEntries !== undefined) {
        useCustomPresetStore.setState({
          ...(customPresets !== undefined ? { customPresets } : {}),
          ...(zonePresetEntries !== undefined ? { zonePresetEntries } : {}),
        })
      }
      if (Object.keys(themePatch).length > 0) useStore.setState(themePatch)
    },
  }
}
