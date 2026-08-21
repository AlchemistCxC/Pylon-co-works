import { describe, expect, it } from 'vitest'
import {
  GOAL_STATUSES,
  PLAN_ENTRY_STATUSES,
  applyPlanEvent,
  applyGoalEvents,
  createEmptyPlanState,
  createEmptyGoalState,
  normalizeGoalSnapshot,
  normalizePlanEntries,
  type GoalSnapshot,
} from '../goalModel.ts'

describe('plan/goal domain model (C08)', () => {
  it('keeps all five plan entry statuses without collapsing cancelled into completed', () => {
    const entries = normalizePlanEntries([
      { id: 't1', content: '读取文件', status: 'completed' },
      { id: 't2', content: '编辑配置', status: 'in_progress', activeForm: '正在编辑配置' },
      { id: 't3', content: '验证结果', status: 'pending' },
      { content: '用户取消项', status: 'cancelled' },
      { content: '被阻塞项', status: 'blocked', blockedReason: '等待审批' },
      { content: '未来状态', status: 'queued_by_future_provider', priority: 3 },
    ])
    expect(entries.map(entry => entry.status)).toEqual(['completed', 'in_progress', 'pending', 'cancelled', 'blocked', 'unknown'])
    expect(PLAN_ENTRY_STATUSES).toEqual(['pending', 'in_progress', 'completed', 'cancelled', 'blocked'])
    // unknown 状态保留 provider raw，不得静默丢弃
    expect(entries[5]).toMatchObject({ status: 'unknown', rawStatus: 'queued_by_future_provider', priority: 3 })
    expect(entries[1]).toMatchObject({ activeForm: '正在编辑配置' })
    expect(entries[4]).toMatchObject({ blockedReason: '等待审批' })
  })

  it('patches entries by stable item id and tolerates parent-late reorder with terminal idempotence', () => {
    let state = createEmptyPlanState('session-1')
    state = applyPlanEvent(state, { type: 'plan.replaced', entries: [
      { id: 'a', content: '第一步', status: 'completed' },
      { id: 'b', content: '第二步', status: 'in_progress' },
    ] })
    // entry patch 按 stable id 定位，不按下标覆盖
    state = applyPlanEvent(state, { type: 'plan.entry-updated', entry: { id: 'b', content: '第二步（修订）', status: 'blocked', blockedReason: '缺权限' } })
    expect(state.entries.find(entry => entry.id === 'b')).toMatchObject({ status: 'blocked', blockedReason: '缺权限' })
    // reorder：全量替换保持 provider 顺序
    state = applyPlanEvent(state, { type: 'plan.replaced', entries: [
      { id: 'b', content: '第二步（修订）', status: 'blocked', blockedReason: '缺权限' },
      { id: 'a', content: '第一步', status: 'completed' },
    ] })
    expect(state.entries.map(entry => entry.id)).toEqual(['b', 'a'])
    // 终态幂等：同内容深等返回同一引用
    const before = state
    state = applyPlanEvent(state, { type: 'plan.replaced', entries: [
      { id: 'b', content: '第二步（修订）', status: 'blocked', blockedReason: '缺权限' },
      { id: 'a', content: '第一步', status: 'completed' },
    ] })
    expect(state).toBe(before)
    // 无 id 的条目按 content 兜底身份
    state = applyPlanEvent(state, { type: 'plan.entry-updated', entry: { content: '第一步', status: 'cancelled' } })
    expect(state.entries.find(entry => entry.content === '第一步')?.status).toBe('cancelled')
  })

  it('models goal separately from todo with objective, budget and blocked reason', () => {
    let goal = createEmptyGoalState()
    goal = applyGoalEvents(goal, { type: 'goal.updated', goal: {
      goalId: 'g-1',
      objective: '完成渲染引擎',
      status: 'active',
      tokenBudget: 100000,
      tokensUsed: 4200,
    } satisfies Partial<GoalSnapshot> as unknown as JsonValueShape })
    expect(goal.current).toMatchObject({ goalId: 'g-1', status: 'active', tokenBudget: 100000 })
    goal = applyGoalEvents(goal, { type: 'goal.updated', goal: { goalId: 'g-1', status: 'blocked', blockedReason: '预算耗尽' } })
    expect(goal.current).toMatchObject({ status: 'blocked', blockedReason: '预算耗尽', objective: '完成渲染引擎' })
    goal = applyGoalEvents(goal, { type: 'goal.cleared', goalId: 'g-1' })
    expect(goal.current).toBeUndefined()
    expect(GOAL_STATUSES).toEqual(['active', 'complete', 'blocked'])
  })

  it('preserves malformed or future goal shapes as visible unknown instead of dropping', () => {
    const parsed = normalizeGoalSnapshot({ objective: '神秘目标', phase: 7, nested: { deep: true } })
    // 已知字段照常收窄；未知字段进 metadata 且不丢 raw
    expect(parsed).toMatchObject({ objective: '神秘目标', status: 'unknown' })
    expect(parsed?.metadata).toMatchObject({ phase: 7, nested: { deep: true } })
    // status 无法收窄为三状态时保留 unknown；raw 拼写经 metadata 可见
    expect(parsed?.status).toBe('unknown')
  })

  it('normalizes provider status spellings losslessly including hermes/cancelled variants', () => {
    const entries = normalizePlanEntries([
      { content: 'A', status: 'CANCELLED' },
      { content: 'B', status: 'in-progress' },
      { content: 'C', status: 'done' },
      // killed 是 Claude Task 语义（总纲 4.6：killed 映射 cancelled 并保留 raw）
      { content: 'D', status: 'killed' },
    ])
    expect(entries.map(entry => entry.status)).toEqual(['cancelled', 'in_progress', 'completed', 'cancelled'])
    expect(entries.map(entry => entry.rawStatus)).toEqual(['CANCELLED', 'in-progress', 'done', 'killed'])
  })
})

type JsonValueShape = Parameters<typeof JSON.stringify>[0]
