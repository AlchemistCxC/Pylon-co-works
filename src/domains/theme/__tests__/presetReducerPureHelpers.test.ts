import { describe, expect, it } from 'vitest'
import { THEME_DEFAULTS, THEME_PRESET_KEYS, THEME_SETTING_KEYS } from '../../../themeFieldDefs.ts'
import { clampPresetCcHeight, filterPresetTheme, syncPresetCcHeight, toThemeDelta } from '../presetReducer.ts'

const PRESET_KEY_SET = new Set<string>(THEME_PRESET_KEYS)
const NON_PRESET_KEY = THEME_SETTING_KEYS.find(key => !PRESET_KEY_SET.has(key))

describe('filterPresetTheme', () => {
  it('只留 THEME_PRESET_KEYS 里的键', () => {
    const input = {
      accent: '#123456',
      ccBg: '#000000',
      notAThemeKey: 'dropped',
      ...(NON_PRESET_KEY ? { [NON_PRESET_KEY]: 'dropped' } : {}),
    }

    expect(Object.keys(filterPresetTheme(input)).sort()).toEqual(
      Object.keys(input).filter(key => PRESET_KEY_SET.has(key)).sort(),
    )
  })

  it('主题键全部在输入里时一个都不少', () => {
    const input = Object.fromEntries(THEME_PRESET_KEYS.map(key => [key, 'sentinel']))

    expect(Object.keys(filterPresetTheme(input)).sort()).toEqual([...THEME_PRESET_KEYS].sort())
  })

  it('字段表之外的键、非主题权威的键都被丢掉', () => {
    if (!NON_PRESET_KEY) throw new Error('前置失败：THEME_SETTING_KEYS 应含非主题权威键')

    expect(filterPresetTheme({ notAThemeKey: 'dropped', [NON_PRESET_KEY]: 'dropped' })).toEqual({})
  })
})

describe('toThemeDelta', () => {
  it('语义不变：与默认值相等的键被过滤，其余原样保留', () => {
    expect(toThemeDelta({ accent: THEME_DEFAULTS.accent })).toEqual({})
    expect(toThemeDelta({ accent: '#123456' })).toEqual({ accent: '#123456' })
    expect(toThemeDelta({ accent: THEME_DEFAULTS.accent, ccBg: '#000000' })).toEqual({ ccBg: '#000000' })
    // 不在默认值表里的键不参与过滤，原样保留
    expect(toThemeDelta({ notAThemeKey: 'kept' })).toEqual({ notAThemeKey: 'kept' })
  })
})

describe('clampPresetCcHeight / syncPresetCcHeight', () => {
  /**
   * ★ #266 刀9~11：`inputMode` / `footerLayout` / `cliOverflowMode` 三个字段删除后，
   * 形态只剩一种 ⇒ `clampPresetCcHeight` 收敛为「常量最小高 64 + 上界 400」——
   * 原先那套「可见控件数 ⇒ 状态行换行 ⇒ 最小高 84/109」的联动随 peri 形态一并退场。
   */
  it('下界 = 常量 64（不再随可见状态控件数 / 形态浮动）', () => {
    expect(clampPresetCcHeight({ ccHeight: 0 })).toBe(64)
    expect(clampPresetCcHeight({ ccHeight: 12 })).toBe(64)
    expect(clampPresetCcHeight({ ccHeight: 64 })).toBe(64)
  })

  it('上界固定 400，区间内原样返回', () => {
    expect(clampPresetCcHeight({ ccHeight: 999 })).toBe(400)
    expect(clampPresetCcHeight({ ccHeight: 200 })).toBe(200)
  })

  it('ccHeight 缺省时回落到默认值；非有限值回落到最小高（既有语义，未变）', () => {
    // 缺省（`typeof !== 'number'`）⇒ 取 DEFAULTS.ccHeight 再 clamp
    expect(clampPresetCcHeight({})).toBe(THEME_DEFAULTS.ccHeight)
    // NaN 是 number 类型 ⇒ 进 clamp，被 `Number.isFinite` 判掉后取**最小高**（常量 64）。
    // ★ 这是改造前就有的语义（原实现同样回落 min），本次形状收敛后结果从 109 变 64。
    expect(clampPresetCcHeight({ ccHeight: Number.NaN })).toBe(64)
  })

  it('syncPresetCcHeight 只回 ccHeight，且与 clampPresetCcHeight 同值', () => {
    const theme = { ccHeight: 999 }

    expect(syncPresetCcHeight(theme)).toEqual({ ccHeight: 400 })
    expect(syncPresetCcHeight(theme).ccHeight).toBe(clampPresetCcHeight(theme))
  })
})
