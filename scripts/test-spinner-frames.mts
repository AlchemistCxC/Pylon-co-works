import { strict as assert } from 'node:assert'
import { completionFrame, frameAt, splitSpinnerFrames } from '../src/components/chat/spinnerFrames.ts'

const fallback = splitSpinnerFrames('')
assert.ok(fallback.length > 0)
assert.deepEqual(splitSpinnerFrames('◴◷◶◵'), ['◴', '◷', '◶', '◵'])
assert.equal(frameAt(['a', 'b', 'c'], 0), 'a')
assert.equal(frameAt(['a', 'b', 'c'], 120), 'b')
assert.equal(frameAt(['a', 'b', 'c'], 360), 'a')
assert.equal(completionFrame(['←', '↑', '→'], 240), '→')
assert.equal(completionFrame([], 1000), fallback[Math.floor(1000 / 120) % fallback.length])

console.log('spinnerFrames 回归测试通过')
