import { strict as assert } from 'node:assert'
import {
  createCustomPreset,
  deleteCustomPreset,
  normalizeCustomPresets,
  pickCustomPresetTheme,
  upsertCustomPreset,
} from '../src/customPresets.ts'

const theme = { globalBgColor: '#123456', spinnerSize: 18 }
const first = createCustomPreset('  夜航  ', theme, 100)
assert.equal(first.name, '夜航')
assert.equal(first.id, 'custom-100')
assert.deepEqual(first.theme, theme)

const saved = upsertCustomPreset([], first)
assert.equal(saved.length, 1)
const overwritten = upsertCustomPreset(saved, { ...first, theme: { globalBgColor: '#000000' }, updatedAt: 200 })
assert.equal(overwritten.length, 1)
assert.equal(overwritten[0].theme.globalBgColor, '#000000')
assert.equal(overwritten[0].updatedAt, 200)

assert.deepEqual(deleteCustomPreset(overwritten, first.id), [])
assert.deepEqual(normalizeCustomPresets([{ id: '', name: '', theme: null }, first] as never), [first])
assert.throws(() => createCustomPreset('   ', theme, 100), /名称/)

const runtimeFunction = () => 'transient'
const mixedState = {
  transparency: 0.72,
  globalFont: 'mono',
  bgBlur: 12,
  barFillFollow: true,
  spinnerSize: 18,
  ccScale: { ekg: 95 },
  ccPositions: { input: { x: 1, y: 2 } },
  activePreset: { global: 'glass' },
  dirty: { global: true },
  ccEditMode: true,
  customPresets: [first],
  profiles: [{ id: 'profile-1' }],
  sessions: [{ id: 'session-1' }],
  users: [{ id: 'user-1' }],
  runtime: { generating: true },
  unknownField: 'must not leak',
  runtimeFunction,
}
const picked = pickCustomPresetTheme(mixedState)
assert.deepEqual(picked, {
  transparency: 0.72,
  globalFont: 'mono',
  bgBlur: 12,
  barFillFollow: true,
  spinnerSize: 18,
  ccScale: { ekg: 95 },
  ccPositions: { input: { x: 1, y: 2 } },
})
assert.equal('activePreset' in picked, false)
assert.equal('dirty' in picked, false)
assert.equal('ccEditMode' in picked, false)
assert.equal('customPresets' in picked, false)
assert.equal('profiles' in picked, false)
assert.equal('sessions' in picked, false)
assert.equal('users' in picked, false)
assert.equal('runtime' in picked, false)
assert.equal('runtimeFunction' in picked, false)
assert.equal('unknownField' in picked, false)

const savedMixedPreset = createCustomPreset('混合状态', picked, 300)
assert.deepEqual(savedMixedPreset.theme, picked)
assert.equal('profiles' in savedMixedPreset.theme, false)
assert.equal('sessions' in savedMixedPreset.theme, false)
assert.equal('users' in savedMixedPreset.theme, false)
assert.equal('runtime' in savedMixedPreset.theme, false)
assert.equal('customPresets' in savedMixedPreset.theme, false)
assert.equal('activePreset' in savedMixedPreset.theme, false)
assert.equal('dirty' in savedMixedPreset.theme, false)
assert.equal('ccEditMode' in savedMixedPreset.theme, false)

console.log('customPresets 回归测试通过')
