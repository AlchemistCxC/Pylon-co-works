import { readFileSync } from 'node:fs'

const previewPath = 'src/components/SettingsPreview.tsx'
const storePath = 'src/store.ts'
const settingsPath = 'src/components/Settings.tsx'

const preview = readFileSync(previewPath, 'utf8')
const store = readFileSync(storePath, 'utf8')
const settings = readFileSync(settingsPath, 'utf8')

const requireToken = (source: string, token: string, label: string) => {
  if (!source.includes(token)) throw new Error(`missing ${label}: ${token}`)
}

// Audit the intended boundary without changing business code. The current
// implementation is expected to remain blocked until SettingsPreview receives
// a constrained ThemeSettings snapshot instead of reading the global store.
requireToken(store, 'export interface ThemeSettings', 'ThemeSettings declaration')
requireToken(preview, "import { useStore } from '../store'", 'global store import')
requireToken(preview, 'useStore(s => s.rightBg)', 'rightBg store selector')
requireToken(preview, 'useStore(s => s.userName)', 'userName store selector')
requireToken(preview, 'useStore(s => s.spinnerFramePreset)', 'spinner store selector')
requireToken(preview, 'useStore(s => s.toolConnectorMode)', 'tool store selector')
requireToken(settings, '<SettingsPreview zone={previewZone} />', 'Settings preview call site')

const hasThemeSettingsBoundary = /SettingsPreview[^\n]*ThemeSettings|PreviewApp[^\n]*ThemeSettings|snapshot\s*[:?]\s*ThemeSettings/.test(preview)
const hasStoreSelectors = (preview.match(/useStore\(s\s*=>/g) ?? []).length

if (hasThemeSettingsBoundary) {
  throw new Error('unexpected ThemeSettings snapshot boundary: audit assumptions are stale')
}
if (hasStoreSelectors === 0) {
  throw new Error('expected current global-store selectors were not found')
}

console.log('E-12A preview theme snapshot audit: BLOCKED')
console.log('- ThemeSettings exists in src/store.ts, but SettingsPreview has no constrained snapshot prop/model.')
console.log(`- SettingsPreview currently performs ${hasStoreSelectors} direct useStore selector read(s).`)
console.log('- Settings.tsx still calls <SettingsPreview zone={previewZone} /> without a snapshot.')
console.log('- No business source changed by this audit; a Settings/preview wiring change is required before implementation can proceed.')
console.log('status: blocked / not implemented')
