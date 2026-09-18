/**
 * 设置页 chrome 状态纯模块（施工书 09 §K-1）。
 *
 * 三类 UI 态的 localStorage 持久化 + 密度过滤谓词。
 * 设计约束：chrome 态不进 defs/schema/store——它们是显示方式不是设置项（07 §4.5）。
 * 借鉴 sessionSettingsForm.ts 模式：状态逻辑独立成纯函数，UI 组件保持薄。
 */

export type SettingsDensity = 'basic' | 'standard' | 'all'
const DENSITY_KEY = 'pylon-settings-density'
const DENSITIES: readonly SettingsDensity[] = ['basic', 'standard', 'all']

const COLLAPSE_KEY = 'pylon-settings-collapse'
/** key: `${section}.${groupId}` → 是否折叠 */
export type CollapseMap = Record<string, boolean>

const PINNED_KEY = 'pylon-settings-pinned'
export const PINNED_LIMIT = 3

type Getter = (key: string) => string | null
type Setter = (key: string, value: string) => void

function readJson<T>(get: Getter, key: string, fallback: T): T {
  try {
    const raw = get(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function writeJson(set: Setter, key: string, value: unknown): void {
  try {
    set(key, JSON.stringify(value))
  } catch {
    /* 存储不可写时静默：chrome 态丢失无害 */
  }
}

// ── 密度档 ──

export function readDensity(get: Getter): SettingsDensity {
  const raw = readJson<unknown>(get, DENSITY_KEY, null)
  return typeof raw === 'string' && DENSITIES.includes(raw as SettingsDensity)
    ? (raw as SettingsDensity)
    : 'standard'
}

export function writeDensity(value: SettingsDensity, set: Setter): void {
  writeJson(set, DENSITY_KEY, value)
}

/**
 * 密度过滤谓词（设计书 08 §四）：
 *   basic    → 只显 tier:'basic'（链A；链B 字段无 tier，恒 false）
 *   standard → 非 advanced 全可见（存量行为零变化）
 *   all      → 全可见
 */
export function visibleByDensity(
  density: SettingsDensity,
  field: { tier?: string; advanced?: boolean },
): boolean {
  if (density === 'all') return true
  if (density === 'basic') return field.tier === 'basic'
  return field.advanced !== true
}

// ── 预览栏折叠（#116 子项 8）──
// 预览栏占住的 294px 正是外观域正文只剩 662px 的原因（渲染器字段行溢出的前置条件），
// 故折叠态与密度档同属 chrome 态：进 localStorage，不进 defs/schema/store。
const PREVIEW_KEY = 'pylon-settings-preview-collapsed'

export function readPreviewCollapsed(get: Getter): boolean {
  return readJson<unknown>(get, PREVIEW_KEY, false) === true
}

export function writePreviewCollapsed(value: boolean, set: Setter): void {
  writeJson(set, PREVIEW_KEY, value)
}

// ── 折叠记忆 ──

export function readCollapsed(get: Getter): CollapseMap {
  return readJson<CollapseMap>(get, COLLAPSE_KEY, {})
}

export function writeCollapsed(map: CollapseMap, set: Setter): void {
  writeJson(set, COLLAPSE_KEY, map)
}

// ── 收藏置顶 ──

export function readPinned(get: Getter): readonly string[] {
  const v = readJson<unknown>(get, PINNED_KEY, [])
  return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, PINNED_LIMIT) : []
}

/** 保序去重 + 上限截断 */
export function writePinned(ids: readonly string[], set: Setter): void {
  const uniq: string[] = []
  for (const id of ids) {
    if (!uniq.includes(id)) uniq.push(id)
    if (uniq.length >= PINNED_LIMIT) break
  }
  writeJson(set, PINNED_KEY, uniq)
}
/** F2 边界加固：禁储/隐私模式下 localStorage 访问可能直接抛异常——安全包装。 */
export function safeStorage() {
  try {
    const s = window.localStorage
    const probe = '__pylon_probe__'
    s.setItem(probe, '1')
    s.removeItem(probe)
    return { get: (k: string) => s.getItem(k), set: (k: string, v: string) => s.setItem(k, v) }
  } catch {
    // 内存兜底：会话内仍可用，只是不持久化
    const mem = new Map<string, string>()
    return {
      get: (k: string) => mem.get(k) ?? null,
      set: (k: string, v: string) => { mem.set(k, v) },
    }
  }
}