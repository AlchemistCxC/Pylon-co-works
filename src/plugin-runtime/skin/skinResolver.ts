/**
 * skinResolver — Skin 分层合并与投影（阶段 5 S5-B/S5-C）。
 *
 * 优先级：session → agent → workspace → global committed → DEFAULTS。
 * 调用方按低→高传入 layers；undefined 值一律视为“未覆盖”，空字符串是显式覆盖。
 * CSS variable 投影复用 `selectThemeCssSnapshot()`，不复制字段映射。
 */
import { selectThemeCssSnapshot, type ThemeCssLayout } from '../../domains/theme/themeCssSnapshot.ts'
import { DEFAULTS } from '../../domains/theme/themeDefaults.ts'
import type {
  ResolvedSkin,
  SkinSourceEntry,
  SkinTarget,
} from './skinTypes.ts'

export interface SkinResolutionLayer {
  kind: 'preview' | 'committed' | 'default'
  target?: SkinTarget
  skinId?: string
  previewId?: string
  tokens: Record<string, unknown>
  variants?: Record<string, string>
  css?: string
}

export interface SkinResolveOptions {
  layout?: ThemeCssLayout
}

const DEFAULT_LAYOUT: ThemeCssLayout = {
  sidebarCollapsed: false,
  sidebarWidth: typeof DEFAULTS.sidebarWidth === 'number' ? DEFAULTS.sidebarWidth : 250,
  sidebarEnabled: true,
}

export const SKIN_DATA_ATTRIBUTES = [
  'data-ui-scheme',
  'data-msg-style',
  'data-message-layout',
  'data-footer-layout',
  'data-cli-overflow-mode',
  'data-cc-variant',
] as const

export function resolveSkinDataAttributes(tokens: Record<string, unknown>): Record<string, string> {
  return {
    'data-ui-scheme': typeof tokens.uiScheme === 'string' && tokens.uiScheme ? tokens.uiScheme : 'light',
    'data-msg-style': typeof tokens.msgStyle === 'string' && tokens.msgStyle ? tokens.msgStyle : 'terminal',
    'data-message-layout': typeof tokens.messageLayout === 'string' && tokens.messageLayout ? tokens.messageLayout : 'classic',
    'data-footer-layout': typeof tokens.footerLayout === 'string' && tokens.footerLayout ? tokens.footerLayout : 'free',
    'data-cli-overflow-mode': typeof tokens.cliOverflowMode === 'string' && tokens.cliOverflowMode ? tokens.cliOverflowMode : 'fixed-scroll',
    'data-cc-variant': typeof tokens.ccVariant === 'string' && tokens.ccVariant ? tokens.ccVariant : 'terminal',
  }
}

export function resolveSkinCssVariables(
  tokens: Record<string, unknown>,
  layout: ThemeCssLayout = DEFAULT_LAYOUT,
): Record<string, string> {
  return selectThemeCssSnapshot(tokens, layout)
}

function cloneTokens(tokens: Record<string, unknown>): Record<string, unknown> {
  return { ...tokens }
}

/** 按低→高顺序合并 layers，返回完整 ResolvedSkin。revision 由 Runtime 覆盖。 */
export function resolveSkinLayers(
  layers: readonly SkinResolutionLayer[],
  options: SkinResolveOptions = {},
): ResolvedSkin {
  const tokens: Record<string, unknown> = {}
  const variants: Record<string, string> = {}
  let css: string | undefined
  const sources: SkinSourceEntry[] = []

  for (const layer of layers) {
    const fields: string[] = []
    for (const [key, value] of Object.entries(layer.tokens)) {
      if (value === undefined) continue
      tokens[key] = value
      fields.push(key)
    }
    for (const [key, value] of Object.entries(layer.variants ?? {})) {
      if (value === undefined) continue
      variants[key] = value
    }
    if (layer.css !== undefined) css = layer.css

    const source: SkinSourceEntry = { kind: layer.kind, fields }
    if (layer.target) source.target = layer.target
    if (layer.skinId) source.skinId = layer.skinId
    if (layer.previewId) source.previewId = layer.previewId
    sources.push(source)
  }

  const fullTokens: Record<string, unknown> = structuredClone(
    DEFAULTS as unknown as Record<string, unknown>,
  )
  Object.assign(fullTokens, cloneTokens(tokens))

  return {
    revision: 0,
    tokens: fullTokens,
    variants: { ...variants },
    ...(css !== undefined ? { css } : {}),
    cssVariables: resolveSkinCssVariables(fullTokens, options.layout ?? DEFAULT_LAYOUT),
    dataAttributes: resolveSkinDataAttributes(fullTokens),
    sources,
  }
}
