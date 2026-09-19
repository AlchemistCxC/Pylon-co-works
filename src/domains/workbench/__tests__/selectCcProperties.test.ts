import { describe, expect, it } from 'vitest'
import type { ThemeSettings } from '../../../store.ts'
import { DEFAULTS } from '../../theme/themeDefaults.ts'
import { selectCcProperties } from '../appearance.ts'

/**
 * 中控可编辑属性键集合（CC_EDITABLE_PROPERTY_KEYS）—— 逐个列出，本用例钉住「不多不少」。
 * 真值是 widgetDefinitions.ts 的 CcEditablePropertyKey 联合类型（类型层，无运行时列表）。
 */
const CC_EDITABLE_KEYS = [
  'cliLineColor',
  'cliLinePadding',
  'cliLineWidth',
  'inputBg',
  'inputFontSize',
  'inputHeight',
  'inputLineHeight',
  'inputMinHeight',
  'inputMode',
  'inputOffsetTop',
  'inputTextColor',
  'inputVariant',
  'modelBgColor',
  'modelFontSize',
  'modelHeight',
  'modelRadius',
  'modelSwitchMode',
  'modelTextColor',
  'modelWidth',
  'permissionBgColor',
  'permissionFontSize',
  'permissionHeight',
  'permissionRadius',
  'permissionSwitchMode',
  'permissionTextColor',
  'permissionWidth',
  'reasoningBgColor',
  'reasoningFontSize',
  'reasoningHeight',
  'reasoningRadius',
  'reasoningSwitchMode',
  'reasoningTextColor',
  'reasoningWidth',
  'sendVariant',
]

function theme(overrides: Partial<ThemeSettings> = {}): ThemeSettings {
  return { ...structuredClone(DEFAULTS), ...structuredClone(overrides) }
}

const sortedKeys = (value: object) => Object.keys(value).sort()
const expectedKeys = () => [...CC_EDITABLE_KEYS].sort()

describe('selectCcProperties', () => {
  it('只挑中控可编辑键，不多不少', () => {
    expect(sortedKeys(selectCcProperties(theme()))).toEqual(expectedKeys())
  })

  it('取值逐一取自入参的同名字段', () => {
    const picked = selectCcProperties(theme({ inputBg: '#123456', inputLineHeight: '1.5', sendVariant: 'icon' }))

    expect(picked.inputBg).toBe('#123456')
    expect(picked.inputLineHeight).toBe('1.5')
    expect(picked.sendVariant).toBe('icon')
  })

  it('空输入：键集合不变，取值全为 undefined', () => {
    const picked = selectCcProperties({} as ThemeSettings)

    expect(sortedKeys(picked)).toEqual(expectedKeys())
    expect(Object.values(picked).every(value => value === undefined)).toBe(true)
  })

  it('缺字段输入：有的取到值，没有的是 undefined', () => {
    const picked = selectCcProperties({ inputBg: '#123456' } as ThemeSettings)

    expect(picked.inputBg).toBe('#123456')
    expect(picked.cliLineColor).toBeUndefined()
    expect(sortedKeys(picked)).toEqual(expectedKeys())
  })

  it('不修改入参：冻结的入参照常读，两次调用同结果', () => {
    const input = Object.freeze(theme({ inputBg: '#123456', inputLineHeight: '1.5' }))
    const before = structuredClone(input)

    const first = selectCcProperties(input)
    const second = selectCcProperties(input)

    expect(first).toEqual(second)
    expect(input).toEqual(before)
  })
})
