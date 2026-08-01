import assert from 'node:assert/strict'
import { advanceCodeEatingBehavior, getCodeComment, shouldStartCodeEating, shouldStartTabletCoding } from '../src/components/petBehavior.ts'

assert.equal(shouldStartCodeEating({ hasCode: false, perched: false, random: () => 0 }), false)
assert.equal(shouldStartCodeEating({ hasCode: true, perched: true, random: () => 0 }), false,
  '输入栏停靠期间不应触发啃代码')
assert.equal(shouldStartCodeEating({ hasCode: true, perched: false, random: () => 0.05 }), true)
assert.equal(shouldStartCodeEating({ hasCode: true, perched: false, random: () => 0.5 }), false)

const expected = ['sniffing-code', 'eating-code', 'chewing', 'spitting-fragment', 'commenting', 'idle'] as const
let behavior = 'idle' as const
for (const next of expected) {
  behavior = advanceCodeEatingBehavior(behavior)
  assert.equal(behavior, next)
}

assert.equal(getCodeComment(() => 0), '这段缩进有点硌牙。')
assert.equal(getCodeComment(() => 0.999), '这个函数有点长。')

assert.equal(shouldStartTabletCoding({ generating: false, behavior: 'idle', random: () => 0 }), false)
assert.equal(shouldStartTabletCoding({ generating: true, behavior: 'chewing', random: () => 0 }), false,
  '宠物执行其他行为时不应突然掏出平板')
assert.equal(shouldStartTabletCoding({ generating: true, behavior: 'idle', random: () => 0.34 }), true)
assert.equal(shouldStartTabletCoding({ generating: true, behavior: 'idle', random: () => 0.35 }), false)

console.log('pet behavior tests passed')
