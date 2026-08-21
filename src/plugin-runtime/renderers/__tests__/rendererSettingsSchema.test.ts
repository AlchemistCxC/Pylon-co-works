import { describe, expect, it } from 'vitest'
import { normalizeRendererSettingsSchema, validateRendererSettingsSchema, type RendererSettingsSchema } from '../rendererSettingsTypes.ts'

const valid: RendererSettingsSchema = {
  schemaVersion: 1,
  groups: [{
    id: 'appearance',
    label: 'Appearance',
    fields: [
      { key: 'style', type: 'choice', presentation: 'segmented', options: [{ value: 'compact' }, { value: 'roomy' }], default: 'compact' },
      { key: 'parts', type: 'multi-choice', presentation: 'checklist', options: [{ value: 'text' }, { value: 'code' }], default: ['text'] },
      { key: 'accent', type: 'color', presentation: 'palette+picker', alpha: true, default: '#3366ff' },
      { key: 'scale', type: 'number', presentation: 'slider+input', min: 50, max: 150, step: 10, default: 100 },
      { key: 'enabled', type: 'boolean', presentation: 'toggle', default: true },
      { key: 'label', type: 'text', presentation: 'input', maxLength: 32, default: 'demo' },
      { key: 'advancedLabel', type: 'text', presentation: 'textarea', showIf: { equals: { field: 'enabled', value: true } } },
    ],
  }],
}

describe('renderer settings schema', () => {
  it('七类控件和组合 group 可 round-trip 为冻结 schema', () => {
    const normalized = normalizeRendererSettingsSchema(valid)
    expect(normalized).toEqual(valid)
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.groups[0])).toBe(true)
    expect(Object.isFrozen(normalized.groups[0].fields)).toBe(true)
  })

  it.each([
    ['重复 field key', { ...valid, groups: [{ ...valid.groups[0], fields: [valid.groups[0].fields[0], valid.groups[0].fields[0]] }] }],
    ['choice 没有 options', { ...valid, groups: [{ ...valid.groups[0], fields: [{ key: 'bad', type: 'choice', presentation: 'select', options: [] }] }] }],
    ['choice default 不在 options', { ...valid, groups: [{ ...valid.groups[0], fields: [{ key: 'bad', type: 'choice', presentation: 'select', options: [{ value: 'a' }], default: 'b' }] }] }],
    ['condition 引用未知字段', { ...valid, groups: [{ ...valid.groups[0], fields: [{ key: 'bad', type: 'boolean', presentation: 'toggle', showIf: { equals: { field: 'missing', value: true } } }] }] }],
    ['非法 option target', { ...valid, groups: [{ ...valid.groups[0], fields: [{ key: 'bad', type: 'choice', presentation: 'select', options: [{ value: 'a' }], optionTarget: 'theme.bad' }] }] }],
  ] as const)('拒绝 %s', (_label, schema) => {
    expect(() => validateRendererSettingsSchema(schema)).toThrow()
  })
})
