import { normalizeDiffPayload } from './diffPresentation.ts'

export interface ToolRenderer {
  getSummary(input: unknown): string
  getSearchText?(output: unknown): string
  normalizeInput?(input: unknown): unknown
  /** 输出行数标签（如 "N matches" / "N lines changed"），缺省回退通用行数 */
  outputLabel?(outputLines: number, output: string): string
  /** 输出是否为可渲染的结构化 diff，缺省按工具名 + 非空输出判定 */
  isDiffCandidate?(output: string): boolean
}

const firstString = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === 'string' && value.length > 0) || ''

function objectInput(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
}

function fieldSummary(...fields: string[]) {
  return (input: unknown) => firstString(...fields.map(field => objectInput(input)[field]))
}

const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  Bash: {
    getSummary: fieldSummary('command', 'cmd'),
    outputLabel: (outputLines, _output) => outputLines <= 0 ? '' : `${outputLines} lines`,
  },
  Read: {
    getSummary: fieldSummary('path', 'file_path', 'filePath'),
    outputLabel: (outputLines, _output) => outputLines <= 0 ? '' : `${outputLines} lines`,
  },
  Write: {
    getSummary: fieldSummary('path', 'file_path', 'filePath'),
    outputLabel: (outputLines, _output) => outputLines <= 0 ? '' : `${outputLines} lines changed`,
    isDiffCandidate: output => output.length > 0 && normalizeDiffPayload(output) !== null,
  },
  Edit: {
    getSummary: fieldSummary('path', 'file_path', 'filePath'),
    outputLabel: (outputLines, _output) => outputLines <= 0 ? '' : `${outputLines} lines changed`,
    isDiffCandidate: output => output.length > 0 && normalizeDiffPayload(output) !== null,
  },
  Grep: {
    getSummary: fieldSummary('pattern', 'regex', 'glob'),
    outputLabel: (outputLines, _output) => outputLines <= 0 ? '' : `${outputLines} matches`,
  },
  Glob: {
    getSummary: fieldSummary('pattern', 'regex', 'glob'),
    outputLabel: (outputLines, _output) => outputLines <= 0 ? '' : `${outputLines} matches`,
  },
  Task: {
    getSummary: fieldSummary('description', 'prompt', 'goal'),
  },
}

const FALLBACK_RENDERER: ToolRenderer = {
  getSummary: input => {
    for (const value of Object.values(objectInput(input))) {
      if (typeof value === 'string' && value.length > 0 && value.length < 200) return value
    }
    return typeof input === 'string' ? input.slice(0, 80) : ''
  },
}

export function resolveToolRenderer(toolName: string): ToolRenderer {
  return TOOL_RENDERERS[toolName] || FALLBACK_RENDERER
}

export function getToolSummary(toolName: string, input: unknown): string {
  return resolveToolRenderer(toolName).getSummary(input)
}

export type ToolConnectorStatus = 'ok' | 'err' | 'run'

export interface ConnectorColors {
  toolOk?: string
  toolRun?: string
  toolErr?: string
}

/**
 * 连接线颜色：none=透明；follow=跟随传入工具状态色（ok/err/run 用主题变量）；
 * 调用方传入连接线上一个 Tool 的状态，fixed=固定 connectorColor。
 */
export function resolveConnectorColor(
  mode: string,
  status: ToolConnectorStatus,
  colors: ConnectorColors,
  fallback: string,
): string {
  if (mode === 'none') return 'transparent'
  if (mode === 'follow') {
    return (status === 'ok' ? colors.toolOk : status === 'err' ? colors.toolErr : colors.toolRun) || fallback
  }
  return fallback
}

export const TOOL_RENDERER_NAMES = Object.freeze(Object.keys(TOOL_RENDERERS))
