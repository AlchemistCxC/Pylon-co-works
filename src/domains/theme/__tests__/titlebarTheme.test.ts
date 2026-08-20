import { describe, expect, it } from 'vitest'
import { GLOBAL_PRESETS } from '../../../presets.ts'
import { GROUP_ORDER, THEME_FIELD_DEFS } from '../../../themeFieldDefs.ts'
import { DEFAULTS } from '../themeDefaults.ts'
import { selectThemeCssSnapshot } from '../themeCssSnapshot.ts'

const LAYOUT = { sidebarCollapsed: false, sidebarWidth: 250, sidebarEnabled: true }

describe('TitleBar 主题契约', () => {
  it('注册背景与文字字段，并在未定制时保留基础配色 fallback', () => {
    expect(THEME_FIELD_DEFS.titlebarBg).toMatchObject({ zone: 'global', group: '标题栏', cssVar: '--titlebar-bg' })
    expect(THEME_FIELD_DEFS.titlebarTextColor).toMatchObject({ zone: 'global', group: '标题栏', cssVar: '--titlebar-text' })
    expect(DEFAULTS.titlebarBg).toBe('')
    expect(DEFAULTS.titlebarTextColor).toBe('')
    expect(GROUP_ORDER.global.flatMap(section => section.groups.map(group => group.title))).toContain('标题栏')
  })

  it('把定制值投影为 TitleBar 消费的 CSS 变量，空值不遮蔽 fallback', () => {
    const themed = selectThemeCssSnapshot({ titlebarBg: '#102030', titlebarTextColor: '#f0f4f8' }, LAYOUT)
    expect(themed['--titlebar-bg']).toBe('#102030')
    expect(themed['--titlebar-text']).toBe('#f0f4f8')

    const fallback = selectThemeCssSnapshot({ ...DEFAULTS } as Record<string, unknown>, LAYOUT)
    expect(fallback['--titlebar-bg']).toBeUndefined()
    expect(fallback['--titlebar-text']).toBeUndefined()
  })

  it('六套全局预设都显式定义协调的 TitleBar 背景与文字颜色', () => {
    expect(GLOBAL_PRESETS).toHaveLength(6)
    for (const preset of GLOBAL_PRESETS) {
      expect(preset.theme.titlebarBg, `${preset.name}.titlebarBg`).toBeTruthy()
      expect(preset.theme.titlebarTextColor, `${preset.name}.titlebarTextColor`).toBeTruthy()
    }
  })
})
