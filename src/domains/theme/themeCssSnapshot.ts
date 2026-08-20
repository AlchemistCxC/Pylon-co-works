/**
 * themeCssSnapshot — 主题 → CSS 变量快照纯 selector（FE-AUD-013 / 报告 9B.1）。
 *
 * 由 defs 驱动普通字段（THEME_CSS_VAR_MAP 循环），仅保留背景转换/字体选择/
 * 布局宽度等显式派生。App 主布局与独立 ThemeRuntimeBridge 共用同一快照源。
 */
import { THEME_CSS_VAR_MAP, THEME_FIELD_DEFS } from '../../themeFieldDefs.ts'
import { toCssBackgroundImage } from '../../backgroundImage.ts'
import { fontContributionCssVariable } from '../../plugin-runtime/fonts/fontContributionRegistry.ts'

/** I09-A-FE-01（D-08 冻结）：统一折叠宽度 token——titlebar cell / workspace sidebar / Browser/File 内栏共用，组件不得各自硬编码 */
export const WORKSPACE_SIDEBAR_COLLAPSED_WIDTH = 42

export interface ThemeCssLayout {
  sidebarCollapsed: boolean
  sidebarWidth: number
  /** active Sheet 是否有任一种可折叠左栏。 */
  sidebarEnabled: boolean
  /** 是否存在 workspace 公共左栏稳定轨道；折叠时仍保持该轨道宽度。 */
  sidebarExpandedTrack?: boolean
}

function fontToken(value: unknown): string {
  if (value === 'mono') return 'var(--font-mono-default, var(--mono))'
  if (value === 'serif') return 'var(--font-serif-default, var(--serif))'
  if (value === 'system' || value === 'sans' || typeof value !== 'string' || !value.trim()) return 'var(--font-system, var(--font))'
  return `var(${fontContributionCssVariable(value)}, var(--font-system, var(--font)))`
}

export function selectThemeCssSnapshot(
  s: Readonly<Record<string, unknown>>,
  layout: ThemeCssLayout,
): Record<string, string> {
  const { sidebarWidth, sidebarEnabled, sidebarExpandedTrack = sidebarEnabled } = layout
  const globalFontToken = fontToken(s.globalFont)
  const vars: Record<string, string> = {
    '--global-bg-image': toCssBackgroundImage(s.globalBgImage as string | undefined),
    '--sidebar-bg-image': toCssBackgroundImage(s.sidebarBgImage as string | undefined),
    '--chat-bg-image': toCssBackgroundImage(s.chatBgImage as string | undefined),
    '--right-bg-image': toCssBackgroundImage(s.rightBgImage as string | undefined),
    '--input-bg-image': toCssBackgroundImage(s.inputBgImage as string | undefined),
    '--status-bg-image': toCssBackgroundImage(s.statusBgImage as string | undefined),
    // --global-font 覆盖继承入口；--font 覆盖仍显式引用旧 UI token 的第一方 Surface。
    // 代码、路径与终端继续使用独立的 --mono，不受这里影响。
    '--global-font': globalFontToken,
    '--font': globalFontToken,
    '--mono': fontToken(s.codeFont ?? 'mono'),
    '--chat-font': fontToken(s.chatFont),
    '--msg-font': fontToken(s.msgFont),
    '--msg-text': (s.msgTextColor as string) || 'var(--chat-text-color,var(--text))',
    // 所有 Sheet 左栏统一：展开使用用户宽度，折叠使用 42px 控制轨道。
    '--workspace-sidebar-collapsed-width': `${WORKSPACE_SIDEBAR_COLLAPSED_WIDTH}px`,
    '--workspace-sidebar-track-width': `${sidebarEnabled && !layout.sidebarCollapsed ? sidebarWidth : WORKSPACE_SIDEBAR_COLLAPSED_WIDTH}px`,
    '--titlebar-sidebar-width': `${sidebarExpandedTrack && !layout.sidebarCollapsed ? sidebarWidth : WORKSPACE_SIDEBAR_COLLAPSED_WIDTH}px`,
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
