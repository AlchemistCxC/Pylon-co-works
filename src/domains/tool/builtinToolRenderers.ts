import { diffPayloadFromObject } from './diffPresentation.ts'
import type { ToolKind } from './toolKinds.ts'
import type { ToolRenderer } from '../../plugin-runtime/renderers/rendererTypes.ts'

const firstString = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === 'string' && value.length > 0) || ''

function objectInput(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
}

function fieldSummary(...fields: string[]) {
  return (input: unknown) => firstString(...fields.map(field => objectInput(input)[field]))
    || (typeof input === 'string' ? input : '')
}

const linesLabel = (outputLines: number) => outputLines <= 0 ? '' : `${outputLines} lines`
const matchesLabel = (outputLines: number) => outputLines <= 0 ? '' : `${outputLines} matches`
const linesChangedLabel = (outputLines: number) => outputLines <= 0 ? '' : `${outputLines} lines changed`

function diffCandidate(output: string): boolean {
  const trimmed = output.trim()
  if (!trimmed) return false
  try {
    if (diffPayloadFromObject(JSON.parse(trimmed) as unknown)) return true
  } catch { /* 普通文本 */ }
  return /^---\s/m.test(output) && /^\+\+\+\s/m.test(output)
}

export const SAFE_TOOL_RENDERER: ToolRenderer = {
  getSummary: input => {
    for (const value of Object.values(objectInput(input))) {
      if (typeof value === 'string' && value.length > 0 && value.length < 200) return value
    }
    return typeof input === 'string' ? input.slice(0, 80) : ''
  },
}

/** 第一方工具渲染贡献的单一定义源；激活后进入 Renderer Registry。 */
export const BUILTIN_TOOL_RENDERERS: Readonly<Record<ToolKind, ToolRenderer>> = {
  read: { getSummary: fieldSummary('path', 'file_path', 'filePath'), outputLabel: linesLabel },
  edit: {
    getSummary: fieldSummary('path', 'file_path', 'filePath'),
    outputLabel: linesChangedLabel,
    isDiffCandidate: diffCandidate,
  },
  execute: { getSummary: fieldSummary('command', 'cmd'), outputLabel: linesLabel },
  search: { getSummary: fieldSummary('pattern', 'regex', 'glob'), outputLabel: matchesLabel },
  fetch: { getSummary: fieldSummary('url', 'uri', 'href'), outputLabel: linesLabel },
  think: { getSummary: () => '', outputLabel: linesLabel },
  other: SAFE_TOOL_RENDERER,
}

