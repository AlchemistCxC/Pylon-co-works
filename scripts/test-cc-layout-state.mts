import { strict as assert } from 'node:assert'
import {
  setCcHiddenState,
  setCcScaleState,
} from '../src/ccLayoutState.ts'
import { readFileSync } from 'node:fs'

assert.deepEqual(setCcHiddenState([], 'model', true), ['model'])
assert.deepEqual(setCcHiddenState(['model'], 'model', true), ['model'])
assert.deepEqual(setCcHiddenState(['model', 'mode'], 'model', false), ['mode'])

assert.deepEqual(setCcScaleState({}, 'model', 20), { model: 50 })
assert.deepEqual(setCcScaleState({ model: 100 }, 'model', 240), { model: 200 })
assert.deepEqual(setCcScaleState({ model: 100 }, 'mode', 125), { model: 100, mode: 125 })

const storeSource = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const migrationSource = readFileSync(new URL('../src/themeMigration.ts', import.meta.url), 'utf8')
const controlSource = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')
assert.equal(migrationSource.includes('normalized.ccEditMode = false'), true)
assert.equal(storeSource.includes('ccEditMode, setCcEditMode'), true, 'ccEditMode 必须从 persist payload 排除')
assert.equal(storeSource.includes('customPresets, ccEditMode'), false, 'customPresets 必须持久化（2026-08-02 修复重启丢失，不再与 ccEditMode 同剔）')
assert.equal(storeSource.includes('setCcEditMode: (enabled)'), true)
assert.equal(storeSource.includes('setCcHeight: (height)'), true)
assert.equal(controlSource.includes('useStore.setState({ ccPositions'), false)
assert.equal(controlSource.includes('useStore.setState({ ccHidden'), false)
assert.equal(controlSource.includes('useStore.setState({ ccEditMode'), false)
assert.equal(controlSource.includes('ensurePositions'), false, 'ensurePositions 死代码必须删除')
assert.equal(controlSource.includes('defaultPos'), false, 'legacy defaultPos 数据必须删除')

console.log('ccLayoutState 回归测试通过')
