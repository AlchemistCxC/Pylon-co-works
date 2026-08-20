import { strict as assert } from 'node:assert'
import {
  createCustomPreset,
  createCustomPresetId,
  deleteCustomPreset,
  pickCustomPresetTheme,
  upsertCustomPreset,
} from '../src/customPresets.ts'

const theme = { globalBgColor: '#123456' }
const first = createCustomPreset('first', theme, 1000)
const second = createCustomPreset('second', theme, 1000)
assert.notEqual(first.id, second.id)
assert.equal(first.id, 'custom-1000')
assert.equal(second.id, 'custom-1000-1')

assert.equal(createCustomPresetId(2000), 'custom-2000')
assert.equal(createCustomPresetId(2000, ['custom-2000']), 'custom-2000-1')
assert.equal(createCustomPresetId(2000, ['custom-2000', 'custom-2000-1']), 'custom-2000-2')

const explicitTimes = [
  createCustomPreset('at 3000', theme, 3000),
  createCustomPreset('at 4000', theme, 4000),
]
assert.equal(explicitTimes[0].id, 'custom-3000')
assert.equal(explicitTimes[1].id, 'custom-4000')

const updated = { ...first, name: 'updated', updatedAt: 1001 }
const upserted = upsertCustomPreset([first, second], updated)
assert.deepEqual(upserted.map(preset => preset.id), [first.id, second.id])
assert.equal(upserted[0].name, 'updated')
assert.deepEqual(deleteCustomPreset(upserted, first.id).map(preset => preset.id), [second.id])

const pickedTheme = pickCustomPresetTheme({
  globalBgColor: '#abcdef',
  ccScale: { input: 100 },
  appliedPreset: { global: 'stale' },
  custom: { global: true },
  ccEditMode: true,
  customPresets: [],
  callback: () => 'ignored',
})
assert.deepEqual(pickedTheme, { globalBgColor: '#abcdef', ccScale: { input: 100 } })

console.log('custom preset ID / theme whitelist 回归测试通过')
