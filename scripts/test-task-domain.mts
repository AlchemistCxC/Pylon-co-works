import { strict as assert } from 'node:assert'
import { normalizePlanEntries, EMPTY_PLAN_STATE, type PlanEntry } from '../src/domains/tasks/planTypes.ts'
import { applyPlanEntries } from '../src/domains/tasks/taskStatusMachine.ts'
import { taskCounts, activeTask, taskSummary } from '../src/domains/tasks/taskSelectors.ts'

// P1-01：plan 任务纯域——normalize 容错、全量替换、数组顺序保持、无 id/blockedBy、派生计数

// 1. normalize：合法 entry 收窄；顺序保持；priority 保留
{
  const entries = normalizePlanEntries([
    { content: 'A', status: 'in_progress', priority: 1 },
    { content: 'B', status: 'pending' },
    { content: 'C', status: 'completed', priority: 3 },
  ])
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(e => e.content), ['A', 'B', 'C'], '数组顺序必须保持（D2）')
  assert.equal(entries[0]?.status, 'in_progress')
  assert.equal(entries[0]?.priority, 1)
  assert.equal(entries[2]?.priority, 3)
}

// 2. normalize 容错：非数组 → []；缺 content 丢弃；未知 status → 'unknown'；priority 非数字丢弃；非对象项丢弃
assert.deepEqual(normalizePlanEntries(null), [])
assert.deepEqual(normalizePlanEntries('x'), [])
assert.deepEqual(normalizePlanEntries([{ status: 'in_progress' }]), [])
assert.deepEqual(normalizePlanEntries([null, 'str', 42]), [])
{
  const entries = normalizePlanEntries([{ content: 'X', status: 'weird-status' }, { content: 'Y', status: 'done', priority: 'high' }])
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.status, 'unknown')
  assert.equal(entries[1]?.status, 'unknown')
  assert.equal(entries[1]?.priority, undefined)
}

// 3. applyPlanEntries：全量替换语义（D1），空快照清空
{
  const initial = applyPlanEntries(EMPTY_PLAN_STATE, [{ content: 'A', status: 'pending' }, { content: 'B', status: 'in_progress' }])
  assert.equal(initial.entries.length, 2)
  // 替换：新快照完全覆盖旧快照（无合并）
  const replaced = applyPlanEntries(initial, [{ content: 'C', status: 'completed' }])
  assert.deepEqual(replaced.entries.map(e => e.content), ['C'])
  // 空快照清空
  const cleared = applyPlanEntries(replaced, [])
  assert.deepEqual(cleared.entries, [])
  assert.deepEqual(applyPlanEntries(replaced, null).entries, [])
}

// 4. 引用稳定：内容深等时返回同一引用（P1-05 版本戳与 React memo 依据）
{
  const state = applyPlanEntries(EMPTY_PLAN_STATE, [{ content: 'A', status: 'pending' }])
  const again = applyPlanEntries(state, [{ content: 'A', status: 'pending' }])
  assert.equal(again, state, '深等快照必须返回同一引用')
  const changed = applyPlanEntries(state, [{ content: 'A', status: 'completed' }])
  assert.notEqual(changed, state)
}

// 5. replay/live 一致：同输入同输出（确定性）
{
  const raw = [{ content: 'A', status: 'pending' }, { content: 'B', status: 'in_progress' }]
  const a = applyPlanEntries(EMPTY_PLAN_STATE, raw)
  const b = applyPlanEntries(EMPTY_PLAN_STATE, raw)
  assert.deepEqual(a, b)
}

// 6. 派生选择器
{
  const entries: PlanEntry[] = [
    { content: 'done', status: 'completed' },
    { content: 'running', status: 'in_progress' },
    { content: 'waiting', status: 'pending' },
    { content: 'broken', status: 'failed' },
  ]
  const counts = taskCounts(entries)
  assert.deepEqual(counts, { total: 4, pending: 1, inProgress: 1, completed: 1, failed: 1 })
  assert.equal(activeTask(entries)?.content, 'running', 'activeTask 优先 in_progress')
  assert.equal(activeTask([{ content: 'x', status: 'pending' }])?.content, 'x')
  assert.equal(activeTask([]), null)
  assert.equal(taskSummary(entries), '⇅ 4 任务 · 1 完成')
  assert.equal(taskSummary([]), '⇅ 0 任务')
}

// 7. 未知状态计数归 pending（容错不崩）
{
  const counts = taskCounts([{ content: 'x', status: 'unknown' }])
  assert.equal(counts.pending, 1)
  assert.equal(counts.total, 1)
}

console.log('task domain 守卫通过')
