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

  // S1 presentation 可选化校验（自 rendererSettingsPresentation.test.ts 并入）
  it('拒绝声明了非法 presentation 的字段（条件校验语义不变）', () => {
    const schema = {
      schemaVersion: 1,
      groups: [{ id: 'g', label: '组', fields: [
        { key: 'style', label: '风格', type: 'choice', presentation: 'magic', options: [{ value: 'a' }] },
      ] }],
    }
    expect(() => validateRendererSettingsSchema(schema as never)).toThrow(/presentation 非法|choice presentation 非法/)
  })

  it('接受未声明 presentation 的字段（未声明合法，运行时由默认补齐）', () => {
    const schema = {
      schemaVersion: 1,
      groups: [{ id: 'g', label: '组', fields: [
        { key: 'scale', label: '缩放', type: 'number', min: 0, max: 10, default: 1 },
      ] }],
    }
    expect(() => validateRendererSettingsSchema(schema as never)).not.toThrow()
  })
})
