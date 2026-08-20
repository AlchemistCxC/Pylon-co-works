import { strict as assert } from 'node:assert'
import { markZoneCustom } from '../src/themePresetState.ts'

// A1 模型：字段写入只标 custom[zone]=true，不动 appliedPreset（基准保留供"恢复原预设"）
const state = {
  appliedPreset: { global: 'claude', cc: 'glass', chat: 'nord' },
  custom: { global: false, cc: false, chat: false },
}

const next = markZoneCustom(state, 'cc')
assert.deepEqual(next, {
  custom: { global: false, cc: true, chat: false },
}, '字段写入只置 custom[zone]')
assert.deepEqual(state, {
  appliedPreset: { global: 'claude', cc: 'glass', chat: 'nord' },
  custom: { global: false, cc: false, chat: false },
}, '不得修改输入快照')

console.log('themePresetState 回归测试通过（A1 模型：触碰标记与基准分离）')
