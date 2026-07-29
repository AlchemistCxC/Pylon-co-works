import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/components/', import.meta.url)
const settings = await readFile(new URL('Settings.tsx', root), 'utf8')
const preview = await readFile(new URL('SettingsPreview.tsx', root), 'utf8')
const footer = await readFile(new URL('chat/GenerationFooter.tsx', root), 'utf8')

assert.match(settings, /spinnerIntervalMs/)
assert.match(settings, /spinnerDoneMarkerMode/)
assert.match(settings, /spinnerCancelledMarkerMode/)
assert.match(settings, /spinnerErrorMarkerMode/)
assert.match(preview, /summary=\{previewSummary\('done'\)\}/)
assert.match(preview, /summary=\{previewSummary\('cancelled'\)\}/)
assert.match(preview, /summary=\{previewSummary\('error'\)\}/)
assert.match(footer, /resolveSpinnerMarker\(/)
assert.match(footer, /summary\.reason === 'cancelled'/)
assert.match(footer, /summary\.reason === 'error'/)

console.log('Spinner Settings/Footer/Preview TSX wiring: PASS')
