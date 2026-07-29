import { strict as assert } from 'node:assert'
import { completionFrame, frameAt, resolveSpinnerFrames, splitSpinnerFrames } from '../src/components/chat/spinnerFrames.ts'
import { readFileSync } from 'node:fs'

const fallback = splitSpinnerFrames('')
assert.ok(fallback.length > 0)
assert.deepEqual(splitSpinnerFrames('◴◷◶◵'), ['◴', '◷', '◶', '◵'])
assert.deepEqual(resolveSpinnerFrames('ascii-line', ''), ['|', '/', '-', '\\'])
assert.deepEqual(resolveSpinnerFrames('custom', 'aabb'), ['a', 'b'])
assert.deepEqual(resolveSpinnerFrames('custom', ''), fallback)
assert.equal(frameAt(['a', 'b', 'c'], 0), 'a')
assert.equal(frameAt(['a', 'b', 'c'], 120), 'b')
assert.equal(frameAt(['a', 'b', 'c'], 360), 'a')
assert.equal(completionFrame(['←', '↑', '→'], 240), '→')
assert.equal(completionFrame([], 1000), fallback[Math.floor(1000 / 120) % fallback.length])

const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
assert.equal(store.includes("spinnerFramePreset: 'sparkles'"), true)
assert.equal(store.includes('spinnerCustomFrames: string'), true)
assert.equal(store.includes("spinnerVerbSet: 'zh'"), true)
assert.equal(store.includes('spinnerIntervalMs: number'), true)
assert.equal(store.includes("state.spinnerFramePreset = state.spinnerFramePreset"), true)
const summaryRule = css.match(/\.term-summary \{[^}]+\}/)?.[0] || ''
assert.equal(summaryRule.includes('font-size:var(--spinner-size,14px)'), true)
assert.equal(summaryRule.includes('color:var(--text-dim)'), true)
assert.equal(css.includes('.term-summary-frame { color:inherit; font-size:1.15em;'), true)
assert.equal(summaryRule.includes('var(--spinner-color'), false, '完成态不得继续使用运行中 spinner 颜色')

console.log('spinnerFrames 回归测试通过')
