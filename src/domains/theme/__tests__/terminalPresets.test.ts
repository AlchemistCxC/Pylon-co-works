import { describe, expect, it } from 'vitest'
import { GLOBAL_PRESETS } from '../../../presets.ts'
import { THEME_SETTING_KEYS } from '../../../themeFieldDefs.ts'

const terminal = GLOBAL_PRESETS.filter(preset =>
  ['claude', 'nord', 'tokyo', 'solarized', 'amber'].includes(preset.name),
)

describe('Terminal-like preset snapshots', () => {
  it('覆盖所有主题字段，切换后不会继承旧预设的渲染器状态', () => {
    for (const preset of terminal) {
      for (const key of THEME_SETTING_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(preset.theme, key), `${preset.name}.${key}`).toBe(true)
      }
    }
  })

  it('保留 Claude / Solarized 的核心气质，同时让其他工作站显式启用终端契约', () => {
    const claude = GLOBAL_PRESETS.find(preset => preset.name === 'claude')!.theme
    const solarized = GLOBAL_PRESETS.find(preset => preset.name === 'solarized')!.theme
    expect(claude.globalBgColor).toBe('#000000')
    expect(claude.messageLayout).toBe('claude')
    expect(solarized.globalBgColor).toBe('#fdf6e3')
    expect(solarized.uiScheme).toBe('light')

    for (const name of ['nord', 'tokyo', 'amber'] as const) {
      const theme = GLOBAL_PRESETS.find(preset => preset.name === name)!.theme
      expect(theme.inputMode, name).toBe('cli')
      expect(theme.inputVariant, name).toBe('cli')
      expect(theme.msgStyle, name).toBe('terminal')
      expect(theme.toolConnectorMode, name).toBe('follow')
    }
  })
})
