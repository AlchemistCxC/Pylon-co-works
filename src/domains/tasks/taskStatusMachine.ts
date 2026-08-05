/**
 * taskStatusMachine — plan 纯 reducer（P1-01，D1）。
 *
 * applyPlanEntries：全量替换语义——wire 每次都是完整 entries，无 diff/合并；
 * 空快照（entries:[]）即清空。内容与现状深等时返回同一引用（供 P1-05 横向版本戳
 * 与 React memo 判断"无变化"），replay 与 live 输入一致输出一致。
 */

import { normalizePlanEntries, type PlanEntry, type PlanState } from './planTypes.ts'

function entriesEqual(a: PlanEntry, b: PlanEntry): boolean {
  return a.content === b.content && a.status === b.status && a.priority === b.priority
}

export function applyPlanEntries(state: PlanState, raw: unknown): PlanState {
  const entries = normalizePlanEntries(raw)
  if (state.entries.length === entries.length && state.entries.every((entry, index) => entriesEqual(entry, entries[index]))) {
    return state
  }
  return { entries }
}
