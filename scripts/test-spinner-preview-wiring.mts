import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/', import.meta.url)
const themeDefs = await readFile(new URL('themeFieldDefs.ts', root), 'utf8')
const preview = await readFile(new URL('components/SettingsPreview.tsx', root), 'utf8')
const footer = await readFile(new URL('components/chat/GenerationFooter.tsx', root), 'utf8')

assert.match(themeDefs, /\bspinnerIntervalMs\b/)
assert.match(themeDefs, /\bspinnerDoneMarkerMode\b/)
assert.match(themeDefs, /\bspinnerCancelledMarkerMode\b/)
assert.match(themeDefs, /\bspinnerErrorMarkerMode\b/)
assert.match(preview, /summary=\{previewSummary\('done'\)\}/)
assert.match(preview, /summary=\{previewSummary\('cancelled'\)\}/)
assert.match(preview, /summary=\{previewSummary\('error'\)\}/)
assert.match(footer, /resolveSpinnerMarker\(/)
assert.match(footer, /summary\.reason === 'cancelled'/)
assert.match(footer, /summary\.reason === 'error'/)

console.log('Spinner Settings/Footer/Preview TSX wiring: PASS')
