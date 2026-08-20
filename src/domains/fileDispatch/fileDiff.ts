/**
 * fileDiff — 行级 diff 行号集提取（W2-07，§5.2）。
 *
 * 与 diffPresentation.makeLines 同族：old/new 全文按行比较，返回 newText 中发生
 * 变更的行号（1-based）——刷新跟随高亮用。>5000 行由调用方跳过（diff 成本保护）。
 */

/** 返回 newText 中 changed 行号（1-based，含 added/modified；纯 removed 行在 new 中不存在则跳过） */
export function changedLineNumbers(oldText: string, newText: string): number[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const max = Math.max(oldLines.length, newLines.length)
  const changed: number[] = []
  for (let index = 0; index < max; index += 1) {
    if (oldLines[index] !== newLines[index] && newLines[index] !== undefined) {
      changed.push(index + 1)
    }
  }
  return changed
}
