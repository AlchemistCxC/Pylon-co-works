// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { alignThemeStructure } from '../migration.ts'
import { DEFAULTS } from '../themeDefaults.ts'
import { PRESET_ZONES } from '../presetReducer.ts'

/**
 * #266 遗留① · 三组控件的底色/文字色改「自由选色」后的**老数据等价**与**幂等**。
 *
 * 改造把 6 个字段由 `select`（`white`/`black`，`permissionTextColor` 另有 `'mode'` 档）改成
 * `color`，并在**每次读盘**的归一化路径（`alignThemeStructure`）里把老枚举字面量搬成等价颜色。
 * 这里钉住三件事：
 * 1. **等价**：老数据经读盘归一化后，**画出来的颜色**与改造前逐项相同（不是字面量相同 ——
 *    `#fff` 与 `#ffffff` 是同一个色）；
 * 2. **幂等**：归一化再跑一遍不变（颜色值不是枚举字面量，第二次不会被再翻译一次）；
 * 3. **不越界**：`sendButtonBorderColor` / `sendButtonIconColor` 是**同名枚举但仍是枚举**，
 *    不许被这条映射顺手改掉；用户已经设过的任意颜色与空串原样穿过。
 */

const defaults = {
  base: DEFAULTS,
  appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, ''])),
  custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  ccLayout: DEFAULTS.ccLayout,
}

/** 老浏览器里存的真实形状：这 6 个键还是枚举字面量（其中权限文字色是 `'mode'` 档）。 */
const LEGACY_ENUM_VALUES = {
  modelBgColor: 'white',
  modelTextColor: 'black',
  reasoningBgColor: 'white',
  reasoningTextColor: 'black',
  permissionBgColor: 'white',
  permissionTextColor: 'mode',
} as const

type CcColorKey = keyof typeof LEGACY_ENUM_VALUES

/**
 * 改造前消费端的取值 —— ★ 原样照抄旧实现（`WorkbenchWidgets.solid.tsx` 的 `bg()`/`fg()`/
 * `color()` 与 `ControlCenter.solid.tsx` 用量胶囊那两行）。旧实现已在本刀删除，这份副本是
 * 用来证明「老数据画出来的颜色不变」的对照臂。
 */
const legacyShownBg = (enumValue: string): string => (enumValue === 'black' ? '#000' : '#fff')
const legacyShownFg = (enumValue: string): string => (enumValue === 'white' ? '#fff' : '#000')
const legacyShownPermissionText = (enumValue: string | undefined): string | undefined => {
  const value = enumValue ?? 'mode'
  return value === 'mode' ? undefined : value === 'white' ? '#fff' : '#000'
}

/** 改造后消费端的取值（直读字段；权限文字色留空 ⇒ 不写 inline color）。 */
const newShown = (value: string): string => value
const newShownPermissionText = (value: string): string | undefined => value || undefined

/**
 * 让**浏览器自己**把颜色规范化后再比 —— 比的是「画出来的色」，不是「字符串写得一样」。
 * 非法值会被 CSS 丢掉（返回空串），与真实渲染行为一致（权限文字色留空走的就是这条路）。
 */
function asCssColor(property: 'background' | 'color', value: string | undefined): string {
  const probe = document.createElement('div')
  if (value !== undefined) probe.style[property] = value
  return probe.style[property]
}

/** 这三个是底色（写 `background`），另三个是文字色（写 `color`）。 */
const BG_KEYS: readonly string[] = ['modelBgColor', 'reasoningBgColor', 'permissionBgColor']
const cssPropertyOf = (key: CcColorKey): 'background' | 'color' => BG_KEYS.includes(key) ? 'background' : 'color'

/** 改造前画出来的颜色（权限文字色的 `'mode'` 档 = 不写 inline color）。 */
function oldRendered(key: CcColorKey): string {
  if (key === 'permissionTextColor') return asCssColor('color', legacyShownPermissionText(LEGACY_ENUM_VALUES[key]))
  const enumValue = LEGACY_ENUM_VALUES[key]
  return asCssColor(cssPropertyOf(key), BG_KEYS.includes(key) ? legacyShownBg(enumValue) : legacyShownFg(enumValue))
}

/** 改造后画出来的颜色（直读字段值）。 */
function newRendered(key: CcColorKey, value: string): string {
  return asCssColor(cssPropertyOf(key), key === 'permissionTextColor' ? newShownPermissionText(value) : newShown(value))
}

const align = (persisted: Record<string, unknown>) =>
  alignThemeStructure({ ...DEFAULTS, ...persisted }, defaults) as unknown as Record<string, string>

describe('#266 遗留① · 老枚举 ⇒ 等价颜色（读盘归一化）', () => {
  it('6 个字段的枚举字面量被搬成等价颜色', () => {
    const aligned = align({ ...LEGACY_ENUM_VALUES })
    expect({
      modelBgColor: aligned.modelBgColor,
      modelTextColor: aligned.modelTextColor,
      reasoningBgColor: aligned.reasoningBgColor,
      reasoningTextColor: aligned.reasoningTextColor,
      permissionBgColor: aligned.permissionBgColor,
      permissionTextColor: aligned.permissionTextColor,
    }).toEqual({
      modelBgColor: '#ffffff',
      modelTextColor: '#000000',
      reasoningBgColor: '#ffffff',
      reasoningTextColor: '#000000',
      permissionBgColor: '#ffffff',
      permissionTextColor: '',
    })
  })

  it('★ 等价性：归一化后画出来的颜色与改造前逐项相同', () => {
    const aligned = align({ ...LEGACY_ENUM_VALUES })
    for (const key of Object.keys(LEGACY_ENUM_VALUES) as CcColorKey[]) {
      expect(
        { [key]: newRendered(key, aligned[key]) },
        `${key}：老枚举 ${LEGACY_ENUM_VALUES[key]} 画出来应是同一个色`,
      ).toEqual({ [key]: oldRendered(key) })
    }
  })

  it('老数据缺这些键 ⇒ 补新默认值，画出来的颜色仍与改造前相同', () => {
    // 出厂预设里本来就没有这 6 个键（落的是字段默认值）⇒ 默认值本身也是等价颜色。
    const aligned = align({})
    expect(aligned.modelBgColor).toBe('#ffffff')
    expect(aligned.modelTextColor).toBe('#000000')
    expect(aligned.permissionTextColor).toBe('')
    for (const key of Object.keys(LEGACY_ENUM_VALUES) as CcColorKey[]) {
      expect({ [key]: newRendered(key, aligned[key]) }, `${key} 的默认值应等价`).toEqual({ [key]: oldRendered(key) })
    }
  })

  it('幂等：归一化连跑两次结果相同', () => {
    const once = align({ ...LEGACY_ENUM_VALUES })
    const twice = align({ ...once })
    for (const key of Object.keys(LEGACY_ENUM_VALUES) as CcColorKey[]) {
      expect(twice[key], `${key} 第二次应原样`).toBe(once[key])
    }
  })

  it('不越界：仍是枚举的字段不被顺手改掉，用户已设的任意颜色原样穿过', () => {
    const aligned = align({
      ...LEGACY_ENUM_VALUES,
      sendButtonBorderColor: 'black',
      sendButtonIconColor: 'white',
      modelBgColor: '#ff0000',
      modelTextColor: 'rgba(1,2,3,.4)',
      permissionTextColor: '#00ff00',
    })
    expect(aligned.sendButtonBorderColor).toBe('black')
    expect(aligned.sendButtonIconColor).toBe('white')
    expect(aligned.modelBgColor).toBe('#ff0000')
    expect(aligned.modelTextColor).toBe('rgba(1,2,3,.4)')
    expect(aligned.permissionTextColor).toBe('#00ff00')
  })
})
