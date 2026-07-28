import { strict as assert } from 'node:assert'
import {
  cloneCcPositions,
  setCcHiddenState,
  setCcScaleState,
  updateCcPositionState,
} from '../src/ccLayoutState.ts'

const defaults = {
  input: { x: 0, y: 0, w: 100, h: 52 },
  model: { x: 58, y: 69, w: 18, h: 20 },
}

const moved = updateCcPositionState(defaults, defaults, 'model', { x: 24, y: 70 })
assert.deepEqual(moved.model, { x: 24, y: 70, w: 18, h: 20 })
assert.deepEqual(defaults.model, { x: 58, y: 69, w: 18, h: 20 }, '更新不得原地修改旧状态')

const missing = updateCcPositionState({}, defaults, 'model', { x: 10 })
assert.deepEqual(missing.model, { x: 10, y: 69, w: 18, h: 20 }, '旧存储缺字段时应从默认值补齐')
assert.equal(updateCcPositionState(defaults, defaults, 'unknown', { x: 1 }), defaults)

const cloned = cloneCcPositions(defaults)
assert.deepEqual(cloned, defaults)
assert.notEqual(cloned, defaults)
assert.notEqual(cloned.model, defaults.model)

assert.deepEqual(setCcHiddenState([], 'model', true), ['model'])
assert.deepEqual(setCcHiddenState(['model'], 'model', true), ['model'])
assert.deepEqual(setCcHiddenState(['model', 'mode'], 'model', false), ['mode'])

assert.deepEqual(setCcScaleState({}, 'model', 20), { model: 50 })
assert.deepEqual(setCcScaleState({ model: 100 }, 'model', 240), { model: 200 })
assert.deepEqual(setCcScaleState({ model: 100 }, 'mode', 125), { model: 100, mode: 125 })

console.log('ccLayoutState 回归测试通过')
