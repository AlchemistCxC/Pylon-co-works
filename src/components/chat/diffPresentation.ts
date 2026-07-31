export interface DiffLine {
  kind: 'context' | 'added' | 'removed'
  text: string
}

export interface DiffPayload {
  oldText: string
  newText: string
  lines: DiffLine[]
}

function toText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function makeLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
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

function fromObject(value: unknown): DiffPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const object = value as Record<string, unknown>
  const oldText = toText(object.oldText) ?? toText(object.old) ?? toText(object.before)
  const newText = toText(object.newText) ?? toText(object.new) ?? toText(object.after)
  if (oldText === null || newText === null || oldText === newText) return null
  return { oldText, newText, lines: makeLines(oldText, newText) }
}

function fromUnifiedDiff(text: string): DiffPayload | null {
  const lines = text.split('\n')
  if (!lines.some(line => line.startsWith('@@ ')) || !lines.some(line => line.startsWith('--- ')) || !lines.some(line => line.startsWith('+++ '))) return null
  const diffLines: DiffLine[] = []
  for (const line of lines) {
    if (line.startsWith('@@ ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (line.startsWith('+')) diffLines.push({ kind: 'added', text: line.slice(1) })
    else if (line.startsWith('-')) diffLines.push({ kind: 'removed', text: line.slice(1) })
    else if (line.startsWith(' ')) diffLines.push({ kind: 'context', text: line.slice(1) })
  }
  return diffLines.some(line => line.kind !== 'context')
    ? { oldText: '', newText: '', lines: diffLines }
    : null
}

export function normalizeDiffPayload(output: string): DiffPayload | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const objectPayload = fromObject(parsed)
    if (objectPayload) return objectPayload
  } catch {
    // 普通文本不是结构化 diff，继续尝试 unified diff。
  }
  return fromUnifiedDiff(output)
}