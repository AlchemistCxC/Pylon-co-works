import { describe, expect, it } from 'vitest'
import {
  DISPLAY_DEFAULTS,
  resolvePresentation,
  validateRendererSettingsSchema,
  type RenderSettingField,
} from '../rendererSettingsTypes.ts'

/**
 * S1 显示解析基座（施工书 06 §S1）：
 * - presentation 从必填降为可选；未声明走 DISPLAY_DEFAULTS 类型默认
 * - resolvePresentation 单点解析（设计书 §3.6 扩展缝）
 */

describe('S1 resolvePresentation 两层解析', () => {
  it('number 字段未声明 presentation → 返回类型默认 slider+input', () => {
    const field = { key: 'fontSize', label: '字号', type: 'number', min: 10, max: 32 } as unknown as RenderSettingField
    expect(resolvePresentation(field)).toBe('slider+input')
  })

  it('显式声明优先于类型默认（segmented 不被默认覆盖）', () => {
    const field = { key: 'view', label: '视图', type: 'choice', presentation: 'segmented', options: [{ value: 'a' }] } as unknown as RenderSettingField
    expect(resolvePresentation(field)).toBe('segmented')
  })

  it('六种类型的默认映射齐全', () => {
    expect(DISPLAY_DEFAULTS.choice).toBe('select')
    expect(DISPLAY_DEFAULTS['multi-choice']).toBe('checklist')
    expect(DISPLAY_DEFAULTS.color).toBe('palette+picker')
    expect(DISPLAY_DEFAULTS.number).toBe('slider+input')
    expect(DISPLAY_DEFAULTS.boolean).toBe('toggle')
    expect(DISPLAY_DEFAULTS.text).toBe('input')
  })
})

describe('S1 presentation 可选化校验', () => {
  it('validate 接受未声明 presentation 的字段（未声明合法，运行时由默认补齐）', () => {
    const schema = {
      schemaVersion: 1,
      groups: [{ id: 'g', label: '组', fields: [
        { key: 'scale', label: '缩放', type: 'number', min: 0, max: 10, default: 1 },
      ] }],
    }
    expect(() => validateRendererSettingsSchema(schema as never)).not.toThrow()
  })

  it('声明了非法 presentation 仍然报错（条件校验语义不变）', () => {
    const schema = {
      schemaVersion: 1,
      groups: [{ id: 'g', label: '组', fields: [
        { key: 'style', label: '风格', type: 'choice', presentation: 'magic', options: [{ value: 'a' }] },
      ] }],
    }
    expect(() => validateRendererSettingsSchema(schema as never)).toThrow(/presentation 非法|choice presentation 非法/)
  })
})
