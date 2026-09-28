import {
  CC_FLOATING_WIDGET_IDS,
  CC_WIDGET_GROUPS,
  ccWidgetLanding,
  coerceInputLanding,
  isWidgetVisible,
  STATUS_WIDGET_IDS,
} from './widgetDefinitions.ts'

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

// ── ★★ #266 刀2.5：横向 —— 最小宽（与上面那套**同构**，本文件因此两个方向都管） ──────────

/**
 * 横向上参与「最小宽」竞争的一个**组**。
 *
 * 「组」与最小高那边**同源**（一个横向落脚处 = `ccWidgetLanding`），但**取法不同**：
 * 同组的件是**并排**的 ⇒ 组宽 = 各件宽之**和**（高度那边是同一行里的件取**最大**）。
 */
export interface CcMinWidthGroup {
  /** 组的标识（诊断/读数用）：队列组 = `queue:<落脚处>`，脱离件 = 元件 id */
  readonly id: string
  /** 该组在横向上需要的宽度（px） */
  readonly width: number
  /** 该组到所贴横边的距离（px）—— `layout.x.gap` / `detachX.gap`，缺省 0 */
  readonly edgeGap: number
}

/**
 * 中控区**最小宽度** = `max over 各组 ( 该组宽 + 该组到所贴横边的距离 )`。
 *
 * ★ 与最小高 `max over 各组 ( 该组高 + 该组到所贴竖边的距离 )` **同构**（规范 §7.6）——
 *   两个方向都取 **max** 而非 sum，前提正是**横向允许重叠**（声明式脱离，见 `CcDetachX`）。
 * ★ 本刀（2.5）只把它**算出来并暴露**（渲染侧挂 `--cc-min-width`），**不强制**：
 *   窗口窄于它时不引入横向滚动、也不撑宽；真正的消费者是刀 4 的"显示前校验"。
 * ★ 纯函数：不入参之外不读任何东西（同输入同输出）。
 */
export function resolveCcMinWidth(groups: readonly CcMinWidthGroup[]): number {
  return groups.reduce((max, group) => Math.max(max, group.width + group.edgeGap), 0)
}

/**
 * 件 id → 它的**宽度字段值**（px）。
 * **缺席** = 该件是**内容撑**（`width:max-content`：用量胶囊 / 命令行提示）⇒ 算式算不出宽，
 * 按 0 计入 —— 于是结果对它们是**下界**（与 §7.2「行高有可算的下界」同一性质）。
 */
export type CcWidgetWidthIndex = Readonly<Record<string, number | undefined>>

/**
 * 从「隐藏名单 + 各件宽」派生横向上参与竞争的组（= `resolveCcMinWidth` 的输入）。
 *
 * 口径（全部从定义表读，不另立第二份规则）：
 * - **组 = 横向落脚处**；组宽 = 组内**在场**件宽之和 **+ 各件自己的"同落脚处内前置间距"**
 *   （行级 `gap`，见 `widgetDefinitions.ts` 表头）；
 * - **声明了 `detachX` 的件不排队** ⇒ 它**自成一"组"**（宽 = 自己，`edgeGap` = 到所贴边的距离），
 *   而**不**计入队列之和 —— 这正是"允许重叠"在算式里的体现：两者取 max，**不是相加**；
 * - **悬浮件**（发送按钮）不进任何落脚处 ⇒ 不参与（宽度由 `--cc-send-size` 自算）；
 * - 不在场的件不计入（"谁在场"由谓词定，与渲染同源）。
 *
 * ★ 组级 `edgeGap` 取组内**最大**声明（今天全部缺省 = 0）；`layout.x.gap` 是"贴边间距"，
 *   现状没有一行声明它 —— 所以本算式目前给出的是**声明口径的下界**：
 *   渲染侧的内缩（`.cc-body` 的横内边距、行内边距）与行内 flex 间距不在声明里，不计入。
 */
export function resolveCcWidthGroups(
  hiddenIds: readonly string[],
  widths: CcWidgetWidthIndex,
): CcMinWidthGroup[] {
  const queues = new Map<string, { width: number; edgeGap: number }>()
  const detached: CcMinWidthGroup[] = []
  for (const row of CC_WIDGET_GROUPS) {
    if (row.type !== 'widget' || !row.draggable || !row.layout) continue
    if (CC_FLOATING_WIDGET_IDS.includes(row.id)) continue
    if (!isWidgetVisible(row.id, { hidden: hiddenIds })) continue
    if (row.detachX) {
      detached.push({ id: row.id, width: widths[row.id] ?? 0, edgeGap: row.detachX.gap ?? 0 })
      continue
    }
    const landing = coerceInputLanding(row.id, ccWidgetLanding(row.id)) ?? row.id
    const queue = queues.get(landing) ?? { width: 0, edgeGap: 0 }
    queue.width += (widths[row.id] ?? 0) + (row.gap ?? 0)
    queue.edgeGap = Math.max(queue.edgeGap, row.layout.x.gap ?? 0)
    queues.set(landing, queue)
  }
  return [
    ...[...queues].map(([landing, queue]) => ({ id: `queue:${landing}`, ...queue })),
    ...detached,
  ]
}
