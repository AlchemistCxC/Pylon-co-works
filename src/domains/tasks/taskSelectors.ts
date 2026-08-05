/**
 * taskSelectors — plan 派生选择器（P1-01，D3 派生不进状态）。
 *
 * 全部从 entries 纯推导：activeTask（当前焦点）、taskCounts（计数）、taskSummary
 * （tasks widget pill 文案「⇅ N 任务」）。消费方是 GenerationFooter（活动行）与
 * tasks widget（ControlCenter）。
 */

import type { PlanEntry } from './planTypes.ts'

export interface TaskCounts {
  total: number
  pending: number
  inProgress: number
  completed: number
  failed: number
}

export function taskCounts(entries: PlanEntry[]): TaskCounts {
  const counts: TaskCounts = { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 }
  for (const entry of entries) {
    counts.total += 1
    switch (entry.status) {
      case 'in_progress':
        counts.inProgress += 1
        break
      case 'completed':
        counts.completed += 1
        break
      case 'failed':
      case 'cancelled':
        counts.failed += 1
        break
      default:
        // pending 与未知状态统一归 pending（中性展示，不崩）
        counts.pending += 1
    }
  }
  return counts
}

/** 当前焦点任务：第一个 in_progress；无则第一个 pending；否则 null */
export function activeTask(entries: PlanEntry[]): PlanEntry | null {
  return entries.find(entry => entry.status === 'in_progress')
    ?? entries.find(entry => entry.status === 'pending' || entry.status === 'unknown')
    ?? null
}

/** pill 文案：「⇅ N 任务」，有完成进度时附「· M 完成」 */
export function taskSummary(entries: PlanEntry[]): string {
  const counts = taskCounts(entries)
  const base = `⇅ ${counts.total} 任务`
  return counts.completed > 0 ? `${base} · ${counts.completed} 完成` : base
}
