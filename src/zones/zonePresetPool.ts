/**
 * 区域层 · 区域预设池（刀6 / #206）：键 = (界面模式桶, 区域)。
 *
 * 出厂条目**存引用**（`source.presetName`，应用时现场 `pickZoneFields` 切）；
 * 自定义条目**存值快照**（`values`）——铁律「存引用不存值」的**唯一**字面例外，
 * 理由见规则提案 §二-5 / §四-2（自建条目没有来源预设可指）。
 *
 * 规则唯一来源：`预设修正/预设系统V2/06-规则提案-区域预设池派生-待拍板.md` §三。
 * 本模块只消费 `GLOBAL_PRESETS` / `INTERFACE_MODE_PRESET_BUCKET` / `PRESET_ZONES` /
 * `ZONE_FIELDS` / `pickZoneFields`，不复制它们的任何真值。
 */

import type { ThemeSettings } from '../store.ts'
import { ZONE_FIELDS, type ZoneName } from '../themeFieldDefs.ts'
import { PRESET_ZONES, type PresetZone } from '../domains/theme/presetReducer.ts'
import {
  GLOBAL_PRESETS,
  INTERFACE_MODE_PRESET_BUCKET,
  type GlobalPreset,
  type PresetInterfaceMode,
} from '../presets/index.ts'
import { pickZoneFields } from './pickZoneFields.ts'

export interface ZonePresetEntry {
  id: string
  mode: PresetInterfaceMode
  zone: ZoneName
  /** 出厂条目 = 来源预设 label（去重组取排序最前）；自定义条目 = 用户命名。 */
  label: string
  /** 出厂条目：引用来源预设（应用时现场切）。与 `values` 恰好其一。 */
  source?: { presetName: string }
  /** 同形多来源清单：去重折叠时**除 label 来源之外**的那些预设名（仅出厂条目，且 ≥2 来源才有）。 */
  sources?: readonly string[]
  /** 仅自定义条目：该 zone 的字段值快照。 */
  values?: Partial<ThemeSettings>
  /**
   * 派生标记（不落盘）：Q8 清理后该条目**已无有效字段键** ⇒ 行内占位、不可应用。
   */
  stale?: boolean
}

/** 池 = 模式桶 → 区域 → 条目。 */
export type ZonePresetPool = Record<PresetInterfaceMode, Record<PresetZone, ZonePresetEntry[]>>

const PRESET_INTERFACE_MODES = ['gui', 'terminal'] as const satisfies readonly PresetInterfaceMode[]

// ── 稳定序列化（切面指纹） ─────────────────────────────────────────

/** 对象键递归排序的 JSON：同形切面在任意构造顺序下得到同一个指纹。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 切面指纹：字段按 ZONE_FIELDS 顺序、值递归键排序 ⇒ 顺序无关的「同形」判据。 */
function sliceKey(zone: string, slice: Partial<ThemeSettings>): string {
  const fields = ZONE_FIELDS[zone] ?? []
  const record = slice as Record<string, unknown>
  return stableJson(fields.filter(field => field in slice).map(field => [field, record[field]]))
}

// ── 派生（构建时求值） ─────────────────────────────────────────────

/**
 * 规则提案 §三算法：`presetsForInterfaceMode(桶) × PRESET_ZONES × pickZoneFields`
 * → 切面指纹去重（同形折叠：`label` 取排序最前的来源，其余进 `sources`）。
 *
 * 「排序最前」= 该桶在 `GLOBAL_PRESETS` 里的顺序（`filter` 保序）。
 */
export function deriveZonePresetPool(presets: readonly GlobalPreset[]): ZonePresetPool {
  const pool = {} as ZonePresetPool
  for (const mode of PRESET_INTERFACE_MODES) {
    const bucketPresets = presets.filter(preset => preset.interfaceMode === mode)
    const zones = {} as Record<PresetZone, ZonePresetEntry[]>
    for (const zone of PRESET_ZONES) {
      // 同形折叠：指纹 → 该形态的首个条目；后到的同名形态记进它名下的 sources。
      const entryByKey = new Map<string, { entry: ZonePresetEntry; sources: string[] }>()
      const ordered: { entry: ZonePresetEntry; sources: string[] }[] = []
      for (const preset of bucketPresets) {
        const key = sliceKey(zone, pickZoneFields(preset.theme, zone))
        const folded = entryByKey.get(key)
        if (folded) {
          folded.sources.push(preset.name)
          continue
        }
        const draft = {
          entry: {
            id: preset.name,
            mode,
            zone,
            label: preset.label,
            source: { presetName: preset.name },
          } satisfies ZonePresetEntry,
          sources: [] as string[],
        }
        entryByKey.set(key, draft)
        ordered.push(draft)
      }
      zones[zone] = ordered.map(({ entry, sources }) => Object.freeze({
        ...entry,
        ...(sources.length > 0 ? { sources: Object.freeze([...sources]) } : {}),
      }) as ZonePresetEntry)
    }
    pool[mode] = Object.freeze(zones)
  }
  return Object.freeze(pool)
}

/** 构建时求值的出厂池（模块加载一次；内容只随内置预设表变化）。 */
export const ZONE_PRESET_POOL: ZonePresetPool = deriveZonePresetPool(GLOBAL_PRESETS)

// ── 自定义条目（值快照） ───────────────────────────────────────────

/** 该 zone 合法的字段键集（`ZONE_FIELDS` 单一真值；META 字段已在表里排除）。 */
function zoneFieldKeys(zone: string): Set<string> {
  return new Set<string>(ZONE_FIELDS[zone] ?? [])
}

/**
 * Q8：把值快照收敛到该 zone 的字段集——**已删字段键/越区键一律丢弃**。
 * 返回丢弃键清单供调用方判定该条目是否已经「无有效字段」。
 */
export function normalizeZonePresetValues(
  zone: string,
  values: Partial<ThemeSettings>,
): { values: Partial<ThemeSettings>; droppedKeys: string[] } {
  const allowed = zoneFieldKeys(zone)
  const record = values as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  const droppedKeys: string[] = []
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) kept[key] = record[key]
    else droppedKeys.push(key)
  }
  return { values: kept as Partial<ThemeSettings>, droppedKeys }
}

/** 清理后是否已无任何有效字段（⇒ 该条目退化为行内占位）。 */
function isEntryStale(entry: ZonePresetEntry): boolean {
  if (!entry.values) return false
  return Object.keys(entry.values).length === 0
}

/**
 * Q8 自动清理：把每条自定义条目的值快照收敛到该 zone 的字段集。
 * **保留记录本身**（清的是键，不是条目）——条目留作行内占位，避免静默删用户数据；
 * 无变化时返回原引用，便于调用方做「要不要写回」的判据。
 */
export function cleanupZonePresetEntries(entries: readonly ZonePresetEntry[]): ZonePresetEntry[] {
  let changed = false
  const next = entries.map(entry => {
    if (!entry.values) return entry
    const { values, droppedKeys } = normalizeZonePresetValues(entry.zone, entry.values)
    if (droppedKeys.length === 0) return entry
    changed = true
    return { ...entry, values }
  })
  return changed ? next : (entries as ZonePresetEntry[])
}

/** 持久化读入的容错归一（键含模式 + 区域；无 `values` 的条目不是自定义条目 ⇒ 丢弃）。 */
export function normalizeZonePresetEntries(value: unknown): ZonePresetEntry[] {
  if (!Array.isArray(value)) return []
  const entries: ZonePresetEntry[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<ZonePresetEntry>
    if (typeof candidate.id !== 'string' || !candidate.id.trim()) continue
    if (candidate.mode !== 'gui' && candidate.mode !== 'terminal') continue
    if (typeof candidate.zone !== 'string' || !candidate.zone) continue
    if (typeof candidate.label !== 'string' || !candidate.label.trim()) continue
    if (!candidate.values || typeof candidate.values !== 'object') continue
    entries.push({
      id: candidate.id.trim(),
      mode: candidate.mode,
      zone: candidate.zone,
      label: candidate.label.trim().slice(0, 40),
      values: { ...(candidate.values as Partial<ThemeSettings>) },
    })
  }
  return entries
}

const generatedZonePresetEntryIds = new Set<string>()

/** 自定义条目 id：**键含模式 + 区域**（`zone-<mode>-<zone>-<now>`），撞号加后缀。 */
export function createZonePresetEntryId(
  mode: PresetInterfaceMode,
  zone: string,
  now: number,
  existingIds: readonly string[] = [],
): string {
  const baseId = `zone-${mode}-${zone}-${now}`
  const occupied = new Set([...existingIds, ...generatedZonePresetEntryIds])
  if (!occupied.has(baseId)) {
    generatedZonePresetEntryIds.add(baseId)
    return baseId
  }
  let suffix = 1
  while (occupied.has(`${baseId}-${suffix}`)) suffix += 1
  const id = `${baseId}-${suffix}`
  generatedZonePresetEntryIds.add(id)
  return id
}

// ── 查询与消费 ─────────────────────────────────────────────────────

/**
 * 该 (界面模式, 区域) 的候选条目：出厂条目（构建时派生）+ 自定义条目（已过 Q8 清理）。
 * 界面模式**未登记归属桶**（如 `tactical-blue`）⇒ 空数组 ⇒ 调用方整组不渲染。
 */
export function zonePresetsFor(
  interfaceMode: string,
  zone: string,
  customEntries: readonly ZonePresetEntry[] = [],
): ZonePresetEntry[] {
  const bucket = INTERFACE_MODE_PRESET_BUCKET[interfaceMode]
  if (!bucket) return []
  const factory = (ZONE_PRESET_POOL[bucket] as Record<string, ZonePresetEntry[] | undefined>)[zone] ?? []
  const custom = normalizeZonePresetEntries(customEntries)
    .filter(entry => entry.mode === bucket && entry.zone === zone)
    .map(entry => {
      const { values } = normalizeZonePresetValues(entry.zone, entry.values ?? {})
      const cleaned: ZonePresetEntry = { ...entry, values }
      return isEntryStale(cleaned) ? { ...cleaned, stale: true } : cleaned
    })
  if (factory.length === 0 && custom.length === 0) return []
  return [...factory, ...custom]
}

/**
 * 条目 → 应用用的主题切片。
 * - 出厂条目：现场 `pickZoneFields(来源预设.theme, zone)`（与刀5 现状同一切法、同一时刻）
 * - 自定义条目：直接给清理后的值快照
 * - 行内占位条目 / 来源预设已不存在 ⇒ `null`（不可应用）
 */
export function resolveZonePresetEntryTheme(entry: ZonePresetEntry): Partial<ThemeSettings> | null {
  if (entry.stale) return null
  if (entry.values) return entry.values
  const presetName = entry.source?.presetName
  if (!presetName) return null
  const preset = GLOBAL_PRESETS.find(item => item.name === presetName)
  return preset ? pickZoneFields(preset.theme, entry.zone) : null
}
