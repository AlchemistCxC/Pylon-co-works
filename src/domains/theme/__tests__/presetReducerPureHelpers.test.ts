import { describe, expect, it } from 'vitest'
import { resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../../cc/ccHeightState.ts'
import { resolveCcHiddenWidgetIds } from '../../cc/widgetDefinitions.ts'
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
  // 只有 cli + peri 才会走「状态行参与最小高」的分支
  const cliPeri = {
    inputMode: 'cli',
    footerLayout: 'peri',
    cliHintMode: 'full',
    cliOverflowMode: 'fixed-scroll',
  } as const
  const manyVisible = { ...cliPeri, ccHidden: [] as string[] }
  const fewVisible = {
    ...cliPeri,
    ccHidden: ['model', 'reasoning'],
  }

  const visibleCount = (hidden: string[]) =>
    resolveVisibleStatusWidgetCount({
      // ★ #266 ⑰：隐藏名单的组装只有一处（预设的值 + 详细档折叠）—— 调用点照渲染侧那样组装。
      hiddenIds: resolveCcHiddenWidgetIds({ ccHidden: hidden, cliHintMode: cliPeri.cliHintMode }),
    })
  const minHeight = (visible: number) =>
    resolveCcMinHeight({
      inputMode: 'cli',
      footerLayout: 'peri',
      hintMode: 'full',
      visibleStatusWidgets: visible,
      cliOverflowMode: 'fixed-scroll',
    })

  it('下界跟着「可见状态控件数」联动（⑰ 后名单上限 5，满员会触发状态行换行）', () => {
    // ★ #266 ⑰：可见数由 4 变 5（命令行提示不再被"有没有会话 / 是不是命令行模式"挡掉）
    //   ⇒ `wrappedStatusRows`（>4 才多让一行）**从此会生效**，这正是空态数值不受影响的另一面：
    //   空态那一侧由语境侧名单挡住提示，计数仍是 0。
    expect(visibleCount(manyVisible.ccHidden)).toBe(5)
    expect(visibleCount(fewVisible.ccHidden)).toBe(3)

    expect(clampPresetCcHeight({ ...manyVisible, ccHeight: 0 })).toBe(minHeight(visibleCount(manyVisible.ccHidden)))
    expect(clampPresetCcHeight({ ...fewVisible, ccHeight: 0 })).toBe(minHeight(visibleCount(fewVisible.ccHidden)))
    // 现在两者的最小高**不同**（满员 5 ⇒ 换行 + 提示行）
    expect(minHeight(visibleCount(manyVisible.ccHidden))).toBe(109)
    expect(minHeight(visibleCount(fewVisible.ccHidden))).toBe(84)
  })

  it('上界固定 400，区间内原样返回', () => {
    expect(clampPresetCcHeight({ ...manyVisible, ccHeight: 999 })).toBe(400)
    expect(clampPresetCcHeight({ ...fewVisible, ccHeight: 200 })).toBe(200)
  })

  it('ccHeight 非数字时回落到默认值', () => {
    expect(clampPresetCcHeight({ inputMode: 'cli', footerLayout: 'free' })).toBe(THEME_DEFAULTS.ccHeight)
  })

  it('syncPresetCcHeight 只回 ccHeight，且与 clampPresetCcHeight 同值', () => {
    const theme = { ...manyVisible, ccHeight: 999 }

    expect(syncPresetCcHeight(theme)).toEqual({ ccHeight: 400 })
    expect(syncPresetCcHeight(theme).ccHeight).toBe(clampPresetCcHeight(theme))
  })
})
