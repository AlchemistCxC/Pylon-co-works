// 迁移自 scripts/test-task-domain.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { normalizePlanEntries, EMPTY_PLAN_STATE, type PlanEntry } from '../planTypes.ts'
import { applyPlanEntries } from '../taskStatusMachine.ts'
import { taskCounts, activeTask, taskSummary } from '../taskSelectors.ts'

// P1-01：plan 任务纯域——normalize 容错、全量替换、数组顺序保持、无 id/blockedBy、派生计数

describe('planTypes normalizePlanEntries（迁移自 scripts/test-task-domain.mts，P91 A1）', () => {
  it('合法 entry 收窄；顺序保持；priority 保留（D2）', () => {
    const entries = normalizePlanEntries([
      { content: 'A', status: 'in_progress', priority: 1 },
      { content: 'B', status: 'pending' },
      { content: 'C', status: 'completed', priority: 3 },
    ])
    expect(entries.length).toBe(3)
    expect(entries.map(e => e.content)).toEqual(['A', 'B', 'C']) // 数组顺序必须保持（D2）
    expect(entries[0]?.status).toBe('in_progress')
    expect(entries[0]?.priority).toBe(1)
    expect(entries[2]?.priority).toBe(3)
  })

  it('容错：非数组 → []；缺 content 丢弃；未知 status → unknown；priority 非数字丢弃；非对象项丢弃', () => {
    expect(normalizePlanEntries(null)).toEqual([])
    expect(normalizePlanEntries('x')).toEqual([])
    expect(normalizePlanEntries([{ status: 'in_progress' }])).toEqual([])
    expect(normalizePlanEntries([null, 'str', 42])).toEqual([])
    const entries = normalizePlanEntries([{ content: 'X', status: 'weird-status' }, { content: 'Y', status: 'done', priority: 'high' }])
    expect(entries.length).toBe(2)
    expect(entries[0]?.status).toBe('unknown')
    expect(entries[1]?.status).toBe('unknown')
    expect(entries[1]?.priority).toBeUndefined()
  })
})

describe('taskStatusMachine applyPlanEntries（迁移自 scripts/test-task-domain.mts，P91 A1）', () => {
  it('全量替换语义（D1），空快照清空', () => {
    const initial = applyPlanEntries(EMPTY_PLAN_STATE, [{ content: 'A', status: 'pending' }, { content: 'B', status: 'in_progress' }])
    expect(initial.entries.length).toBe(2)
    // 替换：新快照完全覆盖旧快照（无合并）
    const replaced = applyPlanEntries(initial, [{ content: 'C', status: 'completed' }])
    expect(replaced.entries.map(e => e.content)).toEqual(['C'])
    // 空快照清空
    const cleared = applyPlanEntries(replaced, [])
    expect(cleared.entries).toEqual([])
    expect(applyPlanEntries(replaced, null).entries).toEqual([])
  })

  it('引用稳定：内容深等时返回同一引用（P1-05 版本戳与 React memo 依据）', () => {
    const state = applyPlanEntries(EMPTY_PLAN_STATE, [{ content: 'A', status: 'pending' }])
    const again = applyPlanEntries(state, [{ content: 'A', status: 'pending' }])
    expect(again).toBe(state) // 深等快照必须返回同一引用
    const changed = applyPlanEntries(state, [{ content: 'A', status: 'completed' }])
    expect(changed).not.toBe(state)
  })

  it('replay/live 一致：同输入同输出（确定性）', () => {
    const raw = [{ content: 'A', status: 'pending' }, { content: 'B', status: 'in_progress' }]
    const a = applyPlanEntries(EMPTY_PLAN_STATE, raw)
    const b = applyPlanEntries(EMPTY_PLAN_STATE, raw)
    expect(a).toEqual(b)
  })
})

describe('taskSelectors 派生选择器（迁移自 scripts/test-task-domain.mts，P91 A1）', () => {
  const entries: PlanEntry[] = [
    { content: 'done', status: 'completed' },
    { content: 'running', status: 'in_progress' },
    { content: 'waiting', status: 'pending' },
    { content: 'broken', status: 'failed' },
  ]

  it('taskCounts/activeTask/taskSummary', () => {
    const counts = taskCounts(entries)
    expect(counts).toEqual({ total: 4, pending: 1, inProgress: 1, completed: 1, failed: 1 })
    expect(activeTask(entries)?.content).toBe('running') // activeTask 优先 in_progress
    expect(activeTask([{ content: 'x', status: 'pending' }])?.content).toBe('x')
    expect(activeTask([])).toBeNull()
    expect(taskSummary(entries)).toBe('⇅ 4 任务 · 1 完成')
    expect(taskSummary([])).toBe('⇅ 0 任务')
  })

  it('未知状态计数归 pending（容错不崩）', () => {
    const counts = taskCounts([{ content: 'x', status: 'unknown' }])
    expect(counts.pending).toBe(1)
    expect(counts.total).toBe(1)
  })
})
