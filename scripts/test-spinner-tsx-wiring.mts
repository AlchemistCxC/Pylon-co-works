/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
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
const migration = source('../src/domains/theme/migration.ts')

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
assert.equal(frameAt(['←', '↑', '→'], 240), '→')

// Settings non-Preview wiring: 声明式渲染器分发 spinnerMarker 控件到专用组件。
const themeDefs = source('../src/themeFieldDefs.ts')
const renderer = source('../src/themeFieldRenderer.tsx')
assert.match(themeDefs, /\bspinnerDoneMarker\b[\s\S]*?control: 'spinnerMarker'/)
assert.match(renderer, /control === 'spinnerMarker'/)
assert.match(renderer, /spinnerDoneMarkerMode/)
assert.equal((themeDefs.match(/'frame', 'custom'/g) ?? []).length >= 3, true)

// Interval wiring is covered through the persisted setting and the live footer timer/frame path.
assert.match(store, /spinnerIntervalMs: number/)
assert.match(themeDefs, /spinnerIntervalMs: \{[\s\S]*?default: 120/)
assert.match(migration, /normalizeThemeState\(state\)/, 'migrate 必须走 defs 驱动的通用归一化')
assert.match(footer, /const spinnerIntervalMs = useStore\(s => s\.spinnerIntervalMs\)/)
// P1-08：帧时序移入 SpinnerFrame 叶子（热路径隔离），叶子持 tick 推进 elapsed
assert.match(footer, /setInterval\([\s\S]*?Math\.max\(40, Math\.min\(1000, intervalMs \|\| 120\)\)/)
assert.match(footer, /resolveFrame\(frames, baseElapsedMs \+ tick \* \(intervalMs \|\| 120\), intervalMs/)

// GenerationFooter frame/custom marker parsing and terminal-state color isolation.
assert.doesNotMatch(footer, /summary\.completedFrame \|\|/)
assert.match(footer, /resolveSpinnerMarker\(\s*frames,\s*summary\.reason === 'cancelled'[\s\S]*?spinnerCancelledMarkerMode[\s\S]*?spinnerCancelledMarker/s)
assert.match(footer, /resolveSpinnerMarker\(\s*frames,\s*summary\.reason === 'cancelled'[\s\S]*?spinnerErrorMarkerMode[\s\S]*?spinnerErrorMarker/s)
assert.match(footer, /resolveSpinnerMarker\(\s*frames,\s*summary\.reason === 'cancelled'[\s\S]*?spinnerDoneMarkerMode[\s\S]*?spinnerDoneMarker/s)
const terminalFrame = footer.match(/<span className="term-summary-frame"[\s\S]*?<\/span>/)?.[0] ?? ''
assert.ok(terminalFrame, '应存在终止态 marker')
assert.doesNotMatch(terminalFrame, /spinnerColor/, '终止态 marker 不得复用运行中 spinnerColor')
assert.match(terminalFrame, /fontSize: `\$\{spinnerSize\}px`/)

// Settings 冗余治理：标记模式内嵌于 spinnerMarker 控件，独立行必须隐藏；
// 特殊控件（spinnerMarker/bgImage）不得自带 Row（label 由 FieldRow 单层提供，防双重 label）。
assert.match(themeDefs, /spinnerDoneMarkerMode:[\s\S]*?hidden: true/, '完成标记模式行必须隐藏')
assert.match(themeDefs, /spinnerCancelledMarkerMode:[\s\S]*?hidden: true/, '取消标记模式行必须隐藏')
assert.match(themeDefs, /spinnerErrorMarkerMode:[\s\S]*?hidden: true/, '错误标记模式行必须隐藏')
assert.equal((renderer.match(/<Row label=/g) ?? []).length, 1, 'label 必须仅由 FieldRow 的 <Row label=...> 提供一次（特殊控件不得自带 Row）')
assert.match(renderer, /function FieldRow\([\s\S]*?<Row label=\{def\.label\}[^>]*>/, 'label Row 必须存在于 FieldRow')

console.log('D-01E 非 Preview TSX 接线回归测试通过（Preview 未覆盖）')
