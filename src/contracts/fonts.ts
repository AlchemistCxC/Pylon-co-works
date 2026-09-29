/**
 * fonts — 字体贡献契约（自 plugin-runtime/fonts/fontContributionTypes 抽出）。
 *
 * 中立落点：domains/theme（themeFieldDefs 字段元数据）与 plugin-runtime（字体注册表）
 * 双方都从这里取类型，打破「theme → plugin-runtime ↔ skin → theme」的类型环
 * （结构审查 B-5/B-13）。契约层零 import，保持 src/contracts/ 纪律。
 */

/** The UI role controls where a contributed font may be selected. */
export type FontRole = 'interface' | 'content' | 'code'

/**
 * Plugins contribute a stable font id and a CSS font-family stack. Loading a
 * bundled @font-face remains the plugin's responsibility, so the host never
 * downloads an untrusted remote asset on behalf of a contribution.
 */
export interface FontContribution {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly family: string
  readonly roles: readonly FontRole[]
  readonly order?: number
  readonly sample?: string
}


/** 插件贡献字体的 CSS 变量名约定（自 plugin-runtime/fonts/fontContributionRegistry 上收；theme⇄skin 环破除件）。 */
export function fontContributionCssVariable(id: string): string {
  const safeId = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  return `--pylon-font-${safeId || 'invalid'}`
}
