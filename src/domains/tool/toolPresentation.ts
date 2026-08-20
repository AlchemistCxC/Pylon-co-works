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
import { resolveToolType, resolveToolKind, splitToolTitle } from './toolResolution.ts'
import type { ToolAction, ToolKind, ToolResolution } from './toolKinds.ts'
import { SAFE_TOOL_RENDERER } from './builtinToolRenderers.ts'
import { getRendererRegistry } from '../../plugin-runtime/runtimeServices.ts'
import type { ToolRenderer as KindRenderer } from '../../plugin-runtime/renderers/rendererTypes.ts'
export { resolveToolType, resolveToolKind } from './toolResolution.ts'
export { TOOL_KINDS, type ToolAction, type ToolKind, type ToolProvider, type ToolMatch, type ToolResolution } from './toolKinds.ts'

export type { ToolRenderer as KindRenderer } from '../../plugin-runtime/renderers/rendererTypes.ts'

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
const OUTPUT_LABEL_RENDERERS: Record<'lines' | 'matches' | 'changed-lines', (outputLines: number, output: string) => string> = {
  lines: linesLabel,
  matches: matchesLabel,
  'changed-lines': linesChangedLabel,
}
export function resolveKindRenderer(kind: ToolKind, input?: unknown, name = '', output = ''): KindRenderer {
  return getRendererRegistry().resolveToolRenderer({ kind, name, input, output })?.value.renderer
    ?? SAFE_TOOL_RENDERER
}

export function getKindToolSummary(name: string, input: unknown, toolKind?: string): string {
  return resolveKindRenderer(resolveToolKind(name, toolKind)).getSummary(input)
}

/** 兼容：按工具名解析渲染器（内部经 kind 归一）。 */
export function resolveToolRenderer(toolName: string): KindRenderer {
  return resolveKindRenderer(resolveToolKind(toolName), undefined, toolName)
}

/** 兼容：按工具名取摘要（内部经 kind 归一；Hermes snake_case 不再落 FALLBACK） */
export function getToolSummary(toolName: string, input: unknown): string {
  return getKindToolSummary(toolName, input)
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

/** tool_diff_content 内容块 → DiffPayload（camel/snake 兼容）；非 diff 块返回 null */
export function contentBlockToDiffPayload(block: ContentBlock): DiffPayload | null {
  if (block.type !== 'tool_diff_content') return null
  return diffPayloadFromObject(block)
}

export interface ToolRenderModel {
  kind: ToolKind
  action: ToolAction
  resolution: ToolResolution
  name: string
  summary: string
  outputLabel: string
  isDiffCandidate: boolean
  /** contentBlocks 携带的结构化 diff（tool_diff_content）；无则 null */
  diffPayload: DiffPayload | null
  hasDiffContentBlock: boolean
  /** P0-2：owner AgentContext 的 agentId（trace/调试用；缺省无） */
  agentId?: string
}

export interface ToolRenderInput {
  /** 工具标题（直通展示） */
  name: string
  /** ACP wire kind（可选；存在时优先于名称字典） */
  toolKind?: string
  /** P0-2：owner AgentContext 的 agentId（trace/调试用） */
  agentId?: string
  /** P0-2：owner agent 解析出的 provider；存在时优先 provider-scoped registry，不按名称猜 */
  provider?: string
  /** 原始输入（tool_call rawInput 或字符串） */
  input?: unknown
  /** 输出文本 */
  output?: string
  contentBlocks?: ContentBlock[]
}

/** 三份 wire mock 统一渲染模型：kind 归一、title 直通、contentBlocks 按 type、未知不抛错 */
export function buildToolRenderModel(tool: ToolRenderInput): ToolRenderModel {
  const resolution = resolveToolType(tool.name, tool.toolKind, tool.provider ? { provider: tool.provider } : undefined)
  const kind = resolution.kind
  const renderer = resolveKindRenderer(kind, tool.input, tool.name, tool.output)
  const output = tool.output ?? ''
  const diffBlock = tool.contentBlocks?.find(block => block.type === 'tool_diff_content')
  const diffPayload = diffBlock ? contentBlockToDiffPayload(diffBlock) : null
  const outputLines = output ? output.split('\n').filter(line => line.trim().length > 0).length : 0
  const summaryFields = resolution.summaryFields && resolution.summaryFields.length > 0
    ? resolution.summaryFields
    : undefined
  let summary = resolution.embeddedSummary
    ? resolution.embeddedSummary
    : summaryFields
      ? fieldSummary(...summaryFields)(tool.input)
      : renderer.getSummary(tool.input)
  let name = resolution.displayName || tool.name || '未知工具'
  // 兜底：未命中注册表（fallback/alias）且 input 为空时，摘要不能回退成整串标题
  // （会把参数留在 term-tool-name 并继承其颜色）；改为从标题拆分参数。
  if (!summary) {
    const title = splitToolTitle(name)
    if (title.summary) {
      name = title.name || name
      summary = title.summary
    }
  }
  const outputLabel = resolution.outputLabel
    ? OUTPUT_LABEL_RENDERERS[resolution.outputLabel](outputLines, output)
    : renderer.outputLabel ? renderer.outputLabel(outputLines, output) : (outputLines <= 0 ? '' : `${outputLines} lines`)
  return {
    kind,
    action: resolution.action,
    resolution,
    name,
    summary,
    outputLabel,
    isDiffCandidate: diffPayload !== null || (renderer.isDiffCandidate ? renderer.isDiffCandidate(output) : false),
    diffPayload,
    hasDiffContentBlock: diffBlock !== undefined,
    ...(tool.agentId ? { agentId: tool.agentId } : {}),
  }
}
