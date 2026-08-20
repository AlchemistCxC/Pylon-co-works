import { strict as assert } from 'node:assert'
import { resolveCliTextareaLayout, resolveDefaultTextareaHeight } from '../src/components/chat/inputOverflowState.ts'

assert.deepEqual(resolveCliTextareaLayout(22, 'fixed-scroll'), {
  height: 22,
  overflowY: 'hidden',
  expanded: false,
})
assert.deepEqual(resolveCliTextareaLayout(120, 'fixed-scroll'), {
  height: 22,
  overflowY: 'auto',
  expanded: false,
})
assert.deepEqual(resolveCliTextareaLayout(120, 'grow'), {
  height: 120,
  overflowY: 'hidden',
  expanded: true,
})
assert.deepEqual(resolveCliTextareaLayout(280, 'grow'), {
  height: 200,
  overflowY: 'auto',
  expanded: true,
})
assert.deepEqual(resolveCliTextareaLayout(120, 'overlay'), {
  height: 120,
  overflowY: 'hidden',
  expanded: true,
})
assert.equal(resolveDefaultTextareaHeight(12), 22)
assert.equal(resolveDefaultTextareaHeight(280), 200)

console.log('inputOverflowState 回归测试通过')
