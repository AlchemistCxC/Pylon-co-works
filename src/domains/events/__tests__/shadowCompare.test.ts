import { describe, expect, it } from 'vitest'
import { normalizeRawEvent, type CanonicalNormalizeContext } from '../canonicalNormalizer'
import type { CanonicalConversationEvent, CanonicalEventOwner } from '../eventSchema'
import {
  compareToolProjections,
  createMigrationMarker,
  isShadowCompareCritical,
  mergeToolProjection,
  recordMigrationResult,
  shadowCompareToolProjections,
} from '../shadowCompare'
import { projectToolFromCanonical, projectToolFromMessage, type ToolProjection } from '../toolProjection'
import type { ToolProjectableMessage } from '../toolProjection'

const owner: CanonicalEventOwner = { profileId: 'p1', agentId: 'agent-a', localSessionId: 'local:demo' }
const context = { owner, clientGeneration: 4 }

function canonicalContext(sequence: number): CanonicalNormalizeContext {
  return { owner, clientGeneration: 4, sequence, receivedAt: '2026-08-14T00:00:00.000Z' }
}

function toolEvent(sessionUpdate: string, fields: Record<string, unknown>, sequence: number): CanonicalConversationEvent {
  return normalizeRawEvent({ update: { sessionUpdate, ...fields } }, canonicalContext(sequence)).event
}

function oldToolMessage(overrides: Partial<ToolProjectableMessage> = {}): ToolProjectableMessage {
  return {
    externalIdentity: { toolCallId: 'tc-1' },
    toolName: 'Read',
    toolKind: 'read_file',
    rawInput: { path: 'a.txt' },
    rawOutput: '内容',
    toolStatus: 'completed',
    contentBlocks: [{ type: 'text', text: 'x' }],
    ...overrides,
  }
}

describe('compareToolProjections（字段级 diff）', () => {
  it('全字段一致 → 空 diff', () => {
    const event = toolEvent('tool_call', {
      toolCallId: 'tc-1', title: 'Read', kind: 'read_file',
      rawInput: { path: 'a.txt' }, content: [{ type: 'text', text: 'x' }],
    }, 1)
    const newProjection = projectToolFromCanonical(event)!
    const oldProjection = projectToolFromCanonical(event)!
    expect(compareToolProjections(newProjection, oldProjection)).toEqual([])
  })

  it('status 不一致 → 单个字段 diff（含新旧值）', () => {
    const newProjection = projectToolFromCanonical(toolEvent('tool_call_update', {
      toolCallId: 'tc-1', status: 'completed', rawOutput: '内容',
    }, 1))!
    const oldProjection = projectToolFromCanonical(toolEvent('tool_call_update', {
      toolCallId: 'tc-1', status: 'failed', rawOutput: '内容',
    }, 2))!
    const diffs = compareToolProjections(newProjection, oldProjection)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]?.field).toBe('status')
    expect(diffs[0]?.newValue).toBe('completed')
    expect(diffs[0]?.oldValue).toBe('failed')
  })

  it('旧 UI 缺 rawInput（迁移前消息无 EVT-04 字段）→ 报告字段丢失', () => {
    const newProjection = projectToolFromCanonical(toolEvent('tool_call', {
      toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' },
    }, 1))!
    const oldProjection = projectToolFromCanonical(toolEvent('tool_call', {
      toolCallId: 'tc-1', title: 'Read', kind: 'read_file',
    }, 2))!
    const diffs = compareToolProjections(newProjection, oldProjection)
    expect(diffs.map(diff => diff.field)).toContain('rawInput')
  })
})

describe('shadowCompareToolProjections（新旧投影对照，迁移原则 4）', () => {
  it('同一工具生命周期（started + completed）合并后与旧 UI 消息匹配', () => {
    const events = [
      toolEvent('tool_call', {
        toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' },
        content: [{ type: 'text', text: 'x' }],
      }, 1),
      toolEvent('tool_call_update', { toolCallId: 'tc-1', status: 'completed', rawOutput: '内容' }, 2),
    ]
    // 合并终态：started 的 title/kind/rawInput/contentBlocks + completed 的 status/rawOutput
    const merged = events.reduce<ToolProjection | undefined>((acc, event) => {
      const projection = projectToolFromCanonical(event)
      return projection ? (acc ? mergeToolProjection(acc, projection) : projection) : acc
    }, undefined)
    expect(merged).toMatchObject({
      toolCallId: 'tc-1',
      toolName: 'Read',
      kind: 'read_file',
      rawInput: { path: 'a.txt' },
      rawOutput: '内容',
      status: 'completed',
      contentBlocks: [{ type: 'text', text: 'x' }],
    })
    expect(compareToolProjections(merged!, projectToolFromMessage(oldToolMessage(), owner, 4)!)).toEqual([])
  })

  it('同一事件 canonical 与旧 UI 消息 → 全部匹配、零孤儿、零 mismatch', () => {
    const events = [
      toolEvent('tool_call', {
        toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' },
        content: [{ type: 'text', text: 'x' }],
      }, 1),
      toolEvent('tool_call_update', { toolCallId: 'tc-1', status: 'completed', rawOutput: '内容' }, 2),
    ]
    const report = shadowCompareToolProjections(events, [oldToolMessage()], context)
    expect(report.totalNew).toBe(1)
    expect(report.totalOld).toBe(1)
    expect(report.matched).toBe(1)
    expect(report.mismatched).toEqual([])
    expect(report.orphanNew).toEqual([])
    expect(report.orphanOld).toEqual([])
    expect(isShadowCompareCritical(report)).toBe(false)
  })

  it('canonical 有、旧 UI 无 → orphanNew（迁移会新增）', () => {
    const events = [toolEvent('tool_call', { toolCallId: 'tc-new', title: 'Write', kind: 'write_file' }, 1)]
    const report = shadowCompareToolProjections(events, [], context)
    expect(report.orphanNew).toEqual(['tc-new'])
    expect(report.orphanOld).toEqual([])
    expect(report.matched).toBe(0)
    expect(isShadowCompareCritical(report)).toBe(false) // 新增不阻塞迁移
  })

  it('旧 UI 有、canonical 无 → orphanOld（迁移会丢失——critical）', () => {
    const report = shadowCompareToolProjections([], [oldToolMessage()], context)
    expect(report.orphanOld).toEqual(['tc-1'])
    expect(isShadowCompareCritical(report)).toBe(true)
  })

  it('同 toolCallId 字段不一致 → mismatched 条目含字段 diff（critical）', () => {
    const events = [toolEvent('tool_call_update', { toolCallId: 'tc-1', status: 'completed' }, 1)]
    const oldMessages = [oldToolMessage({ toolStatus: 'failed' })]
    const report = shadowCompareToolProjections(events, oldMessages, context)
    expect(report.matched).toBe(0)
    expect(report.mismatched).toHaveLength(1)
    expect(report.mismatched[0]?.toolCallId).toBe('tc-1')
    expect(report.mismatched[0]?.diffs.map(diff => diff.field)).toContain('status')
    expect(isShadowCompareCritical(report)).toBe(true)
  })

  it('多事件多消息：matched + mismatch + orphan 混合统计', () => {
    const events = [
      toolEvent('tool_call', { toolCallId: 'tc-ok', title: 'Read', kind: 'read_file' }, 1),
      toolEvent('tool_call_update', { toolCallId: 'tc-diff', status: 'completed' }, 2),
      toolEvent('tool_call', { toolCallId: 'tc-only-new', title: 'Search', kind: 'grep' }, 3),
    ]
    const oldMessages = [
      // tc-ok：字段与 canonical 一致 → matched
      { externalIdentity: { toolCallId: 'tc-ok' }, toolName: 'Read', toolKind: 'read_file' },
      // tc-diff：status 不一致 → mismatched
      { externalIdentity: { toolCallId: 'tc-diff' }, toolName: 'Write', toolKind: 'write_file', toolStatus: 'failed' },
      // tc-only-old：canonical 无 → orphanOld
      oldToolMessage({ externalIdentity: { toolCallId: 'tc-only-old' }, toolName: 'Gone' }),
    ]
    const report = shadowCompareToolProjections(events, oldMessages, context)
    expect(report.totalNew).toBe(3)
    expect(report.totalOld).toBe(3)
    expect(report.matched).toBe(1) // tc-ok
    expect(report.mismatched.map(item => item.toolCallId)).toEqual(['tc-diff'])
    expect(report.orphanNew).toEqual(['tc-only-new'])
    expect(report.orphanOld).toEqual(['tc-only-old'])
  })
})

describe('迁移 marker（原则 7：失败保留 marker 可重试）', () => {
  it('初始 pending', () => {
    expect(createMigrationMarker()).toEqual({ status: 'pending', retries: 0 })
  })

  it('零 critical → shadow-verified（记录时间）', () => {
    const marker = recordMigrationResult(createMigrationMarker(), {
      totalNew: 1, totalOld: 1, matched: 1, mismatched: [], orphanNew: [], orphanOld: [],
    }, '2026-08-14T00:00:00.000Z')
    expect(marker.status).toBe('shadow-verified')
    expect(marker.verifiedAt).toBe('2026-08-14T00:00:00.000Z')
    expect(marker.retries).toBe(0)
  })

  it('critical → failed 且 retries 递增，失败原因保留', () => {
    let marker = recordMigrationResult(createMigrationMarker(), {
      totalNew: 1, totalOld: 1, matched: 0,
      mismatched: [{ toolCallId: 'tc-1', matched: false, diffs: [{ field: 'status', newValue: 'completed', oldValue: 'failed' }] }],
      orphanNew: [], orphanOld: [],
    }, '2026-08-14T00:00:00.000Z')
    expect(marker.status).toBe('failed')
    expect(marker.failedAt).toBe('2026-08-14T00:00:00.000Z')
    expect(marker.error).toContain('mismatch=1')
    expect(marker.retries).toBe(1)

    // 重试（修复后）→ 推进 verified；retries 保留累计
    marker = recordMigrationResult(marker, {
      totalNew: 1, totalOld: 1, matched: 1, mismatched: [], orphanNew: [], orphanOld: [],
    }, '2026-08-14T01:00:00.000Z')
    expect(marker.status).toBe('shadow-verified')
    expect(marker.retries).toBe(1)
  })

  it('orphanOld 亦为 critical（迁移会丢失旧内容）', () => {
    const marker = recordMigrationResult(createMigrationMarker(), {
      totalNew: 0, totalOld: 1, matched: 0, mismatched: [], orphanNew: [], orphanOld: ['tc-old'],
    })
    expect(marker.status).toBe('failed')
    expect(marker.error).toContain('orphanOld=1')
  })
})
