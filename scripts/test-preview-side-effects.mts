import { readFileSync } from 'node:fs'

const preview = readFileSync('src/components/SettingsPreview.tsx', 'utf8')
const controlCenter = readFileSync('src/components/ControlCenter.tsx', 'utf8')
const widgetRegistry = readFileSync('src/components/cc/widgetRegistry.tsx', 'utf8')
const generationFooter = readFileSync('src/components/chat/GenerationFooter.tsx', 'utf8')
const store = readFileSync('src/store.ts', 'utf8')

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function section(source: string, name: string): string {
  const start = source.indexOf(name)
  assert(start >= 0, `missing source section: ${name}`)
  return source.slice(start)
}

// SettingsPreview must assemble the real visual components, while keeping the
// preview boundary explicit: no direct backend/session-runtime wiring here.
assert(preview.includes("import ControlCenter from './ControlCenter'"), 'preview must use the real ControlCenter')
assert(preview.includes("import GenerationFooter from './chat/GenerationFooter'"), 'preview must use the real GenerationFooter')
assert(preview.includes('<ControlCenter sessionId={null} />'), 'preview ControlCenter must be isolated with sessionId={null}')
assert(preview.includes('<div className="pv-app" style={{ pointerEvents: \'none\' }}>'), 'preview must retain the visual pointer-events boundary')
assert(!/\binvoke\s*\(/.test(preview), 'SettingsPreview must not call invoke()')
assert(!/\blisten\s*\(/.test(preview), 'SettingsPreview must not call listen()')
assert(!/\b(?:sessions|sessionLiveStats|runtime)\b/.test(preview), 'SettingsPreview must not read sessions or runtime state directly')

// pointer-events:none is a CSS interaction guard, not a logical read-only
// guarantee. Keep the distinction executable in the contract test: the
// preview source must not claim that CSS alone makes the tree side-effect free.
assert(!/logical(?:ly)?\s*read[- ]?only|逻辑只读|side[- ]?effect[- ]?free/i.test(preview), 'pointer-events:none must not be described as logical read-only')

const previewApp = section(preview, 'function PreviewApp')
const previewSpinner = section(preview, 'function PvSpinner')
assert(previewApp.includes('<ControlCenter sessionId={null} />'), 'PreviewApp must render the real ControlCenter')
assert(previewSpinner.includes('<GenerationFooter running'), 'PreviewApp must render the real GenerationFooter path')

// Guard the known real-component effects so this test documents the boundary
// rather than pretending the components are inert. ControlCenter has DOM
// listeners and store-backed session/runtime selectors; GenerationFooter has
// a timer while running. The preview must pass the null session boundary and
// must not add backend calls of its own.
assert(/window\.addEventListener\(['"]keydown['"]/.test(controlCenter), 'ControlCenter side-effect contract changed: expected keydown listener')
assert(/document\.addEventListener\(['"]mousemove['"]/.test(controlCenter), 'ControlCenter side-effect contract changed: expected drag listener')
assert(/useSessionLiveStats\(sessionId\)/.test(widgetRegistry), 'widget registry side-effect contract changed: expected session runtime path')
assert(/setInterval\(/.test(generationFooter), 'GenerationFooter side-effect contract changed: expected running timer')
assert(/clearInterval\(/.test(generationFooter), 'GenerationFooter side-effect contract changed: expected timer cleanup')
assert(/reportLegacyProfilePayload\([^)]*\)/.test(store) && /persist\(/.test(store), 'store side-effect contract changed: expected legacy payload reporting and persistence wiring')

console.log('settings-preview-side-effects contract: PASS')
