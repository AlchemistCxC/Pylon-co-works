import type { ThemeSettings } from './store'
import { THEME_SETTING_KEYS } from './themeFieldDefs.ts'
import { adaptLegacyThemePreset, normalizePresetBundle, type PresetBundleV2, type PresetJsonValue } from './domains/theme/presetBundle.ts'

export interface CustomPreset {
  id: string
  name: string
  theme: Partial<ThemeSettings>
  createdAt: number
  updatedAt: number
  /** v2 owner contributions; absent on legacy Theme-only presets. */
  bundle?: PresetBundleV2
}

// 白名单由 themeFields.ts 单一真值表生成（各 zone 字段并集）；本文件仅消费。
const THEME_SETTINGS_KEY_SET = new Set<string>(THEME_SETTING_KEYS)

const generatedCustomPresetIds = new Set<string>()

export function createCustomPresetId(now: number, existingIds: readonly string[] = []): string {
  const baseId = `custom-${now}`
  const occupied = new Set([...existingIds, ...generatedCustomPresetIds])
  if (!occupied.has(baseId)) {
    generatedCustomPresetIds.add(baseId)
    return baseId
  }
  let suffix = 1
  while (occupied.has(`${baseId}-${suffix}`)) suffix += 1
  const id = `${baseId}-${suffix}`
  generatedCustomPresetIds.add(id)
  return id
}

export function pickCustomPresetTheme(state: object): Partial<ThemeSettings> {
  return Object.fromEntries(Object.entries(state).filter(([key, value]) =>
    THEME_SETTINGS_KEY_SET.has(key) && typeof value !== 'function',
  )) as Partial<ThemeSettings>
}

export function createCustomPreset(name: string, theme: Partial<ThemeSettings>, now = Date.now()): CustomPreset {
  const cleanName = name.trim()
  if (!cleanName) throw new Error('预设名称不能为空')
  const id = createCustomPresetId(now)
  return {
    id,
    name: cleanName.slice(0, 40),
    theme: structuredClone(theme),
    createdAt: now,
    updatedAt: now,
  }
}

export function upsertCustomPreset(presets: CustomPreset[], preset: CustomPreset): CustomPreset[] {
  const index = presets.findIndex(item => item.id === preset.id)
  if (index < 0) return [...presets, preset]
  return presets.map((item, itemIndex) => itemIndex === index ? preset : item)
}

export function deleteCustomPreset(presets: CustomPreset[], id: string): CustomPreset[] {
  return presets.filter(preset => preset.id !== id)
}

export function normalizeCustomPresets(value: unknown): CustomPreset[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const candidate = item as Partial<CustomPreset>
    if (typeof candidate.id !== 'string' || !candidate.id || typeof candidate.name !== 'string' || !candidate.name.trim() || !candidate.theme || typeof candidate.theme !== 'object') return []
    const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now()
    const updatedAt = typeof candidate.updatedAt === 'number' ? candidate.updatedAt : createdAt
    const normalizedBundle = normalizePresetBundle(candidate.bundle)
      ?? adaptLegacyThemePreset({ id: candidate.id, name: candidate.name, theme: candidate.theme as unknown as PresetJsonValue, createdAt, updatedAt })
    const theme = { ...(candidate.theme as Partial<ThemeSettings>) }
    // Legacy custom presets stored one toolIndicator glyph. Fan it out once so
    // applying an old preset keeps its visual identity across all three tones.
    if (typeof theme.toolIndicator === 'string') {
      for (const key of ['toolIndicatorRun', 'toolIndicatorOk', 'toolIndicatorErr'] as const) {
        if (theme[key] === undefined) theme[key] = theme.toolIndicator
      }
    }
    return [{
      // A1：id 命名空间强制——配置导入/旧数据可带任意 id（如 'claude' 撞内置预设名），
      // 非 custom- 前缀的重新前缀，保证 appliedPreset 值与内置预设名永不冲突。
      id: /^custom-/.test(candidate.id) ? candidate.id : `custom-${candidate.id}`,
      name: candidate.name.trim().slice(0, 40),
      theme,
      createdAt,
      updatedAt,
      bundle: normalizedBundle,
    }]
  })
}
