/**
 * EVT-05：shadow compare 与迁移 marker（方案书 §5.10 迁移原则 4/7）。
 *
 * 迁移原则 4：shadow compare 新旧投影。
 * 迁移原则 7：迁移失败保留 raw source 和 marker，可重试。
 *
 * 旧投影 = 迁移源（既有 UI Message——localStorage / MessageRecord 持久化的当前 UI 状态）。
 * 新投影 = 迁移目标（canonical 事件投影，§5.11/EVT-04 ToolProjection）。
 *
 * `shadowCompareToolProjections` 按 toolCallId 配对、逐字段对照（§5.11 验收 9 字段）：
 *   - matched / mismatched（含字段级 diff）
 *   - orphanNew（canonical 有、旧 UI 无——迁移会新增的内容）
 *   - orphanOld（旧 UI 有、canonical 无——迁移会丢失的内容，必须为空才可安全切换）
 * 零 mismatch + 零 orphanOld = canonical 投影无损复现既有 UI。
 *
 * 迁移 marker（原则 7）：`pending → shadow-verified / failed`；失败保留 marker 与错误摘要，
 * retries 递增，可重试。仅当报告无 critical（mismatch/orphanOld 非零）才推进 verified。
 *
 * 纯域模块：仅依赖 EVT-01 eventSchema / EVT-04 toolProjection，零 React/零 store，node 可测。
 */

import type { CanonicalConversationEvent, CanonicalEventOwner } from './eventSchema'
import { projectToolFromCanonical, projectToolFromMessage, type ToolProjectableMessage, type ToolProjection } from './toolProjection'

/** 单字段对照结果（new = canonical 投影，old = 旧 UI Message 投影）。 */
export interface ShadowFieldDiff {
  field: string
  newValue?: unknown
  oldValue?: unknown
}

/** 单条工具消息对照结果。 */
export interface ShadowCompareItem {
  toolCallId: string
  matched: boolean
  diffs: ShadowFieldDiff[]
}

/** 新旧投影对照报告。 */
export interface ShadowCompareReport {
  /** 可配对的 canonical 工具事件数（有 toolCallId 的）。 */
  totalNew: number
  /** 可配对的旧 UI 工具消息数（有 toolCallId 的）。 */
  totalOld: number
  /** 全部字段一致的对数。 */
  matched: number
  /** 存在字段差异的对（含字段级 diff）。 */
  mismatched: ShadowCompareItem[]
  /** canonical 有、旧 UI 无的 toolCallId（迁移会新增）。 */
  orphanNew: string[]
  /** 旧 UI 有、canonical 无的 toolCallId（迁移会丢失——critical）。 */
  orphanOld: string[]
}

/** shadow compare 的会话上下文（owner/generation 为 session/binding 维，两侧同一来源）。 */
export interface ShadowCompareContext {
  owner: CanonicalEventOwner
  clientGeneration: number
}

/** §5.11 验收对照字段（9 项）。 */
const COMPARE_FIELDS = [
  'toolCallId',
  'toolName',
  'kind',
  'rawInput',
  'rawOutput',
  'status',
  'contentBlocks',
  'owner',
  'clientGeneration',
] as const

/** 合并时按字段覆盖的负载字段（toolCallId/owner/generation 为标识/上下文维，不参与合并）。 */
const MERGE_FIELDS = ['toolName', 'kind', 'rawInput', 'rawOutput', 'status', 'contentBlocks'] as const

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(key => deepEqual(aRecord[key], bRecord[key]))
}

/**
 * 工具调用生命周期合并：UI 工具卡是 started → updated/completed/failed 各事件的合并终态，
 * canonical 事件是逐条 append。合并规则：后到事件按字段覆盖（defined 才覆盖，缺失保留早值）。
 */
export function mergeToolProjection(base: ToolProjection, update: ToolProjection): ToolProjection {
  const merged: ToolProjection = { ...base }
  for (const field of MERGE_FIELDS) {
    const value = update[field]
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[field] = value
  }
  return merged
}

/** 逐字段对照两个 ToolProjection，返回字段级 diff（无 diff = 空数组）。 */
export function compareToolProjections(
  newProjection: ToolProjection,
  oldProjection: ToolProjection,
): ShadowFieldDiff[] {
  const diffs: ShadowFieldDiff[] = []
  for (const field of COMPARE_FIELDS) {
    const newValue = newProjection[field]
    const oldValue = oldProjection[field]
    if (!deepEqual(newValue, oldValue)) diffs.push({ field, newValue, oldValue })
  }
  return diffs
}

/**
 * 新旧投影 shadow compare（迁移原则 4）。
 * 输入：canonical 工具事件列表（新 pipeline 产出）与旧 UI 工具消息列表（迁移源），
 * 按 toolCallId 配对，产出配对/孤儿/字段 diff 报告。
 */
export function shadowCompareToolProjections(
  newEvents: readonly CanonicalConversationEvent[],
  oldMessages: readonly ToolProjectableMessage[],
  context: ShadowCompareContext,
): ShadowCompareReport {
  // 新 pipeline：同一 toolCallId 的生命周期事件（started→updated/completed/failed）合并为最终投影
  // ——与 UI 工具卡一致（UI 是生命周期合并终态，canonical 是逐条 append）。
  const newProjections = new Map<string, ToolProjection>()
  for (const event of newEvents) {
    const projection = projectToolFromCanonical(event)
    if (!projection?.toolCallId) continue
    const existing = newProjections.get(projection.toolCallId)
    newProjections.set(projection.toolCallId, existing ? mergeToolProjection(existing, projection) : projection)
  }
  const oldProjections = new Map<string, ToolProjection>()
  for (const message of oldMessages) {
    const projection = projectToolFromMessage(message, context.owner, context.clientGeneration)
    if (!projection?.toolCallId) continue
    oldProjections.set(projection.toolCallId, projection)
  }

  let matched = 0
  const mismatched: ShadowCompareItem[] = []
  for (const [toolCallId, newProjection] of newProjections) {
    const oldProjection = oldProjections.get(toolCallId)
    if (!oldProjection) continue // 孤儿在下方统一统计
    const diffs = compareToolProjections(newProjection, oldProjection)
    if (diffs.length === 0) {
      matched += 1
    } else {
      mismatched.push({ toolCallId, matched: false, diffs })
    }
  }
  const orphanNew = [...newProjections.keys()].filter(id => !oldProjections.has(id))
  const orphanOld = [...oldProjections.keys()].filter(id => !newProjections.has(id))
  return {
    totalNew: newProjections.size,
    totalOld: oldProjections.size,
    matched,
    mismatched,
    orphanNew,
    orphanOld,
  }
}

/** 迁移 marker 状态（原则 7：失败保留 marker，可重试）。 */
export type MigrationMarkerStatus = 'pending' | 'shadow-verified' | 'failed'

export interface MigrationMarker {
  status: MigrationMarkerStatus
  /** 最近一次 shadow compare 通过时间（ISO）。 */
  verifiedAt?: string
  /** 最近一次失败时间（ISO）。 */
  failedAt?: string
  /** 失败原因摘要（mismatch/orphanOld 计数）。 */
  error?: string
  /** 重试计数（失败保留 marker，可重试）。 */
  retries: number
}

export function createMigrationMarker(): MigrationMarker {
  return { status: 'pending', retries: 0 }
}

/** 报告是否含迁移 critical（字段不一致或旧 UI 会丢失）。 */
export function isShadowCompareCritical(report: ShadowCompareReport): boolean {
  return report.mismatched.length > 0 || report.orphanOld.length > 0
}

/**
 * 依 shadow compare 结果推进迁移 marker（迁移原则 7）。
 * critical（mismatch/orphanOld 非零）→ failed 且 retries 递增（保留 marker 可重试）；
 * 否则 → shadow-verified。
 */
export function recordMigrationResult(
  marker: MigrationMarker,
  report: ShadowCompareReport,
  now = new Date().toISOString(),
): MigrationMarker {
  if (!isShadowCompareCritical(report)) {
    return { ...marker, status: 'shadow-verified', verifiedAt: now, error: undefined }
  }
  return {
    ...marker,
    status: 'failed',
    failedAt: now,
    error: `mismatch=${report.mismatched.length} orphanOld=${report.orphanOld.length}`,
    retries: marker.retries + 1,
  }
}
