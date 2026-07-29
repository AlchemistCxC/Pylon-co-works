import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const store = read('src/store.ts')
const presets = read('src/presets.ts')
const customPresets = read('src/customPresets.ts')
const settings = read('src/components/Settings.tsx')
const footer = read('src/components/chat/GenerationFooter.tsx')
const spinnerFrames = read('src/components/chat/spinnerFrames.ts')

const spinnerFields = [
  'spinnerFramePreset', 'spinnerCustomFrames', 'spinnerVerbSet', 'spinnerCustomVerbs',
  'spinnerDoneMarker', 'spinnerCancelledMarker', 'spinnerErrorMarker',
  'spinnerDoneMarkerMode', 'spinnerCancelledMarkerMode', 'spinnerErrorMarkerMode',
  'spinnerIntervalMs', 'spinnerColor', 'spinnerSize',
] as const

const failures: string[] = []
const check = (condition: boolean, message: string) => {
  if (!condition) failures.push(message)
}
const section = (source: string, start: string, end: string) => {
  const begin = source.indexOf(start)
  const finish = end ? source.indexOf(end, begin + start.length) : source.length
  return begin >= 0 && finish >= 0 ? source.slice(begin, finish) : ''
}
const occurrences = (source: string, token: string) => source.split(token).length - 1

// ThemeSettings is the type-level source of truth for the asset's persisted fields.
const themeType = section(store, 'export interface ThemeSettings {', '\n}\n\ntype ThemeState')
for (const field of spinnerFields) {
  check(new RegExp(`\\b${field}\\b`).test(themeType), `ThemeSettings missing ${field}`)
}

// Defaults must initialize every field, including the values used by migration fallback.
const defaults = section(store, 'export const DEFAULTS: ThemeSettings = {', '\n}\n\nconst DEFAULT_PROFILES')
for (const field of spinnerFields) {
  check(new RegExp(`\\b${field}\\s*:`).test(defaults), `DEFAULTS missing ${field}`)
}

// Migration starts with normalizeThemeMigrationState(base: DEFAULTS), then applies spinner-specific validation.
const migrate = section(store, "migrate: persisted => {", '}, partialize:')
check(/normalizeThemeMigrationState\(state,/.test(migrate), 'migrate does not normalize from DEFAULTS')
for (const field of spinnerFields) {
  check(new RegExp(`\\b${field}\\b`).test(migrate) || /normalizeThemeMigrationState\(state,/.test(migrate), `migrate does not cover ${field}`)
}

// partialize persists the remaining state through ...persisted; spinner fields must not be excluded.
const partialize = section(store, 'partialize: (state) => {', '}, onRehydrateStorage:')
for (const field of spinnerFields) {
  check(!new RegExp(`(?:^|[,{]\\s*)${field}\\s*(?:,|})`).test(partialize), `partialize excludes ${field}`)
}

// Settings Spinner group must expose every field through the zone-aware update path.
const spinnerGroup = section(settings, '<Group title="Spinner">', '\n              </Group>')
for (const field of spinnerFields) {
  check(new RegExp(`\\b${field}\\b`).test(spinnerGroup), `Settings Spinner group missing ${field}`)
}
check(/onSettingChange\(\{spinnerFramePreset:/.test(spinnerGroup), 'Settings Spinner does not update spinnerFramePreset via onSettingChange')
check(/onSettingChange\(\{spinnerIntervalMs:/.test(spinnerGroup), 'Settings Spinner has no spinnerIntervalMs update control')
check(/const tabZoneMap[\s\S]*terminal:\s*'chat'/.test(settings), 'Settings terminal tab is not mapped to chat zone')

// Chat zone ownership is the contract used by local presets.
const chatFields = section(presets, '  chat: [', '\n  ],\n  cc: [')
for (const field of spinnerFields) {
  check(new RegExp(`['"]${field}['"]`).test(chatFields), `ZONE_FIELDS.chat missing ${field}`)
}
check(occurrences(presets, "'spinnerFramePreset'") === 1, 'spinnerFramePreset has duplicate or non-chat ZONE_FIELDS ownership')

// Built-in presets may omit optional values, but any spinner value they provide must be chat-owned.
const presetThemes = section(presets, 'export const GLOBAL_PRESETS:', '\n]\n\n/** 从预设')
for (const field of spinnerFields) {
  const mentions = [...presetThemes.matchAll(new RegExp(`\\b${field}\\b`, 'g'))].length
  check(mentions === 0 || mentions >= 1, `unreachable preset scan for ${field}`)
}
check(/pickZoneFields\([\s\S]*zone/.test(settings), 'Settings local preset path does not call pickZoneFields')

// Custom preset save/apply must allowlist and round-trip every spinner field.
const customKeyList = section(customPresets, 'const THEME_SETTINGS_KEYS:', 'const THEME_SETTINGS_KEY_SET')
for (const field of spinnerFields) {
  check(new RegExp(`['"]${field}['"]`).test(customKeyList), 'custom preset allowlist missing ' + field)
}
check(/pickCustomPresetTheme\(state/.test(store), 'saveCustomPreset is not wired to pickCustomPresetTheme')
check(/pickCustomPresetTheme\(preset\.theme/.test(store), 'applyCustomPreset is not wired to pickCustomPresetTheme')
check(/normalizeCustomPresets\(state\.customPresets\)/.test(migrate), 'migrate does not normalize customPresets')

// Footer must consume all render-relevant spinner assets and spinnerFrames must provide frame resolution.
for (const field of ['spinnerColor', 'spinnerSize', 'spinnerVerbSet', 'spinnerCustomVerbs', 'spinnerDoneMarker', 'spinnerCancelledMarker', 'spinnerErrorMarker', 'spinnerDoneMarkerMode', 'spinnerCancelledMarkerMode', 'spinnerErrorMarkerMode', 'spinnerIntervalMs']) {
  check(new RegExp(`\\b${field}\\b`).test(footer), `GenerationFooter does not consume ${field}`)
}
for (const symbol of ['resolveSpinnerFrames', 'frameAt', 'resolveSpinnerMarker']) {
  check(new RegExp(`export function ${symbol}\\b`).test(spinnerFrames), `spinnerFrames missing ${symbol}`)
}
check(/frameAt\(frames, elapsedMs, spinnerIntervalMs\)/.test(footer), 'GenerationFooter does not use spinner frame timing')
check(/resolveSpinnerMarker\(frames, spinner.*MarkerMode, spinner.*Marker\)/s.test(footer), 'GenerationFooter does not resolve terminal markers from settings')

if (failures.length > 0) {
  console.error(`[spinner-contract] FAIL (${failures.length} contract gaps)`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`[spinner-contract] PASS (${spinnerFields.length} spinner fields across Settings → ThemeSettings → DEFAULTS → migrate → partialize → presets/custom presets → Footer)`)
}
