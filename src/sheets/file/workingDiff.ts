/**
 * workingDiff — 未保存编辑 vs 磁盘基线 的 working-diff 纯函数（I08-A-FE-02，D-03/D-05）。
 *
 * working-diff = 基线（最近一次成功保存的磁盘文本）与编辑器当前未保存内容的行级差；
 * 与 diffPresentation.makeLines 同族（逐行 index 比较，context/added/removed），
 * 但 diffPresentation 在 scope 外不可改，故在此以独立纯函数提供。
 */
import type { DiffLine } from '../../domains/tool/diffPresentation'
import type { DispatchSelection } from '../../domains/fileDispatch/dispatchMessage'

/** 基线 vs 当前全文的行级 diff（per-index 比较，与 makeLines/changedLineNumbers 同族）。
 * 空字符串按无行处理，避免空基线产生一条伪 removed ''。 */
export function workingDiffLines(baseline: string, current: string): DiffLine[] {
  const oldLines = baseline === '' ? [] : baseline.split('\n')
  const newLines = current === '' ? [] : current.split('\n')
  const lines: DiffLine[] = []
  const max = Math.max(oldLines.length, newLines.length)
  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index]
    const newLine = newLines[index]
    if (oldLine === newLine && oldLine !== undefined) {
      lines.push({ kind: 'context', text: oldLine })
      continue
    }
    if (oldLine !== undefined) lines.push({ kind: 'removed', text: oldLine })
    if (newLine !== undefined) lines.push({ kind: 'added', text: newLine })
  }
  return lines
}

export interface WorkingDiffStats {
  added: number
  removed: number
}

export function workingDiffStats(lines: readonly DiffLine[]): WorkingDiffStats {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'added') added += 1
    else if (line.kind === 'removed') removed += 1
  }
  return { added, removed }
}

/** 字符偏移 → 1-based 行号（越界收敛到最后一行） */
export function lineNumberAtOffset(text: string, offset: number): number {
  const clamped = Math.min(Math.max(offset, 0), text.length)
  let line = 1
  for (let index = 0; index < clamped; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

/** textarea 选区 → 行号区间（无选区＝光标行） */
export function selectionLinesFromTextarea(textarea: Pick<HTMLTextAreaElement, 'value' | 'selectionStart' | 'selectionEnd'>): DispatchSelection {
  const startLine = lineNumberAtOffset(textarea.value, textarea.selectionStart)
  const endLine = lineNumberAtOffset(textarea.value, textarea.selectionEnd)
  return { startLine, endLine }
}
