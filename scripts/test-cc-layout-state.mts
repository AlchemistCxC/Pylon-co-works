import { strict as assert } from 'node:assert'
import {
  cloneCcPositions,
  setCcHiddenState,
  setCcScaleState,
  normalizeCcPositions,
  updateCcPositionState,
} from '../src/ccLayoutState.ts'
import { readFileSync } from 'node:fs'

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

const normalized = normalizeCcPositions({
  input: { x: 1, y: 2, w: 98, h: 58 },
  model: { x: 17, y: 55, w: 18, h: 20 },
}, defaults)
assert.deepEqual(normalized.input, { x: 1, y: 2, w: 98, h: 58 })
assert.deepEqual(normalized.model, { x: 17, y: 55 }, 'naturalSize 控件迁移后只保留 x/y')

const storeSource = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const migrationSource = readFileSync(new URL('../src/themeMigration.ts', import.meta.url), 'utf8')
const controlSource = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')
assert.equal(migrationSource.includes('normalized.ccEditMode = false'), true)
assert.equal(storeSource.includes('users, ccEditMode, setActiveProfile'), true, 'ccEditMode 必须从 persist payload 排除')
assert.equal(storeSource.includes('setCcEditMode: (enabled)'), true)
assert.equal(storeSource.includes('setCcHeight: (height)'), true)
assert.equal(controlSource.includes('useStore.setState({ ccPositions'), false)
assert.equal(controlSource.includes('useStore.setState({ ccHidden'), false)
assert.equal(controlSource.includes('useStore.setState({ ccEditMode'), false)

console.log('ccLayoutState 回归测试通过')
