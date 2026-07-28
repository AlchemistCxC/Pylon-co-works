import type { ThemeSettings } from './store'

export interface CustomPreset {
  id: string
  name: string
  theme: Partial<ThemeSettings>
  createdAt: number
  updatedAt: number
}

const EXCLUDED_THEME_KEYS = new Set(['activePreset', 'dirty', 'ccEditMode'])

export function pickCustomPresetTheme(state: Record<string, unknown>): Partial<ThemeSettings> {
  return Object.fromEntries(Object.entries(state).filter(([key, value]) =>
    !EXCLUDED_THEME_KEYS.has(key) && typeof value !== 'function',
  )) as Partial<ThemeSettings>
}

export function createCustomPreset(name: string, theme: Partial<ThemeSettings>, now = Date.now()): CustomPreset {
  const cleanName = name.trim()
  if (!cleanName) throw new Error('预设名称不能为空')
  return {
    id: `custom-${now}`,
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
    return [{
      id: candidate.id,
      name: candidate.name.trim().slice(0, 40),
      theme: candidate.theme as Partial<ThemeSettings>,
      createdAt,
      updatedAt,
    }]
  })
}
