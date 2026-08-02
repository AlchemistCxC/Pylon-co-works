import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  completionFrame,
  frameAt,
  normalizeSpinnerFrames,
  resolveSpinnerFrames,
  resolveSpinnerMarker,
  splitSpinnerFrames,
} from '../src/components/chat/spinnerFrames.ts'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const settings = source('../src/components/Settings.tsx')
const footer = source('../src/components/chat/GenerationFooter.tsx')
const store = source('../src/store.ts')

// Pure spinnerFrames coverage: grapheme-safe de-duplication and marker fallback.
assert.deepEqual(normalizeSpinnerFrames('😀👨‍💻🇨🇳😀'), ['😀', '👨‍💻', '🇨🇳'])
assert.deepEqual(splitSpinnerFrames(''), splitSpinnerFrames('✳✴✵✶✷✸✹✺✻✼❃❊'))
assert.deepEqual(resolveSpinnerFrames('ascii-line', ''), ['|', '/', '-', '\\'])
assert.deepEqual(resolveSpinnerFrames('custom', 'a👨‍💻a'), ['a', '👨‍💻'])
assert.equal(resolveSpinnerMarker(['◴', '◷'], 'frame', '◷'), '◷')
assert.equal(resolveSpinnerMarker(['◴', '◷'], 'frame', 'missing'), '◴')
assert.equal(resolveSpinnerMarker(['◴', '◷'], 'custom', ' ✓ '), '✓')
assert.equal(resolveSpinnerMarker(['◴', '◷'], 'custom', ''), '◴')
assert.equal(frameAt(['a', 'b', 'c'], 0, 120), 'a')
assert.equal(frameAt(['a', 'b', 'c'], 120, 120), 'b')
assert.equal(completionFrame(['←', '↑', '→'], 240), '→')

// Settings non-Preview wiring: 声明式渲染器分发 spinnerMarker 控件到专用组件。
const themeDefs = source('../src/themeFieldDefs.ts')
const renderer = source('../src/themeFieldRenderer.tsx')
assert.match(themeDefs, /\bspinnerDoneMarker\b[\s\S]*?control: 'spinnerMarker'/)
assert.match(renderer, /control === 'spinnerMarker'/)
assert.match(renderer, /spinnerDoneMarkerMode/)
assert.equal((themeDefs.match(/'frame', 'custom'/g) ?? []).length >= 3, true)

// Interval wiring is covered through the persisted setting and the live footer timer/frame path.
assert.match(store, /spinnerIntervalMs: number/)
assert.match(store, /spinnerIntervalMs: 120/)
assert.match(store, /state\.spinnerIntervalMs = typeof state\.spinnerIntervalMs === 'number'/)
assert.match(footer, /const spinnerIntervalMs = useStore\(s => s\.spinnerIntervalMs\)/)
assert.match(footer, /setInterval\([\s\S]*?Math\.max\(40, Math\.min\(1000, spinnerIntervalMs \|\| 120\)\)/)
assert.match(footer, /frameAt\(frames, elapsedMs, spinnerIntervalMs(?:,|\))/)

// GenerationFooter frame/custom marker parsing and terminal-state color isolation.
assert.doesNotMatch(footer, /summary\.completedFrame \|\|/)
assert.match(footer, /resolveSpinnerMarker\(\s*frames,\s*summary\.reason === 'cancelled'[\s\S]*?spinnerCancelledMarkerMode[\s\S]*?spinnerCancelledMarker/s)
assert.match(footer, /resolveSpinnerMarker\(\s*frames,\s*summary\.reason === 'cancelled'[\s\S]*?spinnerErrorMarkerMode[\s\S]*?spinnerErrorMarker/s)
assert.match(footer, /resolveSpinnerMarker\(\s*frames,\s*summary\.reason === 'cancelled'[\s\S]*?spinnerDoneMarkerMode[\s\S]*?spinnerDoneMarker/s)
const terminalFrame = footer.match(/<span className="term-summary-frame"[\s\S]*?<\/span>/)?.[0] ?? ''
assert.ok(terminalFrame, '应存在终止态 marker')
assert.doesNotMatch(terminalFrame, /spinnerColor/, '终止态 marker 不得复用运行中 spinnerColor')
assert.match(terminalFrame, /fontSize: `\$\{spinnerSize\}px`/)

console.log('D-01E 非 Preview TSX 接线回归测试通过（Preview 未覆盖）')
