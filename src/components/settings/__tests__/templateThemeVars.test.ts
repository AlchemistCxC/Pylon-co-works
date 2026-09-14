// 迁移自 scripts/test-template-library.mts（P91 A1）；组件接线段（TemplateLibrary.tsx / Settings.tsx 源码 token 断言）不迁——已被 TemplateLibrary.globalPresets.test.tsx 行为级 UI 测试锁定。
import { describe, expect, it } from 'vitest'
import { themeToCssVars } from '../templateThemeVars.ts'
import { THEME_CSS_VAR_MAP, THEME_DEFAULTS } from '../../../themeFieldDefs.ts'
import { GLOBAL_PRESETS } from '../../../presets.ts'

// W2-14：模板库——预览局部 cssVars 不触全局 store；点击才应用；恢复重应用 delta

describe('templateThemeVars themeToCssVars（迁移自 scripts/test-template-library.mts，P91 A1）', () => {
  it('对 delta 展开 { ...THEME_DEFAULTS, ...delta } 派生局部 cssVars（单一真值）', () => {
    const expanded = { ...THEME_DEFAULTS, ...GLOBAL_PRESETS[0].theme }
    const vars = themeToCssVars(expanded)
    for (const [cssVar, key] of Object.entries(THEME_CSS_VAR_MAP)) {
      const value = (expanded as Record<string, unknown>)[key]
      if (value !== undefined) expect(vars[cssVar]).toBe(String(value)) // `${cssVar} 必须从快照派生`
    }
    expect(vars['--accent']).toBe(String(expanded.accent)) // accent 必须注入
    expect(Object.prototype.hasOwnProperty.call(themeToCssVars({}), '--accent')).toBe(false) // 缺省字段不注入
  })

  it('官方区模板展开后 theme 完整（delta 展开到全量）', () => {
    const official = GLOBAL_PRESETS.map(preset => ({ ...THEME_DEFAULTS, ...preset.theme }))
    expect(official.length).toBe(10)
    for (const theme of official) {
      expect(theme.accent !== undefined).toBe(true) // 展开后 accent 必有值
      expect(theme.ccHeight !== undefined).toBe(true)
    }
  })
})
