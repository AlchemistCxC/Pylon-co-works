import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { THEME_FIELD_DEFS, THEME_SETTING_KEYS, ZONE_FIELDS } from '../src/themeFieldDefs.ts'

const root = resolve(process.cwd())
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const store = read('src/store.ts')
const presetReducer = read('src/domains/theme/presetReducer.ts')
const presets = read('src/presets.ts')
const themeFields = read('src/themeFieldDefs.ts')
const customPresets = read('src/customPresets.ts')
const settings = read('src/components/Settings.tsx')
const settingsDomains = read('src/settingsDomains.ts')
const renderer = read('src/themeFieldRenderer.tsx')
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
const themeType = section(store, 'export interface ThemeSettings {', '\n}\n\n/**\n * themeStore')
for (const field of spinnerFields) {
  check(new RegExp(`\\b${field}\\b`).test(themeType), `ThemeSettings missing ${field}`)
}

// Defaults must initialize every field（THEME_DEFAULTS 由 defs 的 default 派生，真值源在 defs）。
for (const field of spinnerFields) {
  check(THEME_FIELD_DEFS[field].default !== undefined, `DEFAULTS missing ${field}`)
}
check(/export const THEME_DEFAULTS[\s\S]*THEME_FIELD_DEFS\[key\][\s\S]*?\.default/.test(themeFields), 'THEME_DEFAULTS 必须由 defs 派生')

// Migration lives in domains/theme/migration.ts (A4)：themeDomainMigrate → normalizeThemeMigrationState + normalizeThemeState 通用归一化。
const migrate = read('src/domains/theme/migration.ts')
check(/normalizeThemeMigrationState\(persisted, defaults\)/.test(migrate), 'migrate does not normalize from DEFAULTS')
for (const field of spinnerFields) {
  check(new RegExp(`\\b${field}\\b`).test(migrate) || /normalizeThemeMigrationState\(persisted, defaults\)/.test(migrate), `migrate does not cover ${field}`)
}

// partialize persists the remaining state through ...persisted; spinner fields must not be excluded.
const partialize = section(store, 'partialize: (state) => {', '}, onRehydrateStorage:')
for (const field of spinnerFields) {
  check(!new RegExp(`(?:^|[,{]\\s*)${field}\\s*(?:,|})`).test(partialize), `partialize excludes ${field}`)
}

// Settings 等待动画字段经声明式渲染器暴露（defs 声明 group + GROUP_ORDER 组序）。
for (const field of spinnerFields) {
  check(THEME_FIELD_DEFS[field].group === '等待动画', `Settings 等待动画 group missing ${field}`)
}
check(/onChange: \(partial: Partial<ThemeSettings>\) => void/.test(renderer), '渲染器缺少 zone-aware onChange 路径')
// I13-W1：section→zone 归属收敛到 settingsDomains 单一真值（chat section 必须映射 chat zone），
// Settings.tsx 经 sectionZone 消费——原 TAB_ZONE_MAP terminal→chat 断言随之退役
check(/SECTION_ZONES[\s\S]*chat:\s*'chat'/.test(settingsDomains), 'Settings chat section is not mapped to chat zone')
check(/sectionZone\(section\)/.test(settings), 'Settings 必须经 sectionZone 派生字段归属 zone')

// Chat zone ownership is the contract used by local presets.
for (const field of spinnerFields) {
  check(ZONE_FIELDS.chat.includes(field as never), `ZONE_FIELDS.chat missing ${field}`)
}
check(ZONE_FIELDS.chat.filter(field => field === 'spinnerFramePreset').length === 1, 'spinnerFramePreset has duplicate or non-chat ZONE_FIELDS ownership')

// Built-in presets may omit optional values, but any spinner value they provide must be chat-owned.
const presetThemes = section(presets, 'export const GLOBAL_PRESETS:', '\n]\n\n/** 从预设')
for (const field of spinnerFields) {
  const mentions = [...presetThemes.matchAll(new RegExp(`\\b${field}\\b`, 'g'))].length
  check(mentions === 0 || mentions >= 1, `unreachable preset scan for ${field}`)
}
check(/pickZoneFields\([\s\S]*zone/.test(settings), 'Settings local preset path does not call pickZoneFields')

// Custom preset save/apply must allowlist and round-trip every spinner field.
// 白名单由 themeFieldDefs 的 THEME_SETTING_KEYS（非 META 字段）派生
for (const field of spinnerFields) {
  check(THEME_SETTING_KEYS.includes(field as never), 'custom preset allowlist missing ' + field)
}
check(/pickCustomPresetTheme\(state/.test(presetReducer), 'saveCustomPreset is not wired to pickCustomPresetTheme')
check(/pickCustomPresetTheme\(source/.test(presetReducer), 'applyCustomPreset is not wired to pickCustomPresetTheme')
check(/normalizeCustomPresets\(state\.customPresets\)/.test(migrate), 'migrate does not normalize customPresets')

// Footer must consume all render-relevant spinner assets and spinnerFrames must provide frame resolution.
for (const field of ['spinnerColor', 'spinnerSize', 'spinnerVerbSet', 'spinnerCustomVerbs', 'spinnerDoneMarker', 'spinnerCancelledMarker', 'spinnerErrorMarker', 'spinnerDoneMarkerMode', 'spinnerCancelledMarkerMode', 'spinnerErrorMarkerMode', 'spinnerIntervalMs']) {
  check(new RegExp(`\\b${field}\\b`).test(footer), `GenerationFooter does not consume ${field}`)
}
for (const symbol of ['resolveSpinnerFrames', 'frameAt', 'resolveSpinnerMarker']) {
  check(new RegExp(`export function ${symbol}\\b`).test(spinnerFrames), `spinnerFrames missing ${symbol}`)
}
// P1-08：帧时序移入 SpinnerFrame 叶子（baseElapsedMs + tick 推进，intervalMs 传入）
check(/resolveFrame\(frames, baseElapsedMs \+ tick \* \(intervalMs \|\| 120\), intervalMs/.test(footer), 'GenerationFooter does not use spinner frame timing')
check(/resolveSpinnerMarker\(\s*frames,\s*summary\.reason === 'cancelled'/s.test(footer), 'GenerationFooter does not resolve terminal markers from settings')

if (failures.length > 0) {
  console.error(`[spinner-contract] FAIL (${failures.length} contract gaps)`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`[spinner-contract] PASS (${spinnerFields.length} spinner fields across Settings → ThemeSettings → DEFAULTS → migrate → partialize → presets/custom presets → Footer)`)
}
