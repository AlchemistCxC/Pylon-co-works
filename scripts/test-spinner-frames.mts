import { strict as assert } from 'node:assert'
import { completionFrame, frameAt, splitSpinnerFrames } from '../src/components/chat/spinnerFrames.ts'
import { readFileSync } from 'node:fs'

const fallback = splitSpinnerFrames('')
assert.ok(fallback.length > 0)
assert.deepEqual(splitSpinnerFrames('◴◷◶◵'), ['◴', '◷', '◶', '◵'])
assert.equal(frameAt(['a', 'b', 'c'], 0), 'a')
assert.equal(frameAt(['a', 'b', 'c'], 120), 'b')
assert.equal(frameAt(['a', 'b', 'c'], 360), 'a')
assert.equal(completionFrame(['←', '↑', '→'], 240), '→')
assert.equal(completionFrame([], 1000), fallback[Math.floor(1000 / 120) % fallback.length])

const css = readFileSync(new URL('../src/components/chat/ChatView.css', import.meta.url), 'utf8')
const summaryRule = css.match(/\.term-summary \{[^}]+\}/)?.[0] || ''
assert.equal(summaryRule.includes('font-size:var(--spinner-size,14px)'), true)
assert.equal(summaryRule.includes('color:var(--text-dim)'), true)
assert.equal(css.includes('.term-summary-frame { color:inherit; font-size:1.15em;'), true)
assert.equal(summaryRule.includes('var(--spinner-color'), false, '完成态不得继续使用运行中 spinner 颜色')

console.log('spinnerFrames 回归测试通过')
