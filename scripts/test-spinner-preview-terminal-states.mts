import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/components/', import.meta.url)
const preview = await readFile(new URL('SettingsPreview.tsx', root), 'utf8')
const footer = await readFile(new URL('chat/GenerationFooter.tsx', root), 'utf8')
const frames = await readFile(new URL('chat/spinnerFrames.ts', root), 'utf8')

assert.match(preview, /summary=\{previewSummary\('done'\)\}/)
assert.match(preview, /summary=\{previewSummary\('cancelled'\)\}/)
assert.match(preview, /summary=\{previewSummary\('error'\)\}/)
assert.match(preview, /useStore\(s => s\.spinnerCancelledMarker\)/)
assert.match(preview, /useStore\(s => s\.spinnerErrorMarker\)/)
assert.match(footer, /summary\.reason === 'cancelled'/)
assert.match(footer, /summary\.reason === 'error'/)
assert.doesNotMatch(footer, /summary\.completedFrame \|\|/)
assert.match(frames, /export function resolveSpinnerMarker/)

console.log('Spinner Preview done/cancelled/error wiring: PASS')
