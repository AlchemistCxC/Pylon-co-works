/**
 * presetReducer — 预设路由的纯计算层（A0 抽出，A1 改模型）。
 *
 * 六个预设 action 的全部状态转换从 store.ts 迁到这里，store 只留
 * set(reducer(state, args)) 薄壳。依赖全部显式 .ts：node --experimental-strip-types
 * 可直接 import 本模块 → 预设语义可做确定性行为测试（save 的 id/now 由 shell 注入）。
 *
 * A1 模型：appliedPreset（基准名，无 'custom' 值）+ custom（触碰标记，事件驱动）+
 * PRESET_ZONES（5 zone，layout 无字段排除）。字段写入只标 custom，不动基准。
 */

/** 参与预设路由的 zone：layout 无字段（实证 zone:'layout'=0）排除 */
export const PRESET_ZONES = ['global', 'sidebar', 'chat', 'cc', 'right'] as const
export type PresetZone = (typeof PRESET_ZONES)[number]
import type { CcLayoutV3 } from '../../ccLayoutState.ts'
import { normalizeCcLayout } from '../../ccLayoutState.ts'
import {
  clampCcHeight,
  clampInputTypography,
  resolveVisibleStatusWidgetCount,
  type CcFooterLayout,
  type CcHintMode,
  type CcInputMode,
  type CcOverflowMode,
} from '../../ccHeightState.ts'
import {
  pickCustomPresetTheme,
  upsertCustomPreset,
  deleteCustomPreset,
  type CustomPreset,
} from '../../customPresets.ts'
import { normalizeThemeState, THEME_DEFAULTS, THEME_PRESET_KEYS, ZONE_FIELDS } from '../../themeFieldDefs.ts'
import { markZoneCustom } from '../../themePresetState.ts'
import type { ThemeSettings } from '../../store.ts'
import type { PresetBundleV2 } from './presetBundle.ts'

const DEFAULTS = THEME_DEFAULTS as Record<string, string | number | boolean>
const PRESET_KEY_SET = new Set<string>(THEME_PRESET_KEYS)

export function filterPresetTheme(value: Record<string, unknown> | Partial<ThemeSettings>): Partial<ThemeSettings> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => PRESET_KEY_SET.has(key))) as Partial<ThemeSettings>
}

/** W2-15（F3-B）：全量主题 → 相对 DEFAULTS 的 delta（过滤与默认相等键；自定义预设存储用） */
export function toThemeDelta(theme: Record<string, unknown> | Partial<ThemeSettings>): Partial<ThemeSettings> {
  const delta: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(theme)) {
    if (key in DEFAULTS && value === DEFAULTS[key]) continue
    delta[key] = value
  }
  return delta as Partial<ThemeSettings>
}

/**
 * 预设路由所需的状态切片。字段类型与 ThemeState 兼容（结构可赋值）：
 * ThemeState → ThemePresetState 无需断言；patch 用 ThemePresetPatch（兼容 Partial<ThemeState>）。
 */
export interface ThemePresetState {
  appliedPreset: Record<string, string>
  custom: Record<string, boolean>
  customPresets: CustomPreset[]
  ccLayout: CcLayoutV3
  ccHeight: number
  inputMode: string
  inputVariant: string
  inputSubmitButtonMode: string
  footerLayout: string
  cliHintMode: string
  ccHidden: string[]
  cliOverflowMode: string
}

/** reducer 返回的 patch：主题字段 + 预设路由/cc 同步字段（可赋值给 Partial<ThemeState>） */
export type ThemePresetPatch = Partial<ThemeSettings> & Partial<Pick<ThemePresetState, 'appliedPreset' | 'custom' | 'customPresets' | 'ccLayout' | 'ccHeight'>>

/** cc 高度 clamp（迁自 store.ts，行为不变）：布局约束真值来自 ccHeightState */
export function clampPresetCcHeight(theme: Partial<ThemeSettings>): number {
  const inputMode = (theme.inputMode ?? String(DEFAULTS.inputMode)) as CcInputMode
  const footerLayout = (theme.footerLayout ?? String(DEFAULTS.footerLayout)) as CcFooterLayout
  const hintMode = (theme.cliHintMode ?? String(DEFAULTS.cliHintMode)) as CcHintMode
  const cliOverflowMode = (theme.cliOverflowMode ?? String(DEFAULTS.cliOverflowMode)) as CcOverflowMode
  const visibleStatusWidgets = resolveVisibleStatusWidgetCount({
    hiddenIds: Array.isArray(theme.ccHidden) ? theme.ccHidden : [],
    inputMode,
    submitButtonMode: String(theme.inputSubmitButtonMode ?? DEFAULTS.inputSubmitButtonMode),
  })
  return clampCcHeight(typeof theme.ccHeight === 'number' ? theme.ccHeight : Number(DEFAULTS.ccHeight), {
    inputMode,
    footerLayout,
    hintMode,
    visibleStatusWidgets,
    cliOverflowMode,
  })
}

export function syncPresetCcHeight(theme: Partial<ThemeSettings>): { ccHeight: number } {
  return { ccHeight: clampPresetCcHeight(theme) }
}

/**
 * inputVariant↔inputMode 联动不变量（MEDIUM 5 收敛）：inputMode==='cli' ⟺ inputVariant==='cli'。
 * 单一真值：setZoneFieldReducer 漏斗 / migration 派生 / UI 层 chips sync 全部满足同一关系。
 */
export function resolveInputMode(inputVariant: string): 'cli' | 'default' {
  return inputVariant === 'cli' ? 'cli' : 'default'
}

export function applyInputVariantInvariant(
  partial: Record<string, unknown>,
  current: { inputMode: string; inputVariant: string },
): Record<string, unknown> {
  const patch = { ...partial }
  if ('inputVariant' in patch) {
    patch.inputMode = resolveInputMode(String(patch.inputVariant))
  } else if ('inputMode' in patch) {
    const inputMode = String(patch.inputMode)
    patch.inputVariant = inputMode === 'cli'
      ? 'cli'
      : (current.inputVariant !== 'cli' ? current.inputVariant : 'composer')
  }
  return patch
}

/**
 * 单字段写入（D1 校验漏斗）：写入字段 +（`markCustom` 为真时）该 zone 标记 custom（基准不动）。
 *
 * `markCustom`（刀7 §六 / #214）：这次写入**算不算「用户触碰」**由调用方声明。呈现方案
 * （界面模式 / 呈现风格的 token）写字段是**模式自身的基准**，不是用户手改；若照旧置 custom，
 * 全局派生命中「任一 zone custom ⇒ custom」，预设行就亮出兜底的「自定义」chip
 *（重置主题、切换界面模式都会踩到）。默认 `true` ⇒ 既有调用点行为零变化。
 * 漏斗内聚三条布局不变量（此前只在 setCcHeight/预设 action/migrate 各自维护）：
 * - inputVariant↔inputMode 联动（cli ⟺ cli，否则 inputMode=default）
 * - ccHeight clamp（≥ resolveCcMinHeight 布局约束真值）
 */
export function setZoneFieldReducer(
  state: ThemePresetState,
  zone: string,
  partial: Record<string, unknown>,
  markCustom = true,
): ThemePresetPatch {
  // 联动：先于 cc 高度 clamp（clamp 需要同步后的 inputMode）
  const patch = applyInputVariantInvariant(partial, state)

  if (zone === 'cc' && ('inputHeight' in patch || 'inputOffsetTop' in patch || 'inputFontSize' in patch || 'inputLineHeight' in patch)) {
    const merged = clampInputTypography({ ...state, ...patch } as ThemePresetState & { inputHeight: number; inputFontSize: number; inputLineHeight: string; inputOffsetTop: number })
    if ('inputFontSize' in patch) patch.inputFontSize = merged.inputFontSize
    if ('inputLineHeight' in patch) patch.inputLineHeight = merged.inputLineHeight
    if ('inputHeight' in patch || 'inputFontSize' in patch || 'inputLineHeight' in patch) patch.inputHeight = merged.inputHeight
    const ccHeight = Number(merged.ccHeight)
    const inputHeight = Number(merged.inputHeight)
    const inputOffsetTop = Number(merged.inputOffsetTop)
    if (Number.isFinite(ccHeight) && Number.isFinite(inputHeight) && Number.isFinite(inputOffsetTop)
      && inputHeight + inputOffsetTop > ccHeight) {
      if ('inputHeight' in patch) patch.inputHeight = Math.max(0, ccHeight - inputOffsetTop)
      else patch.inputOffsetTop = Math.max(0, ccHeight - inputHeight)
    }
  }

  // cc 高度不变量：高度或影响最小高的结构字段被写时整组收敛。
  // 属性面板/设置页恢复控件或切换 CLI 布局后，状态高度必须与 CSS 实际最小高一致。
  if (zone === 'cc' || 'ccHeight' in patch) {
    const merged = { ...state, ...patch } as ThemePresetState
    const clamped = clampCcHeight(Number(merged.ccHeight), {
      inputMode: String(merged.inputMode),
      footerLayout: String(merged.footerLayout),
      hintMode: String(merged.cliHintMode),
      visibleStatusWidgets: resolveVisibleStatusWidgetCount({
        hiddenIds: merged.ccHidden ?? [],
        inputMode: String(merged.inputMode),
        submitButtonMode: String(merged.inputSubmitButtonMode ?? 'inline'),
      }),
      cliOverflowMode: String(merged.cliOverflowMode),
    })
    patch.ccHeight = clamped
  }

  return {
    ...patch,
    ...(markCustom ? markZoneCustom(state, zone) : {}),
  }
}

/** 应用 zone 预设：写字段 + 记基准名 + 清该 zone custom（A2：不再手写 global 标记，全局由 deriveGlobalStatus 派生） */
export function applyZonePresetReducer(
  state: ThemePresetState,
  zone: string,
  presetName: string,
  presetTheme: Partial<ThemeSettings>,
): ThemePresetPatch {
  const theme = filterPresetTheme(presetTheme)
  return {
    ...theme,
    // cc zone 预设即恢复规范排布（预设不携带 ccLayout → 默认布局），与其他 zone 预设一致
    ...(zone === 'cc' ? { ccLayout: normalizeCcLayout(theme.ccLayout) } : {}),
    ...(zone === 'cc' && theme.ccHeight !== undefined ? syncPresetCcHeight(theme) : {}),
    appliedPreset: { ...state.appliedPreset, [zone]: presetName },
    custom: { ...state.custom, [zone]: false },
  }
}

/** 切换全局预设：全 PRESET_ZONES 记名 + 全 custom 清零 + 恢复规范排布 */
export function setGlobalPresetReducer(name: string, theme: Partial<ThemeSettings>): ThemePresetPatch {
  const filteredTheme = filterPresetTheme(theme)
  const presetDefaults = filterPresetTheme(DEFAULTS)
  return {
    ...presetDefaults,
    ...filteredTheme,
    ccLayout: normalizeCcLayout(filteredTheme.ccLayout),
    ...(filteredTheme.ccHeight !== undefined ? syncPresetCcHeight(filteredTheme) : {}),
    appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, name])),
    custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  }
}

// ── 刀1（#223 · 预设组装）：区域引用表 + 逐区域装配 ────────────────
//
// 方向倒置：旧路径「整套预设 → 按区域切一刀 → 5 块」，新路径「5 块区域预设 → 拼成一套预设」。
// 本段与 `setGlobalPresetReducer`（旧的一次性全量路径，保留为参考实现）**必须逐字段等价**——
// 等价性由 `src/__tests__/presetAssembly.test.ts` 对 10 套出厂预设 + 2 套默认预设逐套对拍。

/**
 * 区域引用表：5 个区域各指向一条区域预设 id（现有状态下 = 来源预设名）。
 * `PRESET_ZONES` 是唯一真值——不许另立第二份区域清单。
 */
export type ZoneRefMap = Readonly<Record<PresetZone, string>>

/**
 * 引用表完整性校验：**缺项 / 空值 / 非区域键一律抛错**（缺项不得静默回落）。
 * 覆盖 `PRESET_ZONES` 全部 5 项才算过。
 */
export function requireZoneRefs(value: unknown, context: string): ZoneRefMap {
  if (value === undefined || value === null) throw new Error(`${context}：缺少区域引用表`)
  if (typeof value !== 'object') throw new Error(`${context}：区域引用表不是键值表`)
  const record = value as Record<string, unknown>
  const missing = PRESET_ZONES.filter(zone => typeof record[zone] !== 'string' || !(record[zone] as string).trim())
  if (missing.length > 0) throw new Error(`${context}：区域引用表缺项（${missing.join(' / ')}）`)
  const unknown = Object.keys(record).filter(key => !(PRESET_ZONES as readonly string[]).includes(key))
  if (unknown.length > 0) throw new Error(`${context}：区域引用表含非区域键（${unknown.join(' / ')}）`)
  return Object.fromEntries(PRESET_ZONES.map(zone => [zone, String(record[zone])])) as ZoneRefMap
}

/** 该区域合法的字段键集（判据用 `ZONE_FIELDS` 单一真值，不另写一份区域归属判断）。 */
function zoneFieldKeys(zone: string): Set<string> {
  return new Set<string>(ZONE_FIELDS[zone] ?? [])
}

/**
 * 越区键校验：切片里任何**不属于该区域**的键 → 抛错（**不静默丢弃**）。
 *
 * 静默丢弃的症状是「我这个区域该改的没改」，而用户完全看不出原因（规范 §4.1 硬约束 4）；
 * 出厂的派生条目按构造不可能越区，这道闸门真正拦的是**手写/持久化的区域预设数据**。
 */
export function assertZoneSliceOwnership(zone: string, slice: Partial<ThemeSettings>, context: string): void {
  const allowed = zoneFieldKeys(zone)
  const foreign = Object.keys(slice).filter(key => !allowed.has(key))
  if (foreign.length > 0) {
    throw new Error(`${context}：区域 ${zone} 的取值含越区/未知字段（${foreign.join(' / ')}）`)
  }
}

/** 一条区域引用展开后的装配输入：哪个区域、记什么名字、取哪些值。 */
export interface GlobalPresetZoneSlice {
  zone: PresetZone
  /** 该区域引用的区域预设 id（现有状态下 = 来源预设名）。 */
  presetName: string
  /** 该区域引用的取值切片。 */
  theme: Partial<ThemeSettings>
}

export interface AssembleGlobalPresetOptions {
  /**
   * 统一改写写进 `appliedPreset` 的名字（重置主题路径传 `''`）。省略 = 逐区域记各区域的引用 id。
   *
   * ★「用来取值的引用」与「写进 `appliedPreset` 的名字」是两件事：重置主题取的是**默认预设的值**，
   * 但名字必须是空串——默认预设不进列表，按它的名字记名会让预设行认不出它而亮出兜底 chip「未知预设」。
   */
  appliedName?: string
  /** 呈现方案覆盖层：**装配之后**叠加，优先级不变（token 覆盖预设值）。 */
  profileTokens?: Partial<ThemeSettings>
}

/**
 * 刀1（#223）：逐区域装配一套全局预设，返回可 `set(...)` 的 patch。
 *
 * 与旧的一次性全量路径（`setGlobalPresetReducer`）等价，差别只在「值从哪来」：
 * 旧 = 整份 `preset.theme`；新 = 5 个区域各按引用取自己那一片。三条必须守住的语义：
 *
 * 1. ★ **先铺 `filterPresetTheme(DEFAULTS)`**（全量换装）：逐区域装配只写「区域预设有的字段」，
 *    不铺底的话，预设没覆盖的字段会**残留用户当前值**，而不是回到默认值；
 * 2. ★ **复用 `applyZonePresetReducer`**：cc 区的 `ccLayout` 归一与 `ccHeight` 收敛都在它里面，新写一份合并逻辑必漏；
 * 3. ★ **按 `PRESET_ZONES` 顺序逐区域累积**：把上一步结果并进下一步的输入再算——5 个区域各算一份 patch
 *    最后一起合并，`appliedPreset` 会互相覆盖（后写的 patch 带着它自己那份完整 `appliedPreset`）。
 *
 * 缺区域 / 重复区域 / 越区键一律抛错，不静默回落、不静默丢弃。
 */
export function assembleGlobalPresetReducer(
  state: ThemePresetState,
  slices: readonly GlobalPresetZoneSlice[],
  options: AssembleGlobalPresetOptions = {},
): ThemePresetPatch {
  const byZone = new Map<string, GlobalPresetZoneSlice>()
  for (const slice of slices) {
    if (byZone.has(slice.zone)) throw new Error(`逐区域装配出现重复区域：${slice.zone}`)
    byZone.set(slice.zone, slice)
  }
  const missing = PRESET_ZONES.filter(zone => !byZone.has(zone))
  if (missing.length > 0) throw new Error(`逐区域装配缺区域（${missing.join(' / ')}）`)
  if (byZone.size !== PRESET_ZONES.length) {
    throw new Error(`逐区域装配含非区域项（${[...byZone.keys()].filter(key => !(PRESET_ZONES as readonly string[]).includes(key)).join(' / ')}）`)
  }

  // 1. 铺底：预设没覆盖的字段回到默认值（不是「保留用户当前值」）
  let patch: ThemePresetPatch = { ...filterPresetTheme(DEFAULTS) }

  for (const zone of PRESET_ZONES) {
    const slice = byZone.get(zone)!
    assertZoneSliceOwnership(zone, slice.theme, `区域 ${zone}（引用 ${slice.presetName}）`)
    // 2 + 3：逐步把上一步结果并进输入，复用既有 reducer（cc 特殊处理在其内）
    patch = { ...patch, ...applyZonePresetReducer({ ...state, ...patch } as ThemePresetState, zone, slice.presetName, slice.theme) }
  }

  // 记名与取值解耦；键集恒等于 PRESET_ZONES，不夹带 state 的额外键（与旧路径逐字节同形）
  const appliedName = options.appliedName
  patch.appliedPreset = Object.fromEntries(PRESET_ZONES.map(zone => [zone, appliedName ?? byZone.get(zone)!.presetName]))
  patch.custom = Object.fromEntries(PRESET_ZONES.map(zone => [zone, false]))

  // 呈现方案覆盖层最后叠加（模式自身的基准，不标 custom —— 见 sourceMarksZoneCustom）
  if (options.profileTokens) patch = { ...patch, ...filterPresetTheme(options.profileTokens) }

  return patch
}

export interface SavePresetCommand {
  /** 已存在的预设 id（更新场景由调用方传入） */
  id: string
  name: string
  /** 由 store shell 注入，reducer 保持确定性 */
  now: number
  /** Optional v2 owner contributions captured by the shell. */
  bundle?: PresetBundleV2
}

/** 保存自定义预设：命名强制；捕获当前全主题；upsert；返回 savedId */
export function saveCustomPresetReducer(
  state: ThemePresetState,
  command: SavePresetCommand,
): { patch: ThemePresetPatch; savedId: string } {
  const { id, now } = command
  const cleanName = command.name.trim()
  if (!cleanName) throw new Error('预设名称不能为空')
  const existing = state.customPresets.find(preset => preset.id === id)
  const preset = existing
    ? { ...existing, name: cleanName.slice(0, 40), theme: toThemeDelta(pickCustomPresetTheme(state)), updatedAt: now, ...(command.bundle ? { bundle: command.bundle } : {}) }
    : { id, name: cleanName.slice(0, 40), theme: structuredClone(toThemeDelta(pickCustomPresetTheme(state))), createdAt: now, updatedAt: now, ...(command.bundle ? { bundle: command.bundle } : {}) }
  return { patch: { customPresets: upsertCustomPreset(state.customPresets, preset) }, savedId: preset.id }
}

/**
 * 应用自定义预设：防御性归一化 + 全 PRESET_ZONES 记 id + 全 custom 清零。
 * theme 显式传入时直接消费（bundle 驱动，免疫 id 漂移）；否则按 id 回查
 * customPresets（旧路径）。两者都落空返回 null（调用方必须可见地报告，
 * 不得静默吞掉）。
 */
export function applyCustomPresetReducer(
  state: ThemePresetState,
  id: string,
  explicitTheme?: Record<string, unknown>,
): ThemePresetPatch | null {
  const source = explicitTheme
    ?? state.customPresets.find(item => item.id === id)?.theme
  if (!source) return null
  const theme = filterPresetTheme(normalizeThemeState(pickCustomPresetTheme(source) as Record<string, unknown>) as Record<string, unknown>)
  return {
    ...filterPresetTheme(DEFAULTS),
    ...theme,
    ccLayout: normalizeCcLayout(theme.ccLayout),
    ...(theme.ccHeight !== undefined ? syncPresetCcHeight(theme) : {}),
    appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, id])),
    custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  }
}

/**
 * 全局预设状态派生（A2，覆盖规则 1/2 的单一真值）：
 * - 全空且无触碰 → ''
 * - 任一 zone 触碰（custom=true）→ 'custom'（规则 1：改字段 → 全局变 custom）
 * - 所有非空基准一致且无空 zone → 跟随该基准（空 zone 视为偏离 → custom，规则 2）
 */
export function deriveGlobalStatus(state: Pick<ThemePresetState, 'appliedPreset' | 'custom'>): string {
  const zones = PRESET_ZONES
  if (zones.every(zone => state.appliedPreset[zone] === '' && state.custom[zone] === false)) return ''
  if (zones.some(zone => state.custom[zone])) return 'custom'
  const first = state.appliedPreset[zones[0]]
  if (first !== '' && zones.every(zone => state.appliedPreset[zone] === first)) return first
  return 'custom'
}

/** 单 zone 状态派生：基准名 + 是否自定义 */
export function deriveZoneStatus(
  state: Pick<ThemePresetState, 'appliedPreset' | 'custom'>,
  zone: PresetZone,
): { appliedName: string; isCustom: boolean } {
  return { appliedName: state.appliedPreset[zone] ?? '', isCustom: state.custom[zone] === true }
}

/**
 * 删除自定义预设：引用该 id 的 zone 失去基准（appliedPreset=''）且 custom=true——
 * 字段保留已删预设的值 = 失去基准的自定义快照（不是默认态）。
 */
export function removeCustomPresetReducer(state: ThemePresetState, id: string): ThemePresetPatch {
  const appliedPreset = { ...state.appliedPreset }
  const custom = { ...state.custom }
  for (const [zone, value] of Object.entries(appliedPreset)) {
    if (value === id) {
      appliedPreset[zone] = ''
      custom[zone] = true
    }
  }
  return { customPresets: deleteCustomPreset(state.customPresets, id), appliedPreset, custom }
}
