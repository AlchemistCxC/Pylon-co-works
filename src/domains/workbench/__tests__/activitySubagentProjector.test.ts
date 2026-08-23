import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import { createWorkbenchDocument, projectWorkbench, selectActivities, selectActivityDisplayOrder } from '../workbenchProjector.ts'

/**
 * C09 RED：activity.subagent / activity.delegation / activity.team 投影契约。
 *
 * - 子代理是活动图一等节点（semanticKind=activity.*），不是 tool.generic；
 * - 父子关系经 identity 边（parentId）连接；parent 迟到时 orphan 保持可见、后到父节点解除；
 * - rich 字段（depth/role/model/provider/goal/usage/metrics/files/capabilities）跨事件累积，
 *   终态幂等（迟到事件只补缺不回退）；minimal fixture 缺字段稳定降级不猜层级。
 */

const envelope = (sequence: number, event: Parameters<typeof createWorkbenchEnvelope>[0]['event'], provider = 'claude') =>
  createWorkbenchEnvelope({
    sessionId: 'session-c09',
    sequence,
    recordedAt: `2026-08-23T06:00:0${sequence}.000Z`,
    source: { provider, sourceId: `c09-${sequence}` },
    identity: { taskId: 'sub-' + Math.ceil(sequence / 2) },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })

describe('C09 subagent/delegation/team projection', () => {
  it('keeps a started subagent running when progress arrives', () => {
    const started = projectWorkbench([
      envelope(1, {
        type: 'activity.started', activityId: 'sub-running',
        activity: { kind: 'subagent', title: 'Inspect renderer seams' },
      }),
    ]).document
    expect(selectActivities(started).find(activity => activity.id === 'sub-running')?.status).toBe('running')

    const progressed = projectWorkbench([
      envelope(1, {
        type: 'activity.started', activityId: 'sub-running',
        activity: { kind: 'subagent', title: 'Inspect renderer seams' },
      }),
      envelope(2, {
        type: 'activity.progress', activityId: 'sub-running',
        patch: { progress: { completed: 1, total: 3 } },
      }),
    ]).document
    expect(selectActivities(progressed).find(activity => activity.id === 'sub-running')?.status).toBe('running')
  })

  it('preserves normalized activity statuses and degrades unknown values safely', () => {
    for (const status of ['paused', 'blocked', 'timeout'] as const) {
      const { document } = projectWorkbench([
        envelope(1, {
          type: 'activity.progress', activityId: `sub-${status}`,
          patch: { kind: 'subagent', status },
        }),
      ])
      expect(selectActivities(document).find(activity => activity.id === `sub-${status}`)?.status).toBe(status)
    }

    const { document } = projectWorkbench([
      envelope(1, {
        type: 'activity.progress', activityId: 'sub-invalid-status',
        patch: { kind: 'subagent', status: 'teleporting' },
      }),
    ])
    expect(selectActivities(document).find(activity => activity.id === 'sub-invalid-status')?.status).toBe('unknown')
  })

  it('does not revive timeout or interrupted activities with late running progress', () => {
    for (const terminalStatus of ['timeout', 'interrupted'] as const) {
      const { document } = projectWorkbench([
        envelope(1, {
          type: 'activity.progress', activityId: `sub-${terminalStatus}-terminal`,
          patch: { kind: 'subagent', status: terminalStatus },
        }),
        envelope(2, {
          type: 'activity.progress', activityId: `sub-${terminalStatus}-terminal`,
          patch: { status: 'running', description: 'late evidence may fill missing fields' },
        }),
      ])
      const node = selectActivities(document).find(activity => activity.id === `sub-${terminalStatus}-terminal`)
      expect(node?.status).toBe(terminalStatus)
      expect(node?.description).toBe('late evidence may fill missing fields')
    }
  })

  it('accumulates normalized identity, timing, metrics and execution metadata', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'activity.started', activityId: 'sub-rich-lifecycle',
        activity: {
          kind: 'subagent', sourceAgentId: 'agent-parent', description: 'Inspect the renderer registry',
          startedAt: '2026-08-23T06:00:01.000Z',
        },
      }),
      envelope(2, {
        type: 'activity.progress', activityId: 'sub-rich-lifecycle',
        patch: {
          metrics: { toolCount: 4, taskCount: 2, durationMs: 900, costUsd: 0.03 },
          execution: { mode: 'remote', background: true, worktree: 'review/c09', team: 'renderer' },
          tools: [{ id: 'tool-4', status: 'completed' }],
          tasks: [{ id: 'task-2', status: 'running' }],
        },
      }),
      envelope(3, {
        type: 'activity.completed', activityId: 'sub-rich-lifecycle',
        result: { completedAt: '2026-08-23T06:00:03.000Z' },
      }),
    ])
    const node = selectActivities(document).find(activity => activity.id === 'sub-rich-lifecycle')
    expect(node).toMatchObject({
      sourceAgentId: 'agent-parent',
      description: 'Inspect the renderer registry',
      startedAt: '2026-08-23T06:00:01.000Z',
      completedAt: '2026-08-23T06:00:03.000Z',
      metrics: { toolCount: 4, taskCount: 2, durationMs: 900, costUsd: 0.03 },
      execution: { mode: 'remote', background: true, worktree: 'review/c09', team: 'renderer' },
      tools: [{ id: 'tool-4', status: 'completed' }],
      tasks: [{ id: 'task-2', status: 'running' }],
    })
  })

  it('narrows nested subagent parts and preserves malformed evidence as bounded unknown content', () => {
    const completed = envelope(1, {
      type: 'activity.completed', activityId: 'sub-malformed-output',
      activity: { kind: 'subagent', title: 'Unsafe worker output' },
      result: {
        parts: [
          { kind: 'terminal', streams: [{ stream: 'stdout', text: 'kept' }], exitCode: 0 },
          { kind: 'terminal', streams: [{ stream: 'stdin', text: 'malformed evidence' }] },
        ],
      },
    })
    const { document } = projectWorkbench([completed])
    const node = selectActivities(document).find(activity => activity.id === 'sub-malformed-output')
    expect(node?.parts).toEqual([
      { kind: 'terminal', streams: [{ stream: 'stdout', text: 'kept' }], exitCode: 0 },
      expect.objectContaining({ kind: 'unknown', originalType: 'terminal', truncated: false }),
    ])
    expect(document.diagnostics).toContainEqual(expect.objectContaining({
      code: 'activity.subagent.part-malformed',
      eventId: completed.eventId,
      level: 'warning',
      data: expect.objectContaining({ activityId: 'sub-malformed-output', partIndex: 1 }),
    }))
  })

  it('projects normalized result output as typed renderer content', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'activity.completed', activityId: 'sub-output',
        activity: { kind: 'subagent', title: 'Review complete' },
        result: { output: [{ kind: 'text', text: 'No blocking issues found.' }] },
      }),
    ])
    const node = selectActivities(document).find(activity => activity.id === 'sub-output')
    expect(node?.output).toEqual([{ kind: 'text', text: 'No blocking issues found.' }])
    expect(node?.parts).toEqual(node?.output)
  })

  it('projects a rich subagent with accumulated lifecycle fields and terminal idempotence', () => {
    const events = [
      envelope(1, {
        type: 'activity.started', activityId: 'sub-1',
        activity: {
          kind: 'subagent', semanticKind: 'activity.subagent', title: 'Explore repo',
          parentId: 'tool-1', depth: 2, role: 'explorer', model: 'ox-alpha-free', provider: 'opencode-go',
          goal: 'find all call sites of reduceActivity',
          capabilities: ['fs', 'search'],
        },
      }),
      envelope(2, {
        type: 'activity.progress', activityId: 'sub-1',
        patch: {
          progress: { completed: 3, total: 5 },
          usage: { inputTokens: 1200, outputTokens: 340 },
          files: ['src/a.ts', 'src/b.ts'],
        },
      }),
      envelope(3, {
        type: 'activity.completed', activityId: 'sub-1', result: { summary: 'found 12 call sites' },
      } as never),
      // 迟到的 progress：终态后只允许补缺字段，不允许回退状态
      envelope(4, {
        type: 'activity.progress', activityId: 'sub-1',
        patch: { progress: { completed: 9, total: 5 } },
      }),
    ]
    const { document } = projectWorkbench(events)
    const node = selectActivities(document).find(a => a.id === 'sub-1')
    expect(node).toBeDefined()
    expect(node!.status).toBe('completed')
    expect(node!.semanticKind).toBe('activity.subagent')
    expect(node!.activityKind).toBe('subagent')
    expect(node!.parentId).toBe('tool-1')
    // C09 业务字段：rich metadata 以节点列保留（架构补全要求的 normalized optional 字段）
    expect(node!.depth).toBe(2)
    expect(node!.role).toBe('explorer')
    expect(node!.model).toBe('ox-alpha-free')
    expect(node!.provider).toBe('opencode-go')
    expect(node!.goal).toBe('find all call sites of reduceActivity')
    expect(node!.capabilities).toEqual(['fs', 'search'])
    expect((node!.progress as { completed: number }).completed).toBe(3)
    expect(node!.usage).toEqual({ inputTokens: 1200, outputTokens: 340 })
    expect(node!.files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(node!.result).toEqual({ summary: 'found 12 call sites' })
  })

  it('keeps an orphan subagent visible before its parent arrives and re-links afterwards', () => {
    const childFirst = projectWorkbench([
      envelope(1, {
        type: 'activity.started', activityId: 'sub-orphan',
        activity: { kind: 'delegation', semanticKind: 'activity.delegation', title: 'remote delegate', parentId: 'team-9' },
      }),
    ]).document
    const orphan = selectActivities(childFirst).find(a => a.id === 'sub-orphan')
    expect(orphan!.orphan).toBe(true)

    const linked = projectWorkbench([
      envelope(1, {
        type: 'activity.started', activityId: 'sub-orphan',
        activity: { kind: 'delegation', semanticKind: 'activity.delegation', title: 'remote delegate', parentId: 'team-9' },
      }),
      envelope(2, {
        type: 'activity.started', activityId: 'team-9',
        activity: { kind: 'team', semanticKind: 'activity.team', title: 'Ops team' },
      }),
    ]).document
    expect(selectActivities(linked).find(a => a.id === 'sub-orphan')!.orphan).toBe(false)
    expect(selectActivities(linked).find(a => a.id === 'team-9')).toBeDefined()
  })

  it('derives a stable parent-before-child display order without rewriting the journal projection', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'activity.started', activityId: 'sub-child',
        activity: { kind: 'subagent', parentId: 'team-parent', title: 'Child' },
      }),
      envelope(2, {
        type: 'activity.started', activityId: 'team-parent',
        activity: { kind: 'team', title: 'Parent' },
      }),
      envelope(3, {
        type: 'activity.started', activityId: 'sub-orphan-stable',
        activity: { kind: 'subagent', parentId: 'missing-parent', title: 'Orphan' },
      }),
    ])
    expect(selectActivities(document).map(activity => activity.id)).toEqual([
      'sub-child', 'team-parent', 'sub-orphan-stable',
    ])
    expect(selectActivityDisplayOrder(document).map(activity => activity.id)).toEqual([
      'team-parent', 'sub-child', 'sub-orphan-stable',
    ])
  })

  it('orders a large activity chain iteratively without dropping nodes', () => {
    const activities = Array.from({ length: 5_000 }, (_, index) => ({
      id: `activity-${index}`,
      kind: 'activity' as const,
      activityKind: 'subagent',
      semanticKind: 'activity.subagent',
      status: 'running',
      ...(index > 0 ? { parentId: `activity-${index - 1}` } : {}),
      orphan: false,
      sequence: index,
    }))
    const document = { ...createWorkbenchDocument('session-large-c09'), activities }
    const ordered = selectActivityDisplayOrder(document)
    expect(ordered).toHaveLength(5_000)
    expect(ordered[0]?.id).toBe('activity-0')
    expect(ordered.at(-1)?.id).toBe('activity-4999')
  })

  it('degrades a minimal delegation without guessing hierarchy or identity fields', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'activity.started', activityId: 'del-min',
        activity: { kind: 'delegation' },
      }, 'peri'),
      envelope(2, { type: 'activity.failed', activityId: 'del-min', reason: 'connection lost' }),
    ])
    const node = selectActivities(document).find(a => a.id === 'del-min')
    // family→semanticKind 派生是 wire family 的直译（D04 分层）；层级/身份字段缺失必须保持 undefined
    expect(node!.semanticKind).toBe('activity.delegation')
    expect(node!.title).toBeUndefined()
    expect(node!.model).toBeUndefined()
    expect(node!.goal).toBeUndefined()
    expect(node!.parentId).toBeUndefined()
    expect(node!.depth).toBeUndefined()
    expect(node!.status).toBe('failed')
    expect(node!.reason).toBe('connection lost')
    expect(node!.provenance?.synthetic).toBeUndefined()
  })

  it('derives activity.subagent semantic kind from the wire family when normalizer omits it', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'activity.started', activityId: 'hermes-child',
        activity: { kind: 'subagent', title: 'delegate research' },
      }, 'hermes'),
    ])
    const node = selectActivities(document).find(a => a.id === 'hermes-child')
    expect(node!.semanticKind).toBe('activity.subagent')
    expect(node!.activityKind).toBe('subagent')
  })
})
