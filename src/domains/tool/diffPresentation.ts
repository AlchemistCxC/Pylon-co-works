/**
 * diffPresentation — diff 纯解析（P1-10 迁入 domains/tool）。
 *
 * DiffPayload 统一模型 + 解析（JSON 对象 / unified diff / 内容块对象，camel/snake 兼容）；
 * wordDiff 词级 diff。原实现自 components/chat/diffPresentation 迁入，文件保留兼容 re-export。
 */

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

/** 对象 diff 解析：old/new 键多兜底（camel/snake，P1-10 支持 tool_diff_content 的 snake_case 字段） */
export function diffPayloadFromObject(value: unknown): DiffPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const object = value as Record<string, unknown>
  const oldText = toText(object.oldText) ?? toText(object.old) ?? toText(object.before) ?? toText(object.old_content) ?? toText(object.oldContent)
  const newText = toText(object.newText) ?? toText(object.new) ?? toText(object.after) ?? toText(object.new_content) ?? toText(object.newContent)
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
    const objectPayload = diffPayloadFromObject(parsed)
    if (objectPayload) return objectPayload
  } catch {
    // 普通文本不是结构化 diff，继续尝试 unified diff。
  }
  return fromUnifiedDiff(output)
}

export interface DiffWordSegment {
  text: string
  kind: 'added' | 'removed' | 'common'
}

/**
 * 词级 diff（CC 双层：整行背景 + 变更词背景）。
 * 保留空白 token 对齐；LCS DP 找公共词序列，差异词标记 added/removed。
 */
export function wordDiff(oldText: string, newText: string): DiffWordSegment[] {
  const oldTokens = oldText.split(/(\s+)/).filter(token => token !== '')
  const newTokens = newText.split(/(\s+)/).filter(token => token !== '')
  const m = oldTokens.length
  const n = newTokens.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const segments: DiffWordSegment[] = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && oldTokens[i] === newTokens[j]) {
      segments.push({ text: oldTokens[i], kind: 'common' })
      i += 1
      j += 1
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      segments.push({ text: newTokens[j], kind: 'added' })
      j += 1
    } else {
      segments.push({ text: oldTokens[i], kind: 'removed' })
      i += 1
    }
  }
  return segments
}
