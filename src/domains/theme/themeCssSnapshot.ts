/**
 * themeCssSnapshot — 主题 → CSS 变量快照纯 selector（FE-AUD-013 / 报告 9B.1）。
 *
 * 由 defs 驱动普通字段（THEME_CSS_VAR_MAP 循环），仅保留背景转换/字体选择/
 * 布局宽度等显式派生。App 主布局与独立 ThemeRuntimeBridge 共用同一快照源。
 */
import { THEME_CSS_VAR_MAP, THEME_FIELD_DEFS } from '../../themeFieldDefs'
import { toCssBackgroundImage } from '../../backgroundImage'

export interface ThemeCssLayout {
  sidebarCollapsed: boolean
  sidebarWidth: number
}

export function selectThemeCssSnapshot(
  s: Readonly<Record<string, unknown>>,
  layout: ThemeCssLayout,
): Record<string, string> {
  const { sidebarCollapsed, sidebarWidth } = layout
  const vars: Record<string, string> = {
    '--global-bg-image': toCssBackgroundImage(s.globalBgImage as string | undefined),
    '--sidebar-bg-image': toCssBackgroundImage(s.sidebarBgImage as string | undefined),
    '--chat-bg-image': toCssBackgroundImage(s.chatBgImage as string | undefined),
    '--input-bg-image': toCssBackgroundImage(s.inputBgImage as string | undefined),
    '--status-bg-image': toCssBackgroundImage(s.statusBgImage as string | undefined),
    '--global-font': s.globalFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--chat-font': s.chatFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--msg-font': s.msgFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--msg-text': (s.msgTextColor as string) || 'var(--chat-text-color,var(--text))',
    '--titlebar-sidebar-width': `${sidebarCollapsed ? 42 : sidebarWidth}px`,
    '--sheet-sidebar-width': `${sidebarWidth}px`,
  }
  for (const [cssVar, key] of Object.entries(THEME_CSS_VAR_MAP)) {
    if (cssVar in vars) continue
    const def = THEME_FIELD_DEFS[key]
    const value = s[key]
    if (value === undefined || (def.type === 'color' && value === '')) continue
    vars[cssVar] = def.type === 'number' && def.unit ? `${value}${def.unit}` : String(value)
  }
  return vars
}
