/**
 * themeCssSnapshot — 主题 → CSS 变量快照纯 selector（FE-AUD-013 / 报告 9B.1）。
 *
 * 由 defs 驱动普通字段（THEME_CSS_VAR_MAP 循环），仅保留背景转换/字体选择/
 * 布局宽度等显式派生。App 主布局与独立 ThemeRuntimeBridge 共用同一快照源。
 */
import { THEME_CSS_VAR_MAP, THEME_FIELD_DEFS } from '../../themeFieldDefs.ts'
import { toCssBackgroundImage } from '../../backgroundImage.ts'
import { fontContributionCssVariable } from '../../plugin-runtime/fonts/fontContributionRegistry.ts'
import { VISUAL_SEMANTIC_ROLE_TOKENS, type VisualSemanticRole } from './visualSemantics.ts'

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

/**
 * Resolve a persisted font selection to a CSS token.
 *
 * `fallback` is deliberately role-aware: an unavailable code contribution
 * must remain monospaced after plugin deactivation, while interface/content
 * contributions may safely fall back to the system UI stack.
 */
export function resolveFontToken(value: unknown, fallback: 'system' | 'code' = 'system'): string {
  const fallbackToken = fallback === 'code'
    ? 'var(--font-mono-default, var(--mono))'
    : 'var(--font-system, var(--font))'
  if (value === 'mono') return 'var(--font-mono-default, var(--mono))'
  // `codeFont` only exposes mono plus plugin ids. Treat legacy/invalid
  // proportional selections as unavailable instead of allowing code to lose
  // its monospaced role after migration or a hand-edited persisted value.
  if (fallback === 'code' && (value === 'serif' || value === 'system' || value === 'sans')) return fallbackToken
  if (value === 'serif') return 'var(--font-serif-default, var(--serif))'
  if (typeof value !== 'string' || !value.trim()) return fallbackToken
  if (value === 'system' || value === 'sans') return 'var(--font-system, var(--font))'
  return `var(${fontContributionCssVariable(value)}, ${fallbackToken})`
}

/** Private CSS fallback variable; public role names remain in visualSemantics. */
function roleFallbackVar(role: VisualSemanticRole): string {
  return `var(--pylon-palette-${VISUAL_SEMANTIC_ROLE_TOKENS[role].slice(2)})`
}

function isExplicitRoleValue(
  value: unknown,
  definition: (typeof THEME_FIELD_DEFS)[keyof typeof THEME_FIELD_DEFS],
  scheme: 'dark' | 'light' | undefined,
  role: VisualSemanticRole,
): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  if (value.trim().toLowerCase() === 'transparent') return false
  // Theme defaults predate the mode/scheme palette. Once a scheme is present,
  // treat an unchanged generic default as absent so the role gets its
  // mode/scheme fallback. Calls without a scheme preserve legacy snapshots.
  if (scheme && 'default' in definition && definition.default !== undefined && value === definition.default) return false
  if (scheme && roleContrastFails(value, role, scheme)) return false
  return true
}

type Rgb = readonly [number, number, number]

function parseRgb(value: string): Rgb | undefined {
  const hex = value.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1]
  if (hex) {
    const expanded = hex.length === 3 ? hex.split('').map(part => part + part).join('') : hex
    return [Number.parseInt(expanded.slice(0, 2), 16), Number.parseInt(expanded.slice(2, 4), 16), Number.parseInt(expanded.slice(4, 6), 16)]
  }
  const rgb = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i)
  if (!rgb) return undefined
  const channels = rgb.slice(1, 4).map(Number)
  if (channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 255)) return undefined
  const alphaText = rgb[4]
  const alpha = alphaText ? (alphaText.endsWith('%') ? Number.parseFloat(alphaText) / 100 : Number.parseFloat(alphaText)) : 1
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return undefined
  // Alpha is composited against the conservative scheme probe below.
  return [channels[0] * alpha, channels[1] * alpha, channels[2] * alpha]
}

function relativeLuminance(rgb: Rgb): number {
  const linear = rgb.map(channel => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function roleContrastFails(value: string, role: VisualSemanticRole, scheme: 'dark' | 'light'): boolean {
  const alphaText = value.trim().match(/^rgba?\([^)]*[,\s/]([\d.]+%?)\s*\)$/i)?.[1]
  if (alphaText) {
    const alpha = alphaText.endsWith('%') ? Number.parseFloat(alphaText) / 100 : Number.parseFloat(alphaText)
    if (Number.isFinite(alpha) && alpha < 0.8) return true
  }
  const foreground = parseRgb(value)
  if (!foreground || role.startsWith('surface.')) return false
  // The actual mode canvas is supplied by the CSS fallback variables. For a
  // pure snapshot guard, probe against the scheme's conservative canvas
  // extreme; CSS `var(...)` values are intentionally left for runtime conformance.
  const background: Rgb = scheme === 'dark' ? [0, 0, 0] : [255, 255, 255]
  const minimum = role.startsWith('content.') ? 4.5 : 3
  const lightA = relativeLuminance(foreground)
  const lightB = relativeLuminance(background)
  const ratio = (Math.max(lightA, lightB) + 0.05) / (Math.min(lightA, lightB) + 0.05)
  return ratio < minimum
}

function resolveRoleValues(state: Readonly<Record<string, unknown>>): Record<VisualSemanticRole, string> {
  const scheme = state.uiScheme === 'dark' || state.uiScheme === 'light' ? state.uiScheme : undefined
  const roleValues = {} as Record<VisualSemanticRole, string>
  for (const role of Object.keys(VISUAL_SEMANTIC_ROLE_TOKENS) as VisualSemanticRole[]) {
    let value: string | undefined
    for (const [key, definition] of Object.entries(THEME_FIELD_DEFS)) {
      if (!('semanticRole' in definition) || definition.semanticRole !== role || !('semanticSource' in definition) || definition.semanticSource !== true) continue
      const candidate = state[key]
      if (isExplicitRoleValue(candidate, definition, scheme, role)) {
        value = candidate
        break
      }
    }
    roleValues[role] = value ?? roleFallbackVar(role)
  }
  return roleValues
}

export function selectThemeCssSnapshot(
  s: Readonly<Record<string, unknown>>,
  layout: ThemeCssLayout,
): Record<string, string> {
  const { sidebarWidth, sidebarEnabled, sidebarExpandedTrack = sidebarEnabled } = layout
  const globalFontToken = resolveFontToken(s.globalFont)
  const roleValues = resolveRoleValues(s)
  const scheme = s.uiScheme === 'dark' || s.uiScheme === 'light' ? s.uiScheme : undefined
  const hasScheme = scheme !== undefined
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
    '--mono': resolveFontToken(s.codeFont ?? 'mono', 'code'),
    '--chat-font': resolveFontToken(s.chatFont),
    '--msg-font': resolveFontToken(s.msgFont),
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

  // Public role projection is the single palette/ThemeSettings boundary. The
  // old variables below are compatibility aliases for existing first-party
  // CSS; they are only replaced when a scheme is available, preserving the
  // legacy helper contract for scheme-less callers/tests.
  for (const [role, cssVar] of Object.entries(VISUAL_SEMANTIC_ROLE_TOKENS) as [VisualSemanticRole, string][]) {
    const fallback = roleFallbackVar(role)
    if (hasScheme || roleValues[role] !== fallback) vars[cssVar] = roleValues[role]
  }
  if (hasScheme) {
    vars['--global-bg-color'] = roleValues['surface.canvas']
    vars['--text'] = roleValues['content.text']
    vars['--text-dim'] = roleValues['content.muted']
    vars['--border'] = roleValues['stroke.default']
    vars['--border-focus'] = roleValues['state.focusRing']
    vars['--success'] = roleValues['state.success']
    vars['--warning'] = roleValues['state.warning']
    vars['--danger'] = roleValues['state.danger']
    vars['--tool-ok'] = roleValues['state.success']
    vars['--tool-run'] = roleValues.accent
    vars['--tool-err'] = roleValues['state.danger']
    vars['--msg-text'] = roleValues['content.text']

    const applyRoleFallbackAlias = (cssVar: string, key: keyof typeof THEME_FIELD_DEFS, role: VisualSemanticRole) => {
      const definition = THEME_FIELD_DEFS[key]
      if (!isExplicitRoleValue(s[key], definition, scheme, role)) vars[cssVar] = roleValues[role]
    }
    applyRoleFallbackAlias('--chat-text-color', 'chatTextColor', 'content.text')
    applyRoleFallbackAlias('--cli-text-color', 'cliTextColor', 'content.text')
    applyRoleFallbackAlias('--cli-prompt-color', 'cliPromptColor', 'accent')
    applyRoleFallbackAlias('--cli-line-color', 'cliLineColor', 'connector.default')
    applyRoleFallbackAlias('--input-focus-border', 'inputFocusBorder', 'state.focusRing')
  }
  return vars
}
