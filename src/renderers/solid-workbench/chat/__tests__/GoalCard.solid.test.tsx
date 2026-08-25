// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { SolidGoalCard } from '../GoalCard.solid.tsx'

afterEach(() => cleanup())

describe('SolidGoalCard (C08)', () => {
  it('renders objective, status and budget; hides when no goal', () => {
    const empty = render(() => <SolidGoalCard goal={undefined} />)
    expect(empty.container.querySelector('.goal-card')).toBeNull()
    empty.unmount()

    const result = render(() => <SolidGoalCard goal={{
      goalId: 'g-1',
      objective: '完成渲染引擎施工',
      status: 'active',
      tokenBudget: 100000,
      tokensUsed: 42000,
    }} />)
    expect(result.container.querySelector('.goal-card')?.getAttribute('data-status')).toBe('active')
    expect(result.container.textContent).toContain('完成渲染引擎施工')
    expect(result.container.textContent).toContain('42%')
    // 进度语义暴露给辅助技术
    expect(result.getByRole('status').getAttribute('aria-label')).toContain('42%')
    result.unmount()

    const blocked = render(() => <SolidGoalCard goal={{
      goalId: 'g-1',
      objective: '完成渲染引擎施工',
      status: 'blocked',
      blockedReason: '等待预算审批',
    }} />)
    expect(blocked.container.querySelector('.goal-card')?.getAttribute('data-status')).toBe('blocked')
    expect(blocked.container.textContent).toContain('等待预算审批')
  })

  it('shows unknown status without crashing and keeps reduced motion flag on the root', () => {
    const result = render(() => <SolidGoalCard goal={{
      goalId: 'g-x',
      objective: '未来目标',
      status: 'unknown',
      metadata: { phase: 2 },
    }} reducedMotion={true} />)
    expect(result.container.querySelector('.goal-card')?.getAttribute('data-status')).toBe('unknown')
    expect(result.container.querySelector('.goal-card')?.getAttribute('data-reduced-motion')).toBe('true')
    expect(result.container.textContent).toContain('未知')
    expect(result.container.querySelector('.goal-card-metadata .tool-object-inspector')).toHaveTextContent('phase')
    expect(result.container.querySelector('.goal-card-metadata pre')).toBeNull()
  })
})
