import { strict as assert } from 'node:assert'
import {
  createCustomPreset,
  deleteCustomPreset,
  normalizeCustomPresets,
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

console.log('customPresets 回归测试通过')
