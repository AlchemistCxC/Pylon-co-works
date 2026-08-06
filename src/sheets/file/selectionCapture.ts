/**
 * selectionCapture — DOM 选区 → 1-based 行号（W2-08，方案 A）。
 *
 * 按渲染行 DOM 的 data-line 计算（每行独立节点，anchor/focus 向上找最近 data-line）；
 * 行号归一为 start/end（anchor 可能在后）。纯函数可单测（fixture 断言防 off-by-one）。
 */

export interface SelectionRange {
  startLine: number
  endLine: number
}

/** anchor/focus 行号归一：排序 start/end；任一缺失 → null（无有效框选） */
export function normalizeSelectionRange(anchorLine: number | null, focusLine: number | null): SelectionRange | null {
  if (anchorLine == null || focusLine == null) return null
  return { startLine: Math.min(anchorLine, focusLine), endLine: Math.max(anchorLine, focusLine) }
}

interface LineNodeLike {
  getAttribute?: (name: string) => string | null
  parentNode?: LineNodeLike | null
}

/** 从 DOM 节点向上找最近 [data-line]，返回 1-based 行号；无则 null（node 环境可测——鸭子类型而非 Element instanceof） */
export function lineFromDataNode(node: Node | null): number | null {
  let current: LineNodeLike | null = node as unknown as LineNodeLike
  while (current) {
    if (typeof current.getAttribute === 'function') {
      const attr = current.getAttribute('data-line')
      if (attr) {
        const parsed = Number(attr)
        return Number.isFinite(parsed) ? parsed : null
      }
    }
    current = current.parentNode ?? null
  }
  return null
}
