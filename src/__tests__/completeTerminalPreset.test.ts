import { describe, expect, it } from 'vitest'
import { cloneCcLayout, DEFAULT_CC_LAYOUT } from '../ccLayoutState.ts'
import { completeTerminalPreset, type GlobalPreset } from '../presets.ts'
import { THEME_DEFAULTS } from '../themeFieldDefs.ts'

/** TerminalPresetName 之外的预设：claude/nord/tokyo/solarized/amber/matrix 六个才登记视觉补全。 */
const UNREGISTERED_PRESET_NAMES = ['glass', 'agent-command', 'agent-map', 'focus-flow'] as const

describe('completeTerminalPreset', () => {
  it('未登记视觉补全的预设原样返回（同一引用、主题不被改写）', () => {
    for (const name of UNREGISTERED_PRESET_NAMES) {
      const preset: GlobalPreset = { name, label: name, theme: { accent: '#123456' } }

      expect(completeTerminalPreset(preset)).toBe(preset)
      expect(preset.theme).toEqual({ accent: '#123456' })
    }
  })

  it('合并顺序 = TERMINAL_COMPLETION → preset.theme → TERMINAL_VISUAL_COMPLETION[name]', () => {
    const completed = completeTerminalPreset({
      name: 'claude',
      label: 'Claude',
      theme: { accent: '#123456', uiScheme: 'light' },
    }).theme

    // 第一层供货：预设与视觉补全都没提的字段取补全底的默认值
    expect(completed.ccMarginX).toBe(THEME_DEFAULTS.ccMarginX)
    expect(completed.ccBg).toBe(THEME_DEFAULTS.ccBg)
    // 第二层压过第一层：预设自带的值胜出
    expect(completed.accent).toBe('#123456')
    // 第三层压过第二层：同名视觉补全胜出（claude 的 uiScheme 固定为 dark）
    expect(completed.uiScheme).toBe('dark')
  })

  it('ccLayout 是深拷贝：改返回值不影响原预设', () => {
    const preset: GlobalPreset = {
      name: 'claude',
      label: 'Claude',
      theme: { ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT) },
    }
    const before = structuredClone(preset.theme.ccLayout)

    const completed = completeTerminalPreset(preset).theme.ccLayout
    if (!completed) throw new Error('completeTerminalPreset 未产出 ccLayout')

    expect(completed).not.toBe(preset.theme.ccLayout)
    expect(completed).toEqual(preset.theme.ccLayout)

    completed.placements.input.offsetX = 99
    completed.placements.input.slot = 'actions'

    expect(preset.theme.ccLayout).toEqual(before)
  })
})
