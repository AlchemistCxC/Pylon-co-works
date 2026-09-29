import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { DEFAULT_CC_LAYOUT, cloneCcLayout, setCcHiddenState, updateCcPlacementState } from '../cc/ccLayoutState.ts'
import type { CcWidgetPlacement } from '../cc/ccLayoutState.ts'
import { markZoneCustom } from './themePresetState.ts'
import { THEME_SETTING_KEYS, ZONE_FIELDS } from './themeFieldDefs.ts'
import {
  cleanupZonePresetEntries,
  createZonePresetEntryId,
  normalizeZonePresetEntries,
  pickZoneFields,
  removeZonePresetEntryReducer,
  type ZonePresetEntry,
} from './zones/index.ts'
import { clampCcHeight } from '../cc/ccHeightState.ts'
import { THEME_SCHEMA_VERSION, alignThemeStructure, themeDomainMigrate } from './migration.ts'
import { DEFAULTS } from './themeDefaults.ts'
import { useInterfaceModeStore } from '../interface/interfaceModeStore.ts'
import { defaultPresetForInterfaceMode } from './presets/index.ts'
import type { CustomPreset } from './customPresets.ts'
import { reportLegacyProfilePayload } from '../../app/bootstrap/hydrateIdentityAndWorkspace.ts'
import {
  applyZonePresetReducer,
  assembleGlobalPresetReducer,
  removeCustomPresetReducer,
  setGlobalPresetReducer,
  setZoneFieldReducer,
  type AssembleGlobalPresetOptions,
  type GlobalPresetZoneSlice,
} from './presetReducer.ts'
import type { Profile } from '../identity/identityStore.ts'
import { recordSettingWrites, type SettingWriteSource } from './settingProvenance.ts'
import type { PresetApplyResult } from './presetBundle.ts'
import { applyCustomPresetAction, saveCustomPresetAction } from './presetActions.ts'
import type { ThemeSettings } from './themeTypes.ts'

export type { ThemeSettings } from './themeTypes.ts'



/**
 * themeStore — 主题状态域。
 *
 * 持久化键 pylon-theme。身份/运行时/Workspace 状态已迁出到
 * identityStore / runtimeStore / workspaceStore（组合出口见文件尾；其中
 * workspaceStore 亦独立持久化 pylon-workspace-sheets，另有 interface-mode、
 * presentation-preferences 等独立 persist 域——「唯一持久化域」说法已废）。
 */
export type ThemeState = ThemeSettings & {
  customPresets: CustomPreset[]
  /**
   * 刀6（#206）：区域预设池的**自定义条目**（值快照）。出厂条目是构建时派生的派生表
   * （`src/zones/zonePresetPool.ts`），不入库；本切片只存用户自建的那些。
   * 与 `customPresets` 同属 `pylon-theme` 持久化家族（同一个键、同一份白名单）。
   */
  zonePresetEntries: ZonePresetEntry[]
  setCcEditMode: (enabled: boolean) => void
  setCcHeight: (height: number) => void
  updateCcPlacement: (id: string, partial: Partial<CcWidgetPlacement>) => void
  resetCcLayout: () => void
  setCcHidden: (id: string, hidden: boolean) => void
  resetTheme: () => void
  /** 重置单个 zone 的字段到默认值（不清其他 zone），并清该 zone 的 custom/appliedPreset */
  resetZone: (zone: string) => void
  applyZonePreset: (zone: string, presetName: string, presetTheme: Partial<ThemeSettings>) => void
  setZoneField: (zone: string, partial: Partial<ThemeSettings>, source?: SettingWriteSource) => void
  setGlobalPreset: (name: string, theme: Partial<ThemeSettings>) => void
  /**
   * 刀1（#223 · 预设组装）：**逐区域装配**一条全局预设。
   * `slices` = 5 个区域各自的 `{ zone, 引用 id, 取值切片 }`（由 `expandGlobalPresetZoneRefs` 展开）。
   * 与 `setGlobalPreset`（整份 `theme` 一次性写）是两条等价路径：带区域引用表的预设走这条，
   * 两条默认预设（无引用表）回落上面那条。
   */
  assembleGlobalPreset: (slices: readonly GlobalPresetZoneSlice[], options?: AssembleGlobalPresetOptions) => void
  saveCustomPreset: (name: string, id?: string) => string
  applyCustomPreset: (id: string) => Promise<PresetApplyResult>
  removeCustomPreset: (id: string) => void
  /**
   * 刀6（#206）：「存当前为自定义区域预设」——把该 zone 当前值快照
   * （`ZONE_FIELDS[zone]` 字段集）存成池里的一条自定义条目，返回新条目 id；
   * 名称空 ⇒ 返回 null（不抛，按钮本就按此禁用）。
   */
  saveZonePresetEntry: (mode: ZonePresetEntry['mode'], zone: ZonePresetEntry['zone'], label: string) => string | null
  /** 刀6（#206）Q8：读入容错 + 自动清理自定义条目值快照里的已删字段键（无变化则不动状态）。 */
  pruneZonePresetEntries: () => void
  /** 刀7 前置（#211）：删除一条自定义区域预设条目（出厂条目不可删；引用它的区域失去基准）。 */
  removeZonePresetEntry: (id: string) => void
}

// clampPresetCcHeight / syncPresetCcHeight 已随预设动作迁入 domains/theme/presetReducer.ts

// DEFAULTS 定义移入 domains/theme/themeDefaults.ts（可被 node import → 完整性断言测试）

/**
 * 刀7 §六（#214）：哪些写入 source 算「用户触碰」⇒ 置该 zone 的 custom 标记。
 *
 * 呈现方案（界面模式的 token / 用户挑的呈现风格）是**方案自身的基准**，不是用户手改字段。
 * 此前它照旧置 custom，于是全局派生命中「任一 zone custom ⇒ `'custom'`」——点「重置主题」
 * 或切换界面模式之后，预设行会亮出兜底的「自定义」chip，把正当基准误报成用户改动。
 * 其余 source 语义一字不动（缺省 `user-edit` 仍然置 custom）。
 */
function sourceMarksZoneCustom(source: SettingWriteSource): boolean {
  return source !== 'presentation-profile'
}


/** 迁移 / 结构对齐共用的默认值包（base 传 DEFAULTS，避免域→store 循环）。 */
const THEME_MIGRATION_DEFAULTS = {
  base: DEFAULTS,
  appliedPreset: DEFAULTS.appliedPreset,
  custom: DEFAULTS.custom,
  ccLayout: DEFAULTS.ccLayout,
}

export const useStore = create<ThemeState>()(persist(
  (set, get) => ({
  ...DEFAULTS,

  customPresets: [],

  zonePresetEntries: [],

  // D-trace：写入溯源——source 由调用方声明（用户编辑/呈现风格/界面模式…），
  // 缺省 user-edit。记录在漏斗出口完成，reducer 保持纯函数。
  // 刀7 §六（#214）：source 同时决定**这次写入算不算「用户触碰」**（是否置该 zone 的 custom）
  setZoneField: (zone, partial, source = 'user-edit') => {
    recordSettingWrites(source, zone, Object.keys(partial))
    set(state => setZoneFieldReducer(state, zone, partial, sourceMarksZoneCustom(source)))
  },
  setCcEditMode: (enabled) => set({ ccEditMode: enabled }),
  setCcHeight: (height) => set(state => {
    // D1：ccHeight 经布局约束漏斗归一化（★ #266 刀9~11：形态固定 ⇒ 最小高度为常量，参数已收敛）
    const ccHeight = clampCcHeight(height)
    return { ccHeight, ...markZoneCustom(state, 'cc') }
  }),
  updateCcPlacement: (id, partial) => set(state => ({
    ccLayout: updateCcPlacementState(state.ccLayout, id, partial),
    ...markZoneCustom(state, 'cc'),
  })),
  resetCcLayout: () => set(state => ({
    ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
    ...markZoneCustom(state, 'cc'),
  })),
  setCcHidden: (id, hidden) => set(state => {
    const ccHidden = setCcHiddenState(state.ccHidden, id, hidden)
    const ccHeight = clampCcHeight(state.ccHeight)
    return {
      ccHidden,
      ccHeight,
      ...markZoneCustom(state, 'cc'),
    }
  }),

  resetTheme: () => {
    recordSettingWrites('theme-reset', '*', Object.keys(DEFAULTS))
    // 刀7（#214）：重置落点 = **当前界面模式的默认预设**（GUI / 终端各一条，只存值不记基准）。
    // 未登记模式（tactical-blue、插件未登记模式）没有默认预设 ⇒ 回落整份 DEFAULTS（不报错、不悬空）。
    const target = defaultPresetForInterfaceMode(useInterfaceModeStore.getState().interfaceMode)
    if (!target) {
      set(structuredClone(DEFAULTS))
      return
    }
    // 覆盖范围与原来的「整份 DEFAULTS」逐字一致（含非预设域字段 sidebarWidth / rightWidth / showPet），
    // 只把**预设域字段**换成默认预设的值；ccLayout 归一与 ccHeight 收敛沿用「应用预设」同一套算法。
    // 名字传空串 = 沿用 resetZone 的「无基准」态：默认预设不进列表，若记名，预设行会因认不出它
    // 而亮出兜底 chip「未知预设」——那正是刀6/07a 要避免的悬空。
    set({ ...structuredClone(DEFAULTS), ...setGlobalPresetReducer('', target.theme) })
  },

  resetZone: (zone) => set(state => {
    const fields = (ZONE_FIELDS[zone] ?? []) as (keyof ThemeSettings)[]
    // 只重置标量主题字段；ccLayout/ccHidden 等对象字段走专用动作（避免误清用户排布）
    const reset = Object.fromEntries(
      fields
        .filter(field => {
          const value = DEFAULTS[field]
          return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        })
        .map(field => [field, DEFAULTS[field]]),
    )
    recordSettingWrites('zone-reset', zone, Object.keys(reset))
    return {
      ...reset,
      appliedPreset: { ...state.appliedPreset, [zone]: '' },
      custom: { ...state.custom, [zone]: false },
    }
  }),

  // 六个预设动作：纯计算在 domains/theme/presetReducer.ts，此处只留 set(reducer(state, args)) 薄壳
  applyZonePreset: (zone, presetName, presetTheme) => {
    recordSettingWrites('zone-preset', zone, Object.keys(presetTheme))
    set(state => applyZonePresetReducer(state, zone, presetName, presetTheme))
  },
  setGlobalPreset: (name, theme) => {
    recordSettingWrites('global-preset', '*', Object.keys({ ...DEFAULTS, ...theme }))
    set(() => setGlobalPresetReducer(name, theme))
  },
  // 刀1（#223）：逐区域装配薄壳——纯计算在 presetReducer，这里只记溯源 + set(reducer(state, args))
  assembleGlobalPreset: (slices, options = {}) => {
    recordSettingWrites('global-preset', '*', Object.keys({
      ...DEFAULTS,
      ...Object.assign({}, ...slices.map(slice => slice.theme)),
      ...(options.profileTokens ?? {}),
    }))
    set(state => assembleGlobalPresetReducer(state, slices, options))
  },
  // 预设事务动作已下沉 domains/theme/presetActions.ts（结构审查 A-V5）：此处只留 set/get 注入薄壳
  saveCustomPreset: (name, id) => saveCustomPresetAction(name, id, { get, set }),
  applyCustomPreset: id => applyCustomPresetAction(id, { get, set }),

  removeCustomPreset: (id) => set(state => removeCustomPresetReducer(state, id)),

  // 刀6（#206）：区域预设池的自定义条目。捕获口径与「应用」完全对称——
  // 存 = pickZoneFields(当前主题, zone)，应用 = 把这份快照交回 applyZonePreset，
  // 因此「存当前 → 应用」对界面是幂等的（出厂条目走同一动作、同一切法）。
  saveZonePresetEntry: (mode, zone, label) => {
    const cleanLabel = label.trim()
    if (!cleanLabel) return null
    const state = get()
    const existing = normalizeZonePresetEntries(state.zonePresetEntries)
    const id = createZonePresetEntryId(mode, zone, Date.now(), existing.map(entry => entry.id))
    const entry: ZonePresetEntry = {
      id,
      mode,
      zone,
      label: cleanLabel.slice(0, 40),
      values: structuredClone(pickZoneFields(state, zone)),
    }
    set({ zonePresetEntries: [...existing, entry] })
    return id
  },
  pruneZonePresetEntries: () => set(state => {
    const entries = cleanupZonePresetEntries(normalizeZonePresetEntries(state.zonePresetEntries))
    return entries === state.zonePresetEntries ? {} : { zonePresetEntries: entries }
  }),
  // 刀7 前置（#211）：纯计算在 zones/zonePresetPool.ts，此处只留 set(dispatch) 薄壳
  //（形态照 removeCustomPreset）；未命中时 reducer 原样回引用 ⇒ 不写状态。
  removeZonePresetEntry: (id) => set(state => {
    const current = Array.isArray(state.zonePresetEntries) ? state.zonePresetEntries : []
    const patch = removeZonePresetEntryReducer({
      zonePresetEntries: current,
      appliedPreset: state.appliedPreset,
      custom: state.custom,
    }, id)
    return patch.zonePresetEntries === current ? {} : patch
  }),
}),
{ name: 'pylon-theme', version: THEME_SCHEMA_VERSION,
  // G9（1C L1）：主题写盘失败可见（ErrorCenter 指纹去重聚合为一次性告警）
  storage: createJSONStorage(() => ({
    getItem: key => localStorage.getItem(key),
    setItem: (key, value) => {
      try {
        localStorage.setItem(key, value)
        resolveRuntimeErrors({ key: 'app:theme-persistence', source: 'theme.persistence' })
      } catch (error) {
        // 写盘失败可见（ErrorCenter 指纹去重聚合）；不 throw——内存态继续（1C）
        reportRuntimeError('保存主题配置', error, undefined, {
          key: 'app:theme-persistence',
          scope: { kind: 'app', id: 'theme' },
          source: 'theme.persistence',
        })
      }
    },
    removeItem: key => localStorage.removeItem(key),
  })),
  migrate: (persisted, version) => themeDomainMigrate(persisted, THEME_MIGRATION_DEFAULTS, version),
  /**
   * ★★ #238 刀2：读盘后的**结构对齐**每次读盘无条件跑（不依赖版本号）。
   *
   * 挂钩为什么选 `merge` 而不是 `onRehydrateStorage`：zustand 的 hydrate 用**原始 set**
   * 落 `merge` 的返回值（不触发写盘），只有真的跑过 `migrate` 才 `setItem()` ——
   * 所以对齐**不产生任何额外写盘 / 订阅广播**；且 `migrate → merge` 的顺序保证
   * 它跑在一次性语义转换之后。
   *
   * 语义：缺项补默认、多余项忽略、**用户手调的 offsetX/offsetY/order 与已设字段值一律保留**
   * （既定口径：「布局归一化不是把用户排布拍平」）。幂等，见 `alignThemeStructure`。
   */
  merge: (persisted, current) => ({ ...current, ...alignThemeStructure(persisted, THEME_MIGRATION_DEFAULTS) }),
  partialize: (state) => {
    // A4 白名单：THEME_SETTING_KEYS（主题字段，含 ccLayout/ccHidden 对象）+ 显式 meta。
    // 取代"排除式 partialize"——杜绝新增 action/临时字段误持久化，并修剪迁移遗留的旧键。
    const persisted: Record<string, unknown> = {}
    for (const key of THEME_SETTING_KEYS) persisted[key] = state[key]
    persisted.appliedPreset = state.appliedPreset
    persisted.custom = state.custom
    persisted.customPresets = state.customPresets
    persisted.zonePresetEntries = state.zonePresetEntries
    return persisted
  },
  onRehydrateStorage: () => state => {
  // FE-AUD-002：旧 pylon-theme 内嵌 profile 一次性迁移到独立 pylon-profiles key
  // （迁移逻辑在 hydrateProfiles：新 key 存在时旧数据不反向覆盖）
  const legacy = state as unknown as { profiles?: Profile[]; activeProfileId?: string }
  const legacyArg =
    legacy?.profiles && Array.isArray(legacy.profiles) && legacy.profiles.length > 0
      ? { profiles: legacy.profiles, activeProfileId: typeof legacy.activeProfileId === 'string' ? legacy.activeProfileId : legacy.profiles[0].id }
      : undefined
  // P31：persist 只报告 legacy payload；跨域 hydration 唯一由 application bootstrap 触发。
  reportLegacyProfilePayload(legacyArg)
}}))


