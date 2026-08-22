import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import { projectWorkbench, selectActivities } from '../workbenchProjector.ts'

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
