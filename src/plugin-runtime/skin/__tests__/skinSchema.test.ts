import { describe, expect, it } from 'vitest'
import {
  THEME_CSS_VAR_MAP,
  THEME_FIELD_DEFS,
  THEME_SETTING_KEYS,
} from '../../../themeFieldDefs.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { MESSAGE_ROLES } from '../../../components/chat/messageTypes.ts'
import { TOOL_VISUAL_STATES } from '../../../domains/tool/status.ts'
import {
  SKIN_SURFACES,
  computeSkinSchemaRevision,
  getSkinSchema,
} from '../skinSchema.ts'

describe('Skin Schema 动态枚举（S5-A）', () => {
  it('字段集合完全来自 THEME_SETTING_KEYS，meta 字段被过滤', () => {
    const schema = getSkinSchema()

    expect(Object.keys(schema.fields).sort()).toEqual([...THEME_SETTING_KEYS].sort())
    expect(schema.fields).not.toHaveProperty('ccEditMode')
    expect(schema.fields).not.toHaveProperty('appliedPreset')
    expect(schema.fields).not.toHaveProperty('custom')
  })

  it('每个字段只暴露 contract 允许的键，不泄露 showIf/minFn/control/syncOnChange/函数', () => {
    const schema = getSkinSchema()
    const allowed = new Set(['type', 'label', 'zone', 'min', 'max', 'step', 'options', 'cssVar', 'default'])

    for (const [key, field] of Object.entries(schema.fields)) {
      for (const fieldKey of Object.keys(field)) {
        expect(allowed.has(fieldKey), `${key}.${fieldKey} 不应进入 SkinFieldSchema`).toBe(true)
      }
      expect(field.label).toBeTruthy()
      expect(field.zone).toBeTruthy()
      expect(typeof field.type).toBe('string')
    }
  })

  it('hidden 字段仍进入 schema（可被 Agent 调整），noCssVar 字段不暴露 cssVar', () => {
    const schema = getSkinSchema()

    // hidden 但非 meta 的字段仍然在 contract 中
    expect(schema.fields).toHaveProperty('toolIndicator')
    expect(schema.fields).toHaveProperty('ccLayout')

    // noCssVar 字段不得暴露 cssVar
    expect(schema.fields.userColor?.cssVar).toBeUndefined()
    expect(schema.fields.ccVariant?.cssVar).toBeUndefined()
    expect(schema.fields.barTrackColor?.cssVar).toBeUndefined()
  })

  it('color/number 字段的 cssVar 与 THEME_CSS_VAR_MAP 同源一致', () => {
    const schema = getSkinSchema()

    for (const [cssVar, key] of Object.entries(THEME_CSS_VAR_MAP)) {
      const field = schema.fields[key]
      expect(field, `${key} 应存在`).toBeDefined()
      expect(field.cssVar, `${key} 的 cssVar 应与 THEME_CSS_VAR_MAP 一致`).toBe(cssVar)
    }

    for (const [key, field] of Object.entries(schema.fields)) {
      if (field.cssVar === undefined) continue
      expect(THEME_CSS_VAR_MAP[field.cssVar], `${key} 的 cssVar 应能映射回字段`).toBe(key)
    }
  })

  it('select 字段的 options 与 defs 动态一致，复合字段 default 与 DEFAULTS 一致', () => {
    const schema = getSkinSchema()

    expect(schema.fields.inputVariant?.options).toEqual([...(THEME_FIELD_DEFS.inputVariant.options ?? [])])
    expect(schema.fields.ccStyle?.options).toEqual([...(THEME_FIELD_DEFS.ccStyle.options ?? [])])

    expect(schema.fields.ccLayout?.default).toEqual(DEFAULTS.ccLayout)
    expect(schema.fields.ccHidden?.default).toEqual(DEFAULTS.ccHidden)
    expect(schema.fields.ccScale?.default).toEqual(DEFAULTS.ccScale)
  })

  it('componentVariants 来自实际组件真值（无硬编码 variant 枚举）', () => {
    const schema = getSkinSchema()

    expect(schema.componentVariants['input-bar']).toEqual([...(THEME_FIELD_DEFS.inputVariant.options ?? [])])
    expect(schema.componentVariants['control-center']).toEqual([...(THEME_FIELD_DEFS.ccStyle.options ?? [])])
    expect(schema.componentVariants.message).toEqual([...MESSAGE_ROLES])
    expect(schema.componentVariants['tool-call']).toEqual([...TOOL_VISUAL_STATES])
  })

  it('surfaces 使用 SKIN_SURFACES 最小稳定集合，且有序', () => {
    const schema = getSkinSchema()

    expect(schema.surfaces).toEqual([...SKIN_SURFACES].sort())
  })

  it('revision 由 schema 形状稳定派生，同输入连续调用深相等', () => {
    const first = getSkinSchema()
    const second = getSkinSchema()

    expect(first).toEqual(second)
    expect(second.revision).toBe(first.revision)
    expect(first.revision).toMatch(/^skin-[a-z0-9]+$/)
  })

  it('字段集合增删会改变 revision（fixture 可发现字段变化）', () => {
    const schema = getSkinSchema()
    const shape = {
      fields: { ...schema.fields, 'fixture-new-field': schema.fields.accent },
      componentVariants: schema.componentVariants,
      surfaces: schema.surfaces,
    }

    expect(computeSkinSchemaRevision(shape)).not.toBe(schema.revision)
  })
})
