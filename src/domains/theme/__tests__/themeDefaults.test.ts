// 迁移自 scripts/test-defaults-completeness.mts（P91 A1）。
// Q1（外部审阅结论）：默认值完整性用运行时断言，不做类型体操。
// 每个主题字段（含 meta/对象字段）都必须在 DEFAULTS 有值——加字段漏默认值即红。
import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../themeDefaults.ts'
import { THEME_FIELD_KEYS } from '../../../themeFieldDefs.ts'
import { PRESET_ZONES } from '../presetReducer.ts'

describe('DEFAULTS 完整性（原 test-defaults-completeness.mts）', () => {
  it('每个主题字段（含 meta/对象字段）都有默认值', () => {
    const missing: string[] = []
    for (const key of THEME_FIELD_KEYS) {
      if ((DEFAULTS as unknown as Record<string, unknown>)[key] === undefined) missing.push(key)
    }
    expect(missing, `DEFAULTS 缺少必填键：${missing.join(', ')}`).toEqual([])
  })

  it('appliedPreset/custom 键集精确等于 PRESET_ZONES（新增 zone 漏改即红）', () => {
    const zoneKeys = [...PRESET_ZONES].sort()
    expect(Object.keys(DEFAULTS.appliedPreset).sort(), 'DEFAULTS.appliedPreset 键集必须等于 PRESET_ZONES').toEqual(zoneKeys)
    expect(Object.keys(DEFAULTS.custom).sort(), 'DEFAULTS.custom 键集必须等于 PRESET_ZONES').toEqual(zoneKeys)
  })
})
