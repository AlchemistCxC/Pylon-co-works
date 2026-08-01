import { strict as assert } from 'node:assert'
import { markZoneCustom } from '../src/themePresetState.ts'

const state = {
  activePreset: { global: 'claude', cc: 'glass', chat: 'nord' },
  dirty: { global: false, cc: false, chat: false },
}

const next = markZoneCustom(state, 'cc')
assert.deepEqual(next, {
  activePreset: { global: 'claude', cc: 'custom', chat: 'nord' },
  dirty: { global: false, cc: true, chat: false },
})
assert.deepEqual(state, {
  activePreset: { global: 'claude', cc: 'glass', chat: 'nord' },
  dirty: { global: false, cc: false, chat: false },
}, '不得修改输入快照')

console.log('themePresetState 回归测试通过')
