/**
 * templateThemeVars — 模板预览局部 cssVars 派生（W2-14，F3-C 方案 A）。
 *
 * 对 { ...THEME_DEFAULTS, ...delta } 的内存态快照经 THEME_CSS_VAR_MAP 单一真值派生
 * 局部 CSS vars——注入预览容器局部 style，不触全局 store（hover 不写 store）。
 */
import { THEME_CSS_VAR_MAP } from '../../themeFieldDefs.ts'
import type { ThemeSettings } from '../../store'

export function themeToCssVars(theme: Partial<ThemeSettings>): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [cssVar, key] of Object.entries(THEME_CSS_VAR_MAP)) {
    const value = (theme as Record<string, unknown>)[key]
    if (value === undefined) continue
    vars[cssVar] = String(value)
  }
  return vars
}
