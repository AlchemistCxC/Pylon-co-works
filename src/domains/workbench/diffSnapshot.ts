/**
 * C06：content.diff 结构化快照收窄。
 *
 * 卡面要求：diff snapshot 同时保留 path、range、hunks、old/new、status 与 truncation；
 * unified/rawPatch 只作审计字段；结构化 diff 可重建，renderer 不重新解析 provider raw patch。
 * 未知 patch 字段保留为 metadata（不丢弃），但 renderer 分支只依赖已收窄字段。
 */

export interface DiffHunk {
  oldStart?: number
  oldLines?: number
  newStart?: number
  newLines?: number
}

export interface DiffLine {
  kind: 'context' | 'added' | 'removed'
  text: string
}

export interface DiffSnapshot {
  path?: string
  oldPath?: string
  status?: string
  hunks?: readonly DiffHunk[]
  lines?: readonly DiffLine[]
  oldText?: string
  newText?: string
  additions?: number
  deletions?: number
  binary?: boolean
  truncated?: boolean
  truncation?: unknown
  unified?: string
  /** 审计兼容 provider 原文/未知字段折叠（renderer 不读它决定分支）。 */
  rawPatch?: unknown
  unknownFields?: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const toInt = (value: unknown): number | undefined =>
  Number.isInteger(value) ? value as number : undefined

/** 已知结构化字段之外的一律算未知字段名（保留元数据用）。 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'kind', 'path', 'oldPath', 'status', 'hunks', 'lines', 'oldText', 'newText',
  'additions', 'deletions', 'binary', 'truncated', 'truncation', 'unified', 'rawPatch',
])

function parseLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const lines: DiffLine[] = []
  for (let index = 0; index < Math.max(oldLines.length, newLines.length); index += 1) {
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

/**
 * 从 content.diff part 收窄出 typed snapshot。
 * 非 diff part 返回 null；缺字段保持 undefined 不伪造。
 */
export function diffSnapshotFromPart(part: unknown): DiffSnapshot | null {
  if (!isRecord(part)) return null
  if (part.kind !== 'diff') return null

  // 未知字段收集（metadata 展开，不参与渲染分支）
  const unknownFields = Object.keys(part).filter(key => !KNOWN_FIELDS.has(key))

  const hunksRaw = Array.isArray(part.hunks) ? part.hunks : undefined
  const hunks = hunksRaw?.map(hunk => isRecord(hunk) ? ({
    ...(toInt(hunk.oldStart) !== undefined ? { oldStart: toInt(hunk.oldStart) } : {}),
    ...(toInt(hunk.oldLines) !== undefined ? { oldLines: toInt(hunk.oldLines) } : {}),
    ...(toInt(hunk.newStart) !== undefined ? { newStart: toInt(hunk.newStart) } : {}),
    ...(toInt(hunk.newLines) !== undefined ? { newLines: toInt(hunk.newLines) } : {}),
  }) : null).filter((hunk): hunk is DiffHunk => hunk !== null && Object.keys(hunk).length > 0)

  const oldText = toText(part.oldText)
  const newText = toText(part.newText)
  const lines = oldText !== undefined && newText !== undefined && !part.binary
    ? parseLines(oldText, newText)
    : undefined

  return {
    ...(toText(part.path) ? { path: toText(part.path) } : {}),
    ...(toText(part.oldPath) ? { oldPath: toText(part.oldPath) } : {}),
    ...(toText(part.status) ? { status: toText(part.status) } : {}),
    ...(hunks && hunks.length > 0 ? { hunks } : {}),
    ...(lines ? { lines } : {}),
    ...(oldText !== undefined ? { oldText } : {}),
    ...(newText !== undefined ? { newText } : {}),
    ...(toInt(part.additions) !== undefined ? { additions: toInt(part.additions) } : {}),
    ...(toInt(part.deletions) !== undefined ? { deletions: toInt(part.deletions) } : {}),
    ...(part.binary === true ? { binary: true } : {}),
    ...(part.truncated === true ? { truncated: true } : {}),
    ...(part.truncation !== undefined ? { truncation: part.truncation } : {}),
    ...(toText(part.unified) ? { unified: toText(part.unified) } : {}),
    ...(part.rawPatch !== undefined ? { rawPatch: part.rawPatch } : {}),
    ...(unknownFields.length > 0 ? { unknownFields } : {}),
  }
}
