export type CcInputMode = 'cli' | 'default' | string
export type CcFooterLayout = 'free' | 'peri' | string
export type CcHintMode = 'hidden' | 'compact' | 'full' | string
export type CcOverflowMode = 'fixed-scroll' | 'grow' | 'overlay' | string

export interface CcMinHeightOptions {
  inputMode: CcInputMode
  footerLayout: CcFooterLayout
  hintMode: CcHintMode
  visibleStatusWidgets: number
  cliOverflowMode: CcOverflowMode
}

const STATUS_WIDGET_IDS = ['ekg', 'pct', 'tokens', 'model', 'mode', 'send', 'attach'] as const

export function resolveVisibleStatusWidgetCount({
  hiddenIds,
  inputMode,
  ccStyle,
}: {
  hiddenIds: readonly string[]
  inputMode: CcInputMode
  ccStyle: string
}): number {
  return STATUS_WIDGET_IDS.filter(id => {
    if (hiddenIds.includes(id)) return false
    if (inputMode === 'cli' && (id === 'send' || id === 'attach')) return false
    if (ccStyle === 'numeric' && id === 'ekg' && !hiddenIds.includes('pct')) return false
    if (ccStyle === 'ring' && id === 'pct' && !hiddenIds.includes('ekg')) return false
    return true
  }).length
}

const BASE_MIN_HEIGHT = 64
const COMPOSER_HEIGHT = 30
const FOOTER_GAP = 5
const STATUS_ROW_HEIGHT = 25
const HINT_ROW_HEIGHT = 21
const BOTTOM_PADDING = 3

/**
 * 计算中控区能够容纳当前结构的最小高度。
 * 这是布局约束真值；CSS、Settings 和 store action 都应消费同一结果。
 */
export function resolveCcMinHeight(options: CcMinHeightOptions): number {
  const {
    inputMode,
    footerLayout,
    hintMode,
    visibleStatusWidgets,
    cliOverflowMode,
  } = options

  if (cliOverflowMode === 'grow') return BASE_MIN_HEIGHT
  if (inputMode !== 'cli' || footerLayout !== 'peri') return BASE_MIN_HEIGHT

  const hintHeight = hintMode === 'hidden' ? 0 : HINT_ROW_HEIGHT
  const wrappedStatusRows = visibleStatusWidgets > 4 ? STATUS_ROW_HEIGHT : 0
  const contentHeight = COMPOSER_HEIGHT
    + FOOTER_GAP
    + STATUS_ROW_HEIGHT
    + wrappedStatusRows
    + hintHeight
    + BOTTOM_PADDING

  return Math.max(BASE_MIN_HEIGHT, contentHeight)
}

export function clampCcHeight(height: number, options: CcMinHeightOptions): number {
  const min = resolveCcMinHeight(options)
  const safeHeight = Number.isFinite(height) ? height : min
  return Math.max(min, Math.min(400, safeHeight))
}
