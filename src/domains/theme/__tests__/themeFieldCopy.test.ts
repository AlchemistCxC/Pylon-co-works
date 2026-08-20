import { describe, expect, it } from 'vitest'
import { WIDGET_PROPERTY_FIELDS } from '../../cc/widgetDefinitions.ts'
import { GROUP_ORDER, THEME_FIELD_DEFS, type ThemeFieldDef } from '../../../themeFieldDefs.ts'

const IMPLEMENTATION_TERMS = /AgentSheet|FileSheet|Spinner|Placeholder|Footer|Diff|\bCLI\b|\bCC\b|\s&\s/

describe('主题设置展示文案契约', () => {
  it('用户可见字段不泄露组件名或内部缩写', () => {
    for (const [key, field] of Object.entries(THEME_FIELD_DEFS)) {
      const def = field as ThemeFieldDef
      if (def.hidden) continue
      expect(def.label, `${key}.label`).not.toMatch(IMPLEMENTATION_TERMS)
      if (def.hint) expect(def.hint, `${key}.hint`).not.toMatch(IMPLEMENTATION_TERMS)
      if (def.group) expect(def.group, `${key}.group`).not.toMatch(IMPLEMENTATION_TERMS)
    }
  })

  it('每个可见字段组都在对应设置区注册', () => {
    const registered = new Map(
      Object.entries(GROUP_ORDER).map(([zone, sections]) => [
        zone,
        new Set(sections.flatMap(section => section.groups.map(group => group.title))),
      ]),
    )

    for (const [key, field] of Object.entries(THEME_FIELD_DEFS)) {
      const def = field as ThemeFieldDef
      if (def.hidden || !def.group) continue
      expect(registered.get(def.zone)?.has(def.group), `${key} 的字段组“${def.group}”未注册`).toBe(true)
    }
  })

  it('关键枚举保留稳定值，并为每个值提供人类可读名称', () => {
    const expectedOptions = {
      ccStyle: ['wave', 'bar', 'ring', 'numeric'],
      inputMode: ['cli', 'default'],
      inputShowPlaceholder: ['shown', 'hidden'],
      inputShowHistoryHint: ['shown', 'hidden'],
      inputSubmitButtonMode: ['inline', 'external', 'hidden'],
      cliHintMode: ['hidden', 'compact', 'full'],
      footerLayout: ['free', 'peri'],
      cliOverflowMode: ['fixed-scroll', 'grow', 'overlay'],
      modelVariant: ['dropdown', 'minimal', 'badge'],
      modeVariant: ['pill', 'badge', 'minimal'],
      sendVariant: ['icon', 'square', 'minimal'],
      attachVariant: ['icon', 'square', 'minimal'],
    } as const

    for (const [key, options] of Object.entries(expectedOptions)) {
      const def = THEME_FIELD_DEFS[key as keyof typeof expectedOptions] as ThemeFieldDef
      expect(def.options, `${key}.options`).toEqual(options)
      for (const value of options) expect(def.optionLabels?.[value], `${key}.${value} 缺展示名称`).toBeTruthy()
    }
  })

  it('诊断中点名的模糊字段表达真实作用域', () => {
    expect(THEME_FIELD_DEFS.assistantDot.label).toBe('显示助手消息标记')
    expect(THEME_FIELD_DEFS.ccStyle.label).toBe('用量显示方式')
    expect(THEME_FIELD_DEFS.barTrackColor.label).toBe('用量条轨道')
    expect(THEME_FIELD_DEFS.footerLayout.label).toBe('底部信息布局')
  })

  it('中控属性面板与设置页使用同一套用户语言', () => {
    const visibleCopy = Object.values(WIDGET_PROPERTY_FIELDS).flatMap(fields => fields.flatMap(field => {
      if (field.kind === 'section') return [field.title]
      if (field.kind === 'chips') return [field.label, ...field.options.map(option => option.label)]
      if (field.kind === 'chipsBool') return [field.label, field.trueLabel, field.falseLabel]
      return [field.label]
    }))

    for (const copy of visibleCopy) expect(copy).not.toMatch(IMPLEMENTATION_TERMS)
  })
})
