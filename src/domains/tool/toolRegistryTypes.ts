/**
 * toolRegistryTypes — 工具注册表公共形状（叶子类型模块，零 import）。
 *
 * 自 toolRegistry.ts 抽出：agentCatalog 等下游只依赖类型时引本文件，
 * 消除 agent⇄tool 域的文件级 import 环（结构审查 B-5）。
 */
import type { ToolAction, ToolKind } from './toolKinds.ts'

export interface ToolRegistryEntry {
  provider: string
  name: string
  aliases?: readonly string[]
  displayName?: string
  kind: ToolKind
  action: ToolAction
  summaryFields?: readonly string[]
  outputLabel?: 'lines' | 'matches' | 'changed-lines'
  capabilities?: readonly string[]
}

export interface ToolRegistryOverlay {
  upsert?: unknown
  remove?: unknown
  aliases?: unknown
}
