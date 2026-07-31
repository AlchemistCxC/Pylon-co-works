import type { ThemeSettings } from './store'

export interface CustomPreset {
  id: string
  name: string
  theme: Partial<ThemeSettings>
  createdAt: number
  updatedAt: number
}

const THEME_SETTINGS_KEYS: readonly (keyof ThemeSettings)[] = [
  'transparency', 'bgBlur', 'globalFont', 'globalFontSize', 'globalBgImage', 'globalBgColor', 'uiScheme',
  'sidebarBg', 'sidebarBgImage', 'sidebarWidth', 'sidebarTextColor', 'sidebarNameSize', 'sidebarGroupSize',
  'chatBg', 'chatBgImage', 'chatFont', 'chatFontSize', 'chatLineHeight', 'chatTextColor', 'chatCodeColor', 'chatCodeBg',
  'toolOk', 'toolRun', 'toolErr', 'toolNameColor', 'toolSummaryColor', 'userTagBg', 'userTagText',
  'toolIndicatorGlow', 'toolIndicatorGlowColor', 'toolConnectorMode', 'toolConnectorColor',
  'inputBg', 'inputBgImage', 'inputTextColor', 'inputPlaceholder', 'inputSendBg', 'inputFocusBorder', 'inputFontSize', 'inputMinHeight',
  'inputMode', 'cliLineWidth', 'cliLineColor', 'cliTextColor', 'cliPromptColor', 'cliLinePadding', 'cliContentOffsetY', 'cliHintMode',
  'statusBg', 'statusBgImage', 'ekgWidth', 'ekgFontSize', 'ekgGreen', 'ekgYellow', 'ekgRed', 'pillBg', 'pillText', 'prismOnColor',
  'ekgLineWidth', 'ekgAmplitudeMax', 'ekgSpeedBase', 'ekgSpeedMax',
  'barTrackColor', 'barFillColor', 'barFillFollow', 'barHeight',
  'ekgLeftColor', 'ekgMovingColor', 'ekgConsumedColor', 'tokenDisplay',
  'rightBg', 'rightBgImage', 'rightWidth',
  'sidebarTransparency', 'sidebarBlur', 'chatTransparency', 'chatBlur', 'rightTransparency', 'rightBlur',
  'userName', 'userPrefix', 'userColor', 'toolIndicator', 'sparkles',
  'spinnerFramePreset', 'spinnerCustomFrames', 'spinnerVerbSet', 'spinnerCustomVerbs',
  'spinnerDoneMarker', 'spinnerCancelledMarker', 'spinnerErrorMarker',
  'spinnerDoneMarkerMode', 'spinnerCancelledMarkerMode', 'spinnerErrorMarkerMode',
  'spinnerIntervalMs', 'spinnerColor', 'spinnerSize',
  'msgStyle', 'msgFont', 'msgTextColor', 'msgLineHeight', 'messageLayout',
  'ccHeight', 'ccBgHeight', 'ccBg', 'ccBgImage', 'ccStatusFontSize', 'ccStyle', 'ccVariant',
  'modelVariant', 'modeVariant', 'sendVariant', 'attachVariant', 'ccHidden', 'ccLayout',
  'ccScale', 'footerLayout', 'cliOverflowMode',
]

const THEME_SETTINGS_KEY_SET = new Set<string>(THEME_SETTINGS_KEYS)

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

export function pickCustomPresetTheme(state: Record<string, unknown>): Partial<ThemeSettings> {
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
    return [{
      id: candidate.id,
      name: candidate.name.trim().slice(0, 40),
      theme: candidate.theme as Partial<ThemeSettings>,
      createdAt,
      updatedAt,
    }]
  })
}
