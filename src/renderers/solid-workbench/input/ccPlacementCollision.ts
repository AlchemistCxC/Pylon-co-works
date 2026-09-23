/**
 * ccPlacementCollision — 编辑态「占区不叠加」的**纯几何**判定（#238 刀4）。
 *
 * ★ 本模块**不碰 DOM、不碰 store**：矩形、偏移、障碍集都由调用方传进来
 * ⇒ 可以在 node 环境直接单测（几何规则不依赖渲染环境）。
 *
 * 契约（用户口径「就像有碰撞体积」）：
 * - 判据 = 两矩形**相交**（交集面积 > 0）；★ **允许贴合**（边贴边、面积 0 不算撞），不加任何魔法间隙；
 * - 约束算法 = **「推不动就贴着它滑」**：全量候选 → 只水平 → 只垂直 → 保持原位；
 *   「回弹」是这个算法的自然结果，**没有**单独的回弹逻辑；
 * - **悬浮件**（`CC_FLOATING_WIDGET_IDS`，现只有发送按钮）既**不当障碍**也**不受约束**
 *   —— 由调用方过滤/短路（本模块不认识"悬浮"这个概念）。
 */

/** 只用到四条边：`DOMRect` 与手写矩形都能传进来。 */
export interface CcRectLike {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface CcOffsetPair {
  readonly offsetX: number
  readonly offsetY: number
}

/** 相交（交集面积 > 0）。★ 贴合（共用一条边、面积 0）**不算**撞。 */
export function rectsOverlap(a: CcRectLike, b: CcRectLike): boolean {
  const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return overlapWidth > 0 && overlapHeight > 0
}

/** 把已含 `applied` 位移的矩形，换算到含 `target` 位移的位置。 */
function shiftedTo(rect: CcRectLike, applied: CcOffsetPair, target: CcOffsetPair): CcRectLike {
  const dx = target.offsetX - applied.offsetX
  const dy = target.offsetY - applied.offsetY
  return { left: rect.left + dx, top: rect.top + dy, right: rect.right + dx, bottom: rect.bottom + dy }
}

/**
 * 求一个**不撞**的偏移。
 *
 * 按序试：① 全量候选 `(x, y)` ② 只水平走 `(x, previous.y)` ③ 只垂直走 `(previous.x, y)` ④ `previous`（原地不动）。
 *
 * @param applied   元件**此刻**屏幕上的偏移 —— 必须与 `baseRect` **同源**（同一 DOM 快照），
 *                  否则候选矩形的换算会错一帧。
 * @param baseRect  此刻的占区（**已含** `applied` 的位移）。
 * @param candidate 本次想去的偏移。
 * @param previous  上一次**被接受**的偏移（兜底）。调用方通常直接传 `applied`：拖动路径里
 *                  元素当前渲染出来的偏移就是"上一次被接受的偏移"（状态由 DOM 承载，不需要另外记）。
 * @param obstacles 障碍占区（**不含**被测者自身与悬浮件）。
 */
export function resolveAllowedOffset(input: {
  applied: CcOffsetPair
  baseRect: CcRectLike
  candidate: CcOffsetPair
  previous: CcOffsetPair
  obstacles: readonly CcRectLike[]
}): CcOffsetPair {
  const { applied, baseRect, candidate, previous, obstacles } = input
  const collides = (target: CcOffsetPair) => {
    const rect = shiftedTo(baseRect, applied, target)
    return obstacles.some(obstacle => rectsOverlap(rect, obstacle))
  }
  if (!collides(candidate)) return candidate
  const onlyHorizontal: CcOffsetPair = { offsetX: candidate.offsetX, offsetY: previous.offsetY }
  if (!collides(onlyHorizontal)) return onlyHorizontal
  const onlyVertical: CcOffsetPair = { offsetX: previous.offsetX, offsetY: candidate.offsetY }
  if (!collides(onlyVertical)) return onlyVertical
  return previous
}

/**
 * 从元素 inline `transform` 里读回**此刻真正生效**的偏移（`placementStyle` 写的就是它）。
 *
 * 为什么不用 store 里的值：Solid 的事件处理里 DOM 更新可能还没落地，
 * 而"矩形 + 偏移"必须来自**同一份渲染结果**，否则候选矩形会算错一帧。
 */
export function parseTranslateOffset(transform: string | null | undefined): CcOffsetPair {
  const matched = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(transform ?? '')
  if (!matched) return { offsetX: 0, offsetY: 0 }
  const offsetX = Number(matched[1])
  const offsetY = Number(matched[2])
  return {
    offsetX: Number.isFinite(offsetX) ? offsetX : 0,
    offsetY: Number.isFinite(offsetY) ? offsetY : 0,
  }
}

/**
 * 哪些情况下**不做**占区约束（三条按序短路；抽成纯函数是为了让"豁免"这件事能被单测钉住，
 * 而不是靠一句 if 的口头承诺）：
 * 1. **非编辑态** —— 常态界面不跑几何（像素与性能零变化）；
 * 2. **悬浮件**（`CC_FLOATING_WIDGET_IDS`，现只有发送按钮）—— 它声明就是要压在输入栏上；
 * 3. **没碰偏移**（只改 `order`）—— 改顺序是用户明确意图，且本来就可能让两个元件互换位置。
 */
export function shouldBypassCollisionConstraint(input: {
  editMode: boolean
  id: string
  floatingIds: readonly string[]
  touchesOffset: boolean
}): boolean {
  if (!input.editMode) return true
  if (input.floatingIds.includes(input.id)) return true
  return !input.touchesOffset
}
