// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchDocument, type WorkbenchDocument } from '../../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchDocumentReader } from '../../../renderers/solid-workbench/workbenchHostPort.ts'
import ReactWorkbenchFatalFallback from '../ReactWorkbenchFatalFallback.tsx'

/**
 * C09：React fatal fallback 的 activity 层级列表——goal/status/parent/depth/error 可读。
 */

describe('C09 React fatal fallback: subagent/delegation/team activities', () => {
  it('keeps the activity hierarchy readable with goal, depth, parent, and error', () => {
    const empty = createWorkbenchDocument('local:c09')
    const current: WorkbenchDocument = {
      ...empty,
      revision: 9,
      activities: [
        {
          id: 'team-1', kind: 'activity', activityKind: 'team', semanticKind: 'activity.team',
          title: 'Ops team', status: 'running', orphan: false, sequence: 1,
        },
        {
          id: 'sub-1', kind: 'activity', activityKind: 'subagent', semanticKind: 'activity.subagent',
          title: 'Explore repo', status: 'failed', parentId: 'team-1', depth: 2,
          goal: 'find call sites', description: 'Inspect renderer seams', orphan: true,
          usage: { inputTokens: 1200, outputTokens: 340 },
          metrics: { toolCount: 4, taskCount: 2, durationMs: 900, costUsd: 0.03 },
          files: { read: ['src/a.ts'], written: ['src/b.ts'] },
          execution: { mode: 'remote', background: true, team: 'renderer' },
          output: [{ kind: 'text', text: 'Found 12 call sites' }],
          error: { userSummary: '子代理连接丢失', recoverability: 'retry' },
          provenance: { origin: 'recovery-import', trust: 'unverified', orderConfidence: 'observed' },
          sequence: 2,
        } as WorkbenchDocument['activities'][number],
      ],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      getSlice: () => undefined as never,
      subscribeSlice: () => () => {},
    }
    render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'slot', message: 'solid failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />)

    const team = screen.getByRole('status', { name: '子代理 fallback：Ops team，running' })
    expect(team).toHaveAttribute('data-react-activity-kind', 'activity.team')
    const child = screen.getByRole('status', { name: '子代理 fallback：Explore repo，failed' })
    expect(child).toHaveAttribute('data-react-activity-kind', 'activity.subagent')
    expect(child).toHaveTextContent('depth 2')
    expect(child).toHaveTextContent('parent team-1')
    expect(child).toHaveTextContent('目标：find call sites')
    expect(child).toHaveTextContent('Inspect renderer seams')
    expect(child).toHaveTextContent('Found 12 call sites')
    expect(child).toHaveTextContent('1200')
    expect(child).toHaveTextContent('src/a.ts')
    expect(child).toHaveTextContent('remote')
    expect(child).toHaveTextContent('recovery-import')
    expect(child).toHaveTextContent('子代理连接丢失')
  })

  it('keeps C11 interactions readable with status and response in the fallback list', () => {
    const current: WorkbenchDocument = {
      ...createWorkbenchDocument('local:c11'),
      revision: 3,
      interactions: [
        { id: 'int-1', status: 'requested', request: { kind: 'permission', prompt: 'Allow deploy?' }, sequence: 1 },
        { id: 'int-2', status: 'resolved', response: { optionId: 'deny' }, sequence: 2 },
      ],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      getSlice: () => undefined as never,
      subscribeSlice: () => () => {},
    }
    render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'slot', message: 'solid failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />)
    expect(screen.getByText('Allow deploy?')).toBeInTheDocument()
    expect(screen.getByText('{"optionId":"deny"}')).toBeInTheDocument()
    expect(screen.getAllByText('requested').length).toBeGreaterThan(0)
  })
})
