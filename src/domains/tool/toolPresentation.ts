/**
 * toolPresentation — 协议化工具渲染字典（P1-10，D19 §5.3）。
 *
 * 按语义 kind（read/edit/execute/search/fetch/think/other）而非工具名硬编码：
 * Peri PascalCase（Bash/Read/Edit/…）与 Hermes snake_case（read_file/terminal/…）
 * 经 resolveToolKind 归一为同一 kind，不再按名字碰运气落 FALLBACK。
 * title 直通（name 即标题）；contentBlocks 按 type 消费（tool_diff_content → DiffPayload，
 * snake_case 兼容）；文本启发式保留（other 回退扫描输入字段）；未知 kind/type 不抛错。
 */

import { diffPayloadFromObject, type DiffPayload } from './diffPresentation.ts'
import type { ContentBlock } from '../../infrastructure/acp/chatContracts.ts'

export type ToolKind = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other'

export interface KindRenderer {
  /** 输入 → 摘要（"title 直通或 {path|command|…}"） */
  getSummary(input: unknown): string
  /** 输出 → 搜索文本（工具结果全文检索用；当前无实现，缺省 undefined） */
  getSearchText?(output: unknown): string
  /** 输出行数标签（如 "N matches" / "N lines changed"），缺省回退通用行数 */
  outputLabel?(outputLines: number, output: string): string
  /** 输出是否可渲染的结构化 diff（默认按 kind + 非空输出判定） */
  isDiffCandidate?(output: string): boolean
}

const firstString = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === 'string' && value.length > 0) || ''

function objectInput(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
}

function fieldSummary(...fields: string[]) {
  // 对象输入取字段；字符串输入直通（持久化 Message 的 toolInput 即摘要字符串）
  return (input: unknown) => firstString(...fields.map(field => objectInput(input)[field]))
    || (typeof input === 'string' ? input : '')
}

const linesLabel = (outputLines: number, _output: string) => outputLines <= 0 ? '' : `${outputLines} lines`
const matchesLabel = (outputLines: number, _output: string) => outputLines <= 0 ? '' : `${outputLines} matches`
const linesChangedLabel = (outputLines: number, _output: string) => outputLines <= 0 ? '' : `${outputLines} lines changed`
const diffCandidate = (output: string) => output.length > 0 && diffPayloadFromObjectOrText(output) !== null

function diffPayloadFromObjectOrText(output: string): DiffPayload | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const fromObject = diffPayloadFromObject(parsed)
    if (fromObject) return fromObject
  } catch { /* 普通文本 */ }
  return fromUnifiedDiffHeuristic(output)
}

function fromUnifiedDiffHeuristic(text: string): DiffPayload | null {
  return /^---\s/m.test(text) && /^\+\+\+\s/m.test(text) ? { oldText: '', newText: '', lines: [] } : null
}

const OTHER_FALLBACK_RENDERER: KindRenderer = {
  getSummary: input => {
    for (const value of Object.values(objectInput(input))) {
      if (typeof value === 'string' && value.length > 0 && value.length < 200) return value
    }
    return typeof input === 'string' ? input.slice(0, 80) : ''
  },
}

export const KIND_RENDERERS: Record<ToolKind, KindRenderer> = {
  read: {
    getSummary: fieldSummary('path', 'file_path', 'filePath'),
    outputLabel: linesLabel,
  },
  edit: {
    getSummary: fieldSummary('path', 'file_path', 'filePath'),
    outputLabel: linesChangedLabel,
    isDiffCandidate: diffCandidate,
  },
  execute: {
    getSummary: fieldSummary('command', 'cmd'),
    outputLabel: linesLabel,
  },
  search: {
    getSummary: fieldSummary('pattern', 'regex', 'glob'),
    outputLabel: matchesLabel,
  },
  fetch: {
    getSummary: fieldSummary('url', 'uri', 'href'),
    outputLabel: linesLabel,
  },
  think: {
    getSummary: () => '',
    outputLabel: linesLabel,
  },
  other: OTHER_FALLBACK_RENDERER,
}

export const TOOL_KINDS: readonly ToolKind[] = Object.keys(KIND_RENDERERS) as ToolKind[]

/** kind 解析：显式 toolKind 优先（合法才用），否则按工具名启发式（大小写不敏感） */
export function resolveToolKind(name: string, toolKind?: string): ToolKind {
  if (toolKind && toolKind in KIND_RENDERERS) return toolKind as ToolKind
  const normalized = name.toLowerCase()
  if (/read|view/.test(normalized)) return 'read'
  if (/edit|write|patch/.test(normalized)) return 'edit'
  if (/bash|terminal|shell|exec|run|command/.test(normalized)) return 'execute'
  if (/grep|glob|search|find/.test(normalized)) return 'search'
  if (/fetch|http|url|request/.test(normalized)) return 'fetch'
  if (/think/.test(normalized)) return 'think'
  return 'other'
}

export function resolveKindRenderer(kind: ToolKind): KindRenderer {
  return KIND_RENDERERS[kind] || OTHER_FALLBACK_RENDERER
}

export function getKindToolSummary(name: string, input: unknown, toolKind?: string): string {
  return resolveKindRenderer(resolveToolKind(name, toolKind)).getSummary(input)
}

/** tool_diff_content 内容块 → DiffPayload（camel/snake 兼容）；非 diff 块返回 null */
export function contentBlockToDiffPayload(block: ContentBlock): DiffPayload | null {
  if (block.type !== 'tool_diff_content') return null
  return diffPayloadFromObject(block)
}

export interface ToolRenderModel {
  kind: ToolKind
  name: string
  summary: string
  outputLabel: string
  isDiffCandidate: boolean
  /** contentBlocks 携带的结构化 diff（tool_diff_content）；无则 null */
  diffPayload: DiffPayload | null
  hasDiffContentBlock: boolean
}

export interface ToolRenderInput {
  /** 工具标题（直通展示） */
  name: string
  toolKind?: string
  /** 原始输入（tool_call rawInput 或字符串） */
  input?: unknown
  /** 输出文本 */
  output?: string
  contentBlocks?: ContentBlock[]
}

/** 三份 wire mock 统一渲染模型：kind 归一、title 直通、contentBlocks 按 type、未知不抛错 */
export function buildToolRenderModel(tool: ToolRenderInput): ToolRenderModel {
  const kind = resolveToolKind(tool.name, tool.toolKind)
  const renderer = resolveKindRenderer(kind)
  const output = tool.output ?? ''
  const diffBlock = tool.contentBlocks?.find(block => block.type === 'tool_diff_content')
  const diffPayload = diffBlock ? contentBlockToDiffPayload(diffBlock) : null
  const outputLines = output ? output.split('\n').filter(line => line.trim().length > 0).length : 0
  return {
    kind,
    name: tool.name || '未知工具',
    summary: renderer.getSummary(tool.input) || tool.name,
    outputLabel: renderer.outputLabel ? renderer.outputLabel(outputLines, output) : (outputLines <= 0 ? '' : `${outputLines} lines`),
    isDiffCandidate: diffPayload !== null || (renderer.isDiffCandidate ? renderer.isDiffCandidate(output) : false),
    diffPayload,
    hasDiffContentBlock: diffBlock !== undefined,
  }
}
