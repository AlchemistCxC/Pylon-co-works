import { isWidgetVisible, STATUS_WIDGET_IDS } from './widgetDefinitions.ts'

/**
 * 快捷提示详细档（`cliHintMode`）—— 唯一还活着的「形态」类字段。
 * ★ #266 刀9/刀10/刀11：`CcInputMode` / `CcFooterLayout` / `CcOverflowMode` 三个类型已随
 *   对应字段删除（输入固定命令行、底部信息固定独立状态行、多行输入固定「随内容增高 + 3 倍封顶」）。
 */
export type CcHintMode = 'hidden' | 'compact' | 'full' | string

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

export function resolveVisibleStatusWidgetCount({
  hiddenIds,
}: {
  /** 隐藏名单（**组装好的**：预设的值 + 详细档折叠 + 语境侧名单，见 `resolveCcHiddenWidgetIds`） */
  hiddenIds: readonly string[]
}): number {
  // C2：与渲染共用一个可见性谓词。★ #266 ⑰ 后可见性**只由隐藏名单决定** ——
  //   元件的行上不再有任何显隐申明，也不再有运行期条件 ⇒ 谓词的上下文只剩 `hidden`。
  //   名单的组装**只有一处**（`resolveCcHiddenWidgetIds`），渲染侧与这里同源，
  //   否则会出现"计数多算一个不渲染的元件"（正是 C2 要防的）。
  return STATUS_WIDGET_IDS.filter(id => isWidgetVisible(id, { hidden: hiddenIds })).length
}

const BASE_MIN_HEIGHT = 64

/**
 * 中控区最小高度。
 *
 * ★ #266 刀9/刀10/刀11：形态收敛成**唯一一种**（命令行输入 + 独立状态行 + 随内容增高）之后，
 *   原先那三条分支 —— `cliOverflowMode==='grow'`、`inputMode!=='cli'`、`footerLayout!=='peri'`
 *   —— 全部导向同一个值 ⇒ 本函数退化为常量。
 *   **行为等价**：改造前 free 形态（= 现在唯一形态，也是用户实际在用的）走的就是
 *   `return BASE_MIN_HEIGHT` 这一支；peri 形态那一套算式随 `footerLayout` 字段一并退场。
 *
 * ★ 用户口径：位置 / 尺寸差异不再由「元件的小预设」承载，改由**区域预设记值**；中控最小高度
 *   因此回归到一个固定约束，不再随提示详细档或状态控件个数浮动。
 */
export function resolveCcMinHeight(): number {
  return BASE_MIN_HEIGHT
}

export function clampCcHeight(height: number): number {
  const min = resolveCcMinHeight()
  const safeHeight = Number.isFinite(height) ? height : min
  return Math.max(min, Math.min(400, safeHeight))
}
