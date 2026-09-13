// 迁移自 scripts/test-theme-preset-state.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { markZoneCustom } from '../themePresetState.ts'

// A1 模型：字段写入只标 custom[zone]=true，不动 appliedPreset（基准保留供"恢复原预设"）

describe('themePresetState markZoneCustom（迁移自 scripts/test-theme-preset-state.mts，P91 A1）', () => {
  it('字段写入只置 custom[zone]，不动 appliedPreset，不改输入快照', () => {
    const state = {
      appliedPreset: { global: 'claude', cc: 'glass', chat: 'nord' },
      custom: { global: false, cc: false, chat: false },
    }

    const next = markZoneCustom(state, 'cc')
    expect(next).toEqual({
      custom: { global: false, cc: true, chat: false },
    }) // 字段写入只置 custom[zone]
    expect(state).toEqual({
      appliedPreset: { global: 'claude', cc: 'glass', chat: 'nord' },
      custom: { global: false, cc: false, chat: false },
    }) // 不得修改输入快照
  })
})
