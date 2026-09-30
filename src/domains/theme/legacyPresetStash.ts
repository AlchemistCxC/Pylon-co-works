/**
 * legacyPresetStash — 旧 pylon-theme 内嵌预设字段的一次性搬家暂存（#448 PR5）。
 *
 * 为什么需要暂存而不是现场读 pylon-theme：themeStore 的 migrate 会把结果**写回**
 * pylon-theme，且 zustand persist 的写回路径经 partialize 白名单——customPresets/
 * zonePresetEntries 无论在 migrate 输出里怎么透传都会被洗掉。若 customPresetStore
 * 的搬家读取发生在写回之后，现场读到的是被修剪的空值，用户预设静默丢失。
 *
 * 双保险时序（读序无关）：
 * - themeStore 的 migrate 钩子在跑一次性语义转换前把 persisted 里的两个预设字段
 *   原样存入本模块；
 * - customPresetStore 的 storage getItem：own 键优先 → 暂存值 → 现场 pylon-theme
 *   （读取若先于 themeStore 写回，现场值还是原值；若后于，暂存里有）。
 */
let stash: { customPresets: unknown; zonePresetEntries: unknown } | null = null

/** themeStore migrate 钩子调用：提取 persisted 的预设字段原值（非数组字段忽略）。 */
export function stashLegacyPresets(persisted: unknown): void {
  if (!persisted || typeof persisted !== 'object') return
  const state = (persisted as { state?: Record<string, unknown> }).state ?? persisted as Record<string, unknown>
  const presets = state.customPresets
  const zones = state.zonePresetEntries
  if (!Array.isArray(presets) && !Array.isArray(zones)) return
  if (stash) return // 首见为准（新键 own 优先已挡反向覆盖，这里防多次 migrate 覆写）
  stash = {
    customPresets: Array.isArray(presets) ? presets : [],
    zonePresetEntries: Array.isArray(zones) ? zones : [],
  }
}

/** customPresetStore 搬家读取：暂存值（themeStore migrate 前的原值）；无则 null。 */
export function stashedLegacyPresets(): { customPresets: unknown; zonePresetEntries: unknown } | null {
  return stash
}
