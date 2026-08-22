import { describe, expect, it } from 'vitest'
import { BUILTIN_PLAN_RENDER_KIND } from '../builtinRenderContent.ts'

describe('C08 content.plan render kind', () => {
  it('publishes the plan and goal appearance controls required by the renderer', () => {
    const fields = BUILTIN_PLAN_RENDER_KIND.settings?.groups
      .flatMap(group => group.fields)
      .map(field => field.key)

    expect(BUILTIN_PLAN_RENDER_KIND.id).toBe('content.plan')
    expect(BUILTIN_PLAN_RENDER_KIND.settings?.schemaVersion).toBe(BUILTIN_PLAN_RENDER_KIND.settingsSchemaVersion)
    expect(fields).toEqual(expect.arrayContaining([
      'foreground', 'mutedForeground', 'background', 'borderColor',
      'pendingColor', 'activeColor', 'completedColor', 'cancelledColor', 'blockedColor', 'unknownColor',
      'nodeGlyph', 'connectorStyle', 'connectorColor', 'connectorWidth', 'indent',
      'defaultExpanded', 'collapseCompleted', 'showPriority', 'showBudget', 'density',
    ]))
  })

  it('accepts canonical five-state plan and goal accounting but rejects provider-shaped raw', () => {
    expect(BUILTIN_PLAN_RENDER_KIND.validateInput({
      entries: [
        { id: 'pending', content: '排队', status: 'pending' },
        { id: 'active', content: '施工', status: 'in_progress', activeForm: '施工中', priority: 1 },
        { id: 'done', content: '完成', status: 'completed' },
        { id: 'cancelled', content: '取消', status: 'cancelled' },
        { id: 'blocked', content: '阻塞', status: 'blocked', blockedReason: '依赖未满足' },
        { id: 'future', content: '未来状态', status: 'unknown', rawStatus: 'paused-by-provider' },
      ],
      goal: {
        goalId: 'goal-1', objective: '闭环 C08', status: 'blocked', tokenBudget: 1000, tokensUsed: 250,
        blockedReason: '等待依赖', accounting: { tokensUsed: 250, timeUsedSeconds: 30, metadata: { cost: 0.2 } },
      },
    })).toBe(true)

    expect(BUILTIN_PLAN_RENDER_KIND.validateInput({ entries: [{ content: '[cancelled] 猜测状态', status: 'completed' }] })).toBe(false)
    expect(BUILTIN_PLAN_RENDER_KIND.validateInput({ entries: [{ id: 'literal', content: '[cancelled] 用户原文', status: 'completed' }] })).toBe(true)
    expect(BUILTIN_PLAN_RENDER_KIND.validateInput({ entries: [], goal: { status: 'blocked', accounting: { tokensUsed: -1 } } })).toBe(false)
    expect(BUILTIN_PLAN_RENDER_KIND.validateInput({ update: { sessionUpdate: 'plan', entries: [] } })).toBe(false)
  })
})
