/**
 * C06：content.diff 结构化快照收窄。
 *
 * 卡面要求：diff snapshot 同时保留 path、range、hunks、old/new、status 与 truncation；
 * unified/rawPatch 只作审计字段；结构化 diff 可重建，renderer 不重新解析 provider raw patch。
 * 未知 patch 字段保留为 metadata（不丢弃），但 renderer 分支只依赖已收窄字段。
 */
import { isJsonValue, type ContentTruncation, type JsonValue, type TextPosition, type TextRange } from './content/contentPartSchema.ts'

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
  range?: TextRange
  hunks?: readonly DiffHunk[]
  lines?: readonly DiffLine[]
  oldText?: string
  newText?: string
  additions?: number
  deletions?: number
  binary?: boolean
  truncated?: boolean
  truncation?: ContentTruncation
  unified?: string
  /** 审计兼容 provider 原文/未知字段折叠（renderer 不读它决定分支）。 */
  rawPatch?: JsonValue
  unknownFields?: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toTrimmedText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

const toSourceText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const toInt = (value: unknown): number | undefined =>
  Number.isInteger(value) && Number(value) >= 0 ? value as number : undefined

/** 已知结构化字段之外的一律算未知字段名（保留元数据用）。 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'kind', 'type', 'path', 'oldPath', 'status', 'range', 'hunks', 'lines', 'oldText', 'newText',
  'additions', 'deletions', 'binary', 'truncated', 'truncation', 'unified', 'rawPatch',
  'unknownFields',
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
  const declaredUnknownFields = Array.isArray(part.unknownFields)
    ? part.unknownFields.filter((value): value is string => typeof value === 'string')
    : []
  const unknownFields = [...new Set([...declaredUnknownFields, ...Object.keys(part).filter(key => !KNOWN_FIELDS.has(key))])]

  const hunksRaw = Array.isArray(part.hunks) ? part.hunks : undefined
  const hunks = hunksRaw?.map(hunk => isRecord(hunk) ? ({
    ...(toInt(hunk.oldStart) !== undefined ? { oldStart: toInt(hunk.oldStart) } : {}),
    ...(toInt(hunk.oldLines) !== undefined ? { oldLines: toInt(hunk.oldLines) } : {}),
    ...(toInt(hunk.newStart) !== undefined ? { newStart: toInt(hunk.newStart) } : {}),
    ...(toInt(hunk.newLines) !== undefined ? { newLines: toInt(hunk.newLines) } : {}),
  }) : null).filter((hunk): hunk is DiffHunk => hunk !== null && Object.keys(hunk).length > 0)

  const oldText = toSourceText(part.oldText)
  const newText = toSourceText(part.newText)
  const structuredLines: DiffLine[] | undefined = Array.isArray(part.lines)
    ? part.lines.flatMap<DiffLine>(line => isRecord(line)
      && (line.kind === 'context' || line.kind === 'added' || line.kind === 'removed')
      && typeof line.text === 'string'
      ? [{ kind: line.kind as DiffLine['kind'], text: line.text }]
      : [])
    : undefined
  const lines = structuredLines && structuredLines.length > 0
    ? structuredLines
    : oldText !== undefined && newText !== undefined && !part.binary
      ? parseLines(oldText, newText)
      : undefined
  const range = narrowTextRange(part.range)
  const truncation = narrowTruncation(part.truncation)

  return {
    ...(toTrimmedText(part.path) ? { path: toTrimmedText(part.path) } : {}),
    ...(toTrimmedText(part.oldPath) ? { oldPath: toTrimmedText(part.oldPath) } : {}),
    ...(toTrimmedText(part.status) ? { status: toTrimmedText(part.status) } : {}),
    ...(range ? { range } : {}),
    ...(hunks && hunks.length > 0 ? { hunks } : {}),
    ...(lines ? { lines } : {}),
    ...(oldText !== undefined ? { oldText } : {}),
    ...(newText !== undefined ? { newText } : {}),
    ...(toInt(part.additions) !== undefined ? { additions: toInt(part.additions) } : {}),
    ...(toInt(part.deletions) !== undefined ? { deletions: toInt(part.deletions) } : {}),
    ...(part.binary === true ? { binary: true } : {}),
    ...(part.truncated === true ? { truncated: true } : {}),
    ...(truncation ? { truncation } : {}),
    ...(toSourceText(part.unified) ? { unified: toSourceText(part.unified) } : {}),
    ...(part.rawPatch !== undefined && isJsonValue(part.rawPatch) ? { rawPatch: part.rawPatch } : {}),
    ...(unknownFields.length > 0 ? { unknownFields } : {}),
  }
}

function narrowTextRange(value: unknown): TextRange | undefined {
  if (!isRecord(value)) return undefined
  const start = narrowTextPosition(value.start)
  const end = value.end === undefined ? undefined : narrowTextPosition(value.end)
  if (!start || value.end !== undefined && !end) return undefined
  if (end && (end.line < start.line || end.line === start.line && (end.character ?? 0) < (start.character ?? 0))) return undefined
  return { start, ...(end ? { end } : {}) }
}

function narrowTextPosition(value: unknown): TextPosition | undefined {
  if (!isRecord(value) || !Number.isInteger(value.line) || Number(value.line) < 0) return undefined
  if (value.character !== undefined && (!Number.isInteger(value.character) || Number(value.character) < 0)) return undefined
  return { line: Number(value.line), ...(value.character !== undefined ? { character: Number(value.character) } : {}) }
}

function narrowTruncation(value: unknown): ContentTruncation | undefined {
  if (!isRecord(value) || value.truncated !== true
    || !Number.isInteger(value.originalBytes) || Number(value.originalBytes) < 0
    || !Number.isInteger(value.retainedBytes) || Number(value.retainedBytes) < 0
    || !Number.isInteger(value.omittedBytes) || Number(value.omittedBytes) < 0
    || !['size-limit', 'non-serializable', 'sensitive'].includes(String(value.reason))) return undefined
  return {
    truncated: true,
    originalBytes: Number(value.originalBytes),
    retainedBytes: Number(value.retainedBytes),
    omittedBytes: Number(value.omittedBytes),
    reason: value.reason as ContentTruncation['reason'],
  }
}
