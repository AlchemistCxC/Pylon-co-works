import { isWidgetVisible, STATUS_WIDGET_IDS } from './domains/cc/widgetDefinitions.ts'

export type CcInputMode = 'cli' | 'default' | string
export type CcFooterLayout = 'free' | 'peri' | string
export type CcHintMode = 'hidden' | 'compact' | 'full' | string
export type CcOverflowMode = 'fixed-scroll' | 'grow' | 'overlay' | string

export const INPUT_LINE_HEIGHTS = ['0.5', '1', '1.5'] as const
export type InputLineHeight = (typeof INPUT_LINE_HEIGHTS)[number]

export function clampInputTypography<T extends { inputFontSize: number; inputLineHeight: string; inputHeight: number }>(theme: T, changedKey?: string): T {
  let inputFontSize = Math.round(Number(theme.inputFontSize))
  let inputLineHeight = INPUT_LINE_HEIGHTS.includes(theme.inputLineHeight as InputLineHeight)
    ? theme.inputLineHeight as InputLineHeight : '1'
  const effectiveHeight = Math.max(0, theme.inputHeight * 0.8)
  const fits = (size: number, line: InputLineHeight) => size * (1 + Number(line)) < effectiveHeight

  if (changedKey === 'inputHeight') {
    // Height edits never alter typography. Raise the height only as far as
    // needed for strict `occupied < 0.8 * height` validity.
    const occupiedHeight = inputFontSize * (1 + Number(inputLineHeight))
    const minInputHeight = Math.floor(occupiedHeight * 1.25) + 1
    return {
      ...theme,
      inputFontSize,
      inputLineHeight,
      inputHeight: Math.max(theme.inputHeight, minInputHeight),
    }
  }

  if (changedKey === 'inputFontSize') {
    // When the font size changes, preserve the selected line height and only
    // reduce the font size until the current typography fits.
    while (inputFontSize > 12 && !fits(inputFontSize, inputLineHeight)) inputFontSize -= 1
  } else if (changedKey === 'inputLineHeight') {
    // When the line height changes, lower it first (1.5 -> 1 -> 0.5), then
    // reduce the font size if even the smallest line height still overflows.
    while (!fits(inputFontSize, inputLineHeight)) {
      const idx = INPUT_LINE_HEIGHTS.indexOf(inputLineHeight)
      if (idx > 0) inputLineHeight = INPUT_LINE_HEIGHTS[idx - 1]
      else if (inputFontSize > 12) inputFontSize -= 1
      else break
    }
  } else {
    // For other changes, preserve a fitting typography and apply the same
    // line-height-before-font-size fallback when needed.
    while (!fits(inputFontSize, inputLineHeight)) {
      const idx = INPUT_LINE_HEIGHTS.indexOf(inputLineHeight)
      if (idx > 0) inputLineHeight = INPUT_LINE_HEIGHTS[idx - 1]
      else if (inputFontSize > 12) inputFontSize -= 1
      else break
    }
  }
  return {
    ...theme,
    inputFontSize,
    inputLineHeight,
    inputHeight: Math.max(theme.inputHeight, inputFontSize * (1 + Number(inputLineHeight))),
  }
}

export interface CcMinHeightOptions {
  inputMode: CcInputMode
  footerLayout: CcFooterLayout
  hintMode: CcHintMode
  visibleStatusWidgets: number
  cliOverflowMode: CcOverflowMode
}

export function resolveVisibleStatusWidgetCount({
  hiddenIds,
  inputMode,
  ccStyle,
  submitButtonMode,
  presentationProfileId,
}: {
  hiddenIds: readonly string[]
  inputMode: CcInputMode
  ccStyle: string
  submitButtonMode: string
  presentationProfileId?: string
}): number {
  // C2：与渲染共用一个可见性谓词（含 submitButtonMode 的 send/attach 判定），
  // 修此前"计数把不渲染的 send/attach 算入最小高"的失真。
  return STATUS_WIDGET_IDS.filter(id => isWidgetVisible(id, { hidden: hiddenIds, inputMode, submitButtonMode, ccStyle, presentationProfileId })).length
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
