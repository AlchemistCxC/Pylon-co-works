/**
 * planTypes — plan 任务域 wire 收窄（P1-01，D1-D4）。
 *
 * D1：plan 事件 = 全量快照替换（reducer 无 diff/合并）。
 * D2：不引入 id / blockedBy——协议没有，渲染不做假设；排序 = 数组顺序 = 模型写入顺序。
 * D3：完成节奏不进状态（派生不进状态）；完成动画由组件层监听 entries 前后对比触发。
 * D4：tasks 进会话运行时（sessionRuntimeStore），不进全局统计。
 */

export const PLAN_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export interface PlanEntry {
  content: string
  priority?: number
  /** 未知状态容错：normalize 保留 'unknown'，渲染中性处理，不崩 */
  status: PlanStatus | 'unknown'
}

export interface PlanState {
  entries: PlanEntry[]
}

export const EMPTY_PLAN_STATE: PlanState = { entries: [] }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** wire entries 容错收窄：非数组 → []；缺 content 丢弃；未知 status → 'unknown'；priority 仅数字保留 */
export function normalizePlanEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: PlanEntry[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const content = typeof item.content === 'string' ? item.content : ''
    if (!content) continue
    const status = typeof item.status === 'string' && (PLAN_STATUSES as readonly string[]).includes(item.status)
      ? item.status as PlanStatus
      : 'unknown'
    const priority = typeof item.priority === 'number' ? item.priority : undefined
    entries.push(priority === undefined ? { content, status } : { content, status, priority })
  }
  return entries
}
