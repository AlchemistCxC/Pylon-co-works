import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { GLOBAL_PRESETS, ZONE_FIELDS } from '../src/presets.ts'

const storeSource = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const zones = ['global', 'sidebar', 'chat', 'cc', 'right'] as const
const preset = GLOBAL_PRESETS.find(item => item.name === 'nord')
assert.ok(preset, '测试预设必须存在')

// Source evidence keeps this test dependency-free: store.ts has extensionless imports that
// native Node type stripping cannot resolve, while the actions themselves are pure state updates.
const applyZonePresetBody = storeSource.match(/applyZonePreset:\s*\(zone, presetName, presetTheme\) => set\(state => \(\{([\s\S]*?)\}\)\),/)?.[1] ?? ''
const setZoneFieldBody = storeSource.match(/setZoneField:\s*\(zone, partial\) => set\(state => \(\{([\s\S]*?)\n\s*\}\)\),/)?.[1] ?? ''
const setGlobalPresetBody = storeSource.match(/setGlobalPreset:\s*\(name, theme\) => set\(_ => \(\{([\s\S]*?)\}\)\),/)?.[1] ?? ''
assert.match(applyZonePresetBody, /\.\.\.presetTheme/)
assert.match(applyZonePresetBody, /activePreset:\s*\{\s*\.\.\.state\.activePreset, \[zone\]: presetName\s*\}/)
assert.match(applyZonePresetBody, /dirty:\s*\{\s*\.\.\.state\.dirty, \[zone\]: false\s*\}/)
assert.match(setZoneFieldBody, /\.\.\.partial/)
assert.match(setZoneFieldBody, /markZoneCustom\(state, zone\)/)
assert.match(setGlobalPresetBody, /activePreset:\s*\{\s*global: name, sidebar: name, chat: name, cc: name, right: name\s*\}/)
assert.match(setGlobalPresetBody, /dirty:\s*\{\s*global: false, sidebar: false, chat: false, cc: false, right: false\s*\}/)

// Pure state harness for the exact action contract above.
type State = Record<string, unknown> & {
  activePreset: Record<string, string>
  dirty: Record<string, boolean>
  sessions: unknown[]
  liveTokensUsed: number
  liveGenerating: string | null
}
const initial: State = {
  activePreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
  dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
  sessions: [{ id: 'session-keep' }], liveTokensUsed: 42, liveGenerating: 'runtime-source',
}
const applyZonePreset = (state: State, zone: string, presetName: string, presetTheme: Record<string, unknown>): State => ({
  ...state, ...presetTheme,
  activePreset: { ...state.activePreset, [zone]: presetName },
  dirty: { ...state.dirty, [zone]: false },
})
const setZoneField = (state: State, zone: string, partial: Record<string, unknown>): State => ({
  ...state, ...partial,
  activePreset: { ...state.activePreset, [zone]: 'custom' },
  dirty: { ...state.dirty, [zone]: true },
})
const setGlobalPreset = (state: State, name: string, theme: Record<string, unknown>): State => ({
  ...state, ...theme,
  activePreset: { global: name, sidebar: name, chat: name, cc: name, right: name },
  dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
})

const businessSnapshot = { sessions: initial.sessions, liveTokensUsed: initial.liveTokensUsed, liveGenerating: initial.liveGenerating }
let state = initial
for (const zone of zones) {
  const fields = ZONE_FIELDS[zone]
  const zoneTheme = Object.fromEntries(fields.map(field => [field, preset.theme[field]]))
  state = setZoneField(state, zone, { [fields[0]]: `before-${zone}` })
  state = applyZonePreset(state, zone, preset.name, zoneTheme)
  assert.equal(state.activePreset[zone], preset.name, `${zone}: activePreset 应为预设名`)
  assert.equal(state.dirty[zone], false, `${zone}: applyZonePreset 应清 dirty`)
  for (const field of fields) assert.deepEqual(state[field], preset.theme[field], `${zone}.${String(field)} 应写入预设字段`)
}

state = setGlobalPreset(state, 'glass', GLOBAL_PRESETS.find(item => item.name === 'glass')!.theme)
const otherPresetNames = { ...state.activePreset }
const otherDirty = { ...state.dirty }
state = setZoneField(state, 'chat', { chatFontSize: 99 })
assert.equal(state.chatFontSize, 99)
assert.equal(state.activePreset.chat, 'custom')
assert.equal(state.dirty.chat, true)
for (const zone of zones) {
  if (zone === 'chat') continue
  assert.equal(state.activePreset[zone], otherPresetNames[zone], `${zone}: setZoneField 不应污染 activePreset`)
  assert.equal(state.dirty[zone], otherDirty[zone], `${zone}: setZoneField 不应污染 dirty`)
}

state = setZoneField(state, 'sidebar', { sidebarWidth: 333 })
state = setGlobalPreset(state, 'solarized', GLOBAL_PRESETS.find(item => item.name === 'solarized')!.theme)
for (const zone of zones) {
  assert.equal(state.activePreset[zone], 'solarized', `${zone}: 全局预设应同步名称`)
  assert.equal(state.dirty[zone], false, `${zone}: 全局预设应清 dirty`)
}
assert.deepEqual({ sessions: state.sessions, liveTokensUsed: state.liveTokensUsed, liveGenerating: state.liveGenerating }, businessSnapshot, 'zone preset actions 不得影响业务实体/runtime 状态')
console.log('zone preset/dirty 状态语义回归测试通过（5 zones）')
