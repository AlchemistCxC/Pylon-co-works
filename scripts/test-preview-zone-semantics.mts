import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const previewPath = new URL('../src/components/SettingsPreview.tsx', import.meta.url)
const settingsPath = new URL('../src/components/Settings.tsx', import.meta.url)
const preview = readFileSync(previewPath, 'utf8')
const settings = readFileSync(settingsPath, 'utf8')

function sectionBetween(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken)
  assert.ok(start >= 0, `missing source section: ${startToken}`)
  const end = source.indexOf(endToken, start + startToken.length)
  assert.ok(end >= 0, `missing source section terminator: ${endToken}`)
  return source.slice(start, end)
}

// E-12D is a source-level semantic contract: SettingsPreview is a complete
// app preview, and its zone prop only selects the outline target.
const previewApp = sectionBetween(preview, 'function PreviewApp', '\nfunction PvUser')
const zHelper = sectionBetween(previewApp, '  const z =', '  const rightStyle')

assert.match(preview, /interface Props \{ zone: string \}/)
assert.match(preview, /<PreviewApp zone=\{zone\} \/>/)
assert.match(settings, /<SettingsPreview zone=\{previewZone\} \/>/)

// The only zone-dependent behavior must be the outline returned by z(name).
assert.match(zHelper, /zone === name \? \{ outline: ['"]2px solid var\(--accent,#3b82f6\)['"], outlineOffset: ['"]-2px['"] \} : \{\}/)
assert.equal((previewApp.match(/zone ===/g) ?? []).length, 1, 'zone must not control conditional rendering')
assert.match(previewApp, /style=\{\{ \.\.\.z\('global'\)/)
for (const zone of ['sidebar', 'chat', 'cc', 'right']) {
  assert.match(previewApp, new RegExp(`z\\('${zone}'\\)`), `missing outline target for ${zone}`)
}

// PreviewApp must retain the complete titlebar/sidebar/chat/cc/right structure
// for every zone; this deliberately rejects a zone-only rendering model.
for (const token of [
  '<div className="titlebar"',
  '<aside className="sidebar"',
  '<div className="chat-view"',
  '<ControlCenter sessionId={null} />',
  '<aside className="right-panel pv-right-panel"',
]) {
  assert.ok(previewApp.includes(token), `complete preview structure missing: ${token}`)
}

const structureOrder = [
  previewApp.indexOf('<div className="titlebar"'),
  previewApp.indexOf('<aside className="sidebar"'),
  previewApp.indexOf('<div className="chat-view"'),
  previewApp.indexOf('<ControlCenter sessionId={null} />'),
  previewApp.indexOf('<aside className="right-panel pv-right-panel"'),
]
assert.ok(structureOrder.every(index => index >= 0), 'all complete-preview regions must exist')
assert.ok(structureOrder.every((index, i) => i === 0 || index > structureOrder[i - 1]), 'complete preview regions must remain in app order')

console.log('settings-preview-zone-semantics contract: PASS')
console.log('- zone selects outline styling only; PreviewApp keeps complete titlebar/sidebar/chat/cc/right structure')
