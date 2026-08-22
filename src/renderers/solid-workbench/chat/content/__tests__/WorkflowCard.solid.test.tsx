// @vitest-environment jsdom
import { render } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { SolidSubagentCard } from '../SubagentCard.solid.tsx'
import type { WorkbenchActivityNode } from '../../../../../domains/workbench/workbenchProjector.ts'

/**
 * C10：后台任务/工作流 Solid 渲染——phase/agent relation、progress、合成 provenance。
 * SubagentCard 是数据驱动的活动卡：semanticKind 只决定 catalog 路由，卡面按节点列渲染。
 */

describe('C10 workflow activity rendering', () => {
  it('renders a workflow phase with parent relation and progress', () => {
    const phase = {
      id: 'phase-1', kind: 'activity', activityKind: 'workflow-phase', semanticKind: 'activity.workflow-phase',
      title: 'build', status: 'running', parentId: 'wf-1',
      progress: { completed: 2, total: 4 },
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={phase} />)
    expect(result.container.textContent).toContain('build')
    expect(result.container.textContent).toContain('parent: wf-1')
    expect(result.container.textContent).toContain('进度 2/4')
    const card = result.container.querySelector('.term-subagent-card') as HTMLElement
    expect(card.getAttribute('data-part-kind')).toBe('activity.workflow-phase')
    expect(card.getAttribute('role')).toBe('status')
  })

  it('marks synthetic terminal provenance on a workflow agent', () => {
    const agent = {
      id: 'agent-1', kind: 'activity', activityKind: 'workflow-agent', semanticKind: 'activity.workflow-agent',
      title: 'reviewer bot', status: 'failed', parentId: 'wf-1', role: 'reviewer',
      reason: 'connection lost', orphan: true,
      provenance: { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed' as const, synthetic: { reason: 'terminal response observed' } },
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={agent} />)
    expect(result.container.textContent).toContain('合成生命周期：terminal response observed')
    // reason 是 journal 事实，卡面呈现的是 status + 合成 provenance（error 才走 role=alert）
    expect(result.container.textContent).toContain('failed')
  })
})
