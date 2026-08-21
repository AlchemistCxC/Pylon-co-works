import { describe, expect, it } from 'vitest'
import {
  applyGoalEvents,
  normalizePlanEntries,
  plainGoalSummary,
  readablePlanLines,
  selectPlanProgress,
} from '../goalModel.ts'

describe('plan/goal fallback text selectors (C08)', () => {
  it('produces readable text lines for cancelled/blocked/unknown entries', () => {
    const lines = readablePlanLines(normalizePlanEntries([
      { content: '已完成项', status: 'completed' },
      { content: '已取消项', status: 'cancelled' },
      { content: '被阻塞项', status: 'blocked', blockedReason: '等待审批' },
      { content: '未知项', status: 'unknown', rawStatus: 'queued' },
    ]))
    expect(lines).toEqual([
      '[completed] 已完成项',
      '[cancelled] 已取消项',
      '[blocked] 被阻塞项 — 等待审批',
      '[unknown (queued)] 未知项',
    ])
  })

  it('summarizes goal progress for plain-text fallback', () => {
    const state = applyGoalEvents({ current: undefined }, {
      type: 'goal.updated',
      goal: { objective: '目标 A', status: 'active', tokenBudget: 1000, tokensUsed: 250 } as unknown as Parameters<typeof JSON.stringify>[0],
    })
    expect(plainGoalSummary(state.current)).toBe('[active] 目标 A — 预算 25%（250/1000）')
    // 无预算时不输出预算段
    const bare = applyGoalEvents({ current: undefined }, { type: 'goal.updated', goal: { objective: '目标 B', status: 'complete' } as unknown as Parameters<typeof JSON.stringify>[0] })
    expect(plainGoalSummary(bare.current)).toBe('[complete] 目标 B')
  })

  it('derives plan progress counts without mutating state', () => {
    const entries = normalizePlanEntries([
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
      { content: 'C', status: 'blocked' },
    ])
    expect(selectPlanProgress(entries)).toEqual({ total: 3, completed: 1, active: 1, blocked: 1, cancelled: 0 })
  })
})
