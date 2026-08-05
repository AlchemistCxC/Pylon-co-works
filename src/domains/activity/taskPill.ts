/**
 * taskPill — 任务 pill 文案/显隐纯推导（P1-02）。
 *
 * 消费方是 tasks widget（ControlCenter，§8.2）：有 plan（total>0）才渲染，无任务
 * 返回 visible:false（组件返回 null）。文案复用 taskSummary（domains/tasks 单一真值）。
 */

import type { PlanEntry } from '../tasks/planTypes.ts'
import { taskCounts, taskSummary } from '../tasks/taskSelectors.ts'

export interface TaskPill {
  visible: boolean
  label: string
}

export function resolveTaskPill(entries: PlanEntry[]): TaskPill {
  if (taskCounts(entries).total === 0) return { visible: false, label: '' }
  return { visible: true, label: taskSummary(entries) }
}
