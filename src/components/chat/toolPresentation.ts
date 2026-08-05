/**
 * toolPresentation — 兼容层（P1-10）。
 *
 * 渲染字典（KIND_RENDERERS）与统一模型真实定义已迁入 `domains/tool/toolPresentation.ts`；
 * 本文件保留连接线颜色（UI 主题派生，非字典）并转发导出工具展示函数，供既有 import 面使用。
 */

export {
  KIND_RENDERERS,
  TOOL_KINDS,
  buildToolRenderModel,
  contentBlockToDiffPayload,
  getKindToolSummary,
  resolveKindRenderer,
  resolveToolKind,
  type KindRenderer,
  type ToolKind,
  type ToolRenderInput,
  type ToolRenderModel,
} from '../../domains/tool/toolPresentation.ts'

import { getKindToolSummary, resolveKindRenderer, resolveToolKind, type KindRenderer } from '../../domains/tool/toolPresentation.ts'

/** 兼容：按工具名解析渲染器（内部经 kind 归一） */
export function resolveToolRenderer(toolName: string): KindRenderer {
  return resolveKindRenderer(resolveToolKind(toolName))
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

/** 兼容：按工具名取摘要（内部经 kind 归一；Hermes snake_case 不再落 FALLBACK） */
export function getToolSummary(toolName: string, input: unknown): string {
  return getKindToolSummary(toolName, input)
}
