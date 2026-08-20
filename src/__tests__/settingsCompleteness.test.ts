/**
 * Settings 完整性测试（报告 7D）：禁止"可编辑但无消费方"的死设置——
 * 每个主题字段必有合法 def、CSS var 消费、默认值；syncOnChange 引用存在。
 */
import { describe, expect, it } from 'vitest'
import { THEME_FIELD_DEFS, THEME_FIELD_KEYS, THEME_CSS_VAR_MAP, THEME_SETTING_KEYS, ZONES, type ThemeFieldDef } from '../themeFieldDefs'
import { DEFAULTS } from '../domains/theme/themeDefaults'

const VALID_TYPES = ['color', 'number', 'select', 'boolean', 'text']

describe('Settings 完整性（报告 7D）', () => {
  it('每个字段必有 label/type/zone 且合法', () => {
    for (const key of THEME_FIELD_KEYS) {
      const def = THEME_FIELD_DEFS[key]
      expect(def.label, `${key}.label 必填`).toBeTruthy()
      expect(VALID_TYPES, `${key}.type 非法`).toContain(def.type)
      expect(ZONES, `${key}.zone 非法`).toContain(def.zone)
    }
  })

  it('color/number 字段必有 CSS var 消费（无死设置）', () => {
    // THEME_CSS_VAR_MAP 只收 color/number（非 noCssVar）；select/boolean/text 由渲染/逻辑消费
    const mappedKeys = new Set(Object.values(THEME_CSS_VAR_MAP))
    for (const key of THEME_FIELD_KEYS) {
      const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
      if (def.noCssVar) continue
      if (def.type === 'color' || def.type === 'number') {
        expect(mappedKeys.has(key), `${key} 缺 CSS var 消费方`).toBe(true)
      }
    }
  })

  it('DEFAULTS 覆盖全部用户设置字段（每个设置都有默认值）', () => {
    for (const key of THEME_SETTING_KEYS) {
      expect(key in DEFAULTS, `${key} 缺默认值`).toBe(true)
    }
  })

  it('syncOnChange 引用存在的字段', () => {
    for (const key of THEME_FIELD_KEYS) {
      const def = THEME_FIELD_DEFS[key] as ThemeFieldDef
      if (!def.syncOnChange) continue
      for (const target of def.syncOnChange) {
        expect((THEME_FIELD_DEFS as Record<string, unknown>)[target], `${key}.syncOnChange 引用不存在字段 ${target}`).toBeTruthy()
      }
    }
  })
})
