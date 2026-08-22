import { describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  reduceWorkbenchEvent,
  toolInvocationSnapshot,
  type WorkbenchDocument,
} from '../workbenchProjector.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'

/**
 * C04 RED：通用工具生命周期契约。
 *
 * 卡面要求（含 DIC-C04-01 与架构层消费补全）：
 * - ToolInvocation 收窄为 provider-neutral snapshot：
 *   name/canonicalName/title/semanticKind/kind/action/capabilities/input/locations/
 *   status/progress/parentToolCallId；result 至少 status/parts/rawOutput/error/durationMs。
 * - update 先于 start 创建 identity placeholder，start 到达补全；终态幂等，failed 不伪装 completed。
 * - unknown 工具有 generic 卡 + provider name + raw 摘要 + diagnostic；不因字典未加载消失。
 * - rawInput 只是审计兼容字段；renderer 消费 normalized input/locations。
 */

const base = {
  provider: 'peri',
  sourceId: 'wire-1',
  sessionId: 'session-1',
  recordedAt: '2026-08-21T00:00:00.000Z',
} as const

function envelope(
  sequence: number,
  event: WorkbenchSemanticEvent,
  toolCallId: string,
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    ...base,
    sequence,
    source: { provider: base.provider, sourceId: `${base.sourceId}-${sequence}` },
    identity: { toolCallId },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })
}

function reduce(events: readonly WorkbenchEventEnvelope[]): WorkbenchDocument {
  return events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
}

describe('C04 tool lifecycle projection', () => {
  it('update-before-start creates identity placeholder that start later completes', () => {
    const document = reduce([
      envelope(1, { type: 'tool.progress', tool: { status: 'running' } }, 'call-a'),
      envelope(2, { type: 'tool.started', tool: { name: 'Read', title: '读取文件', semanticKind: 'tool.read' } }, 'call-a'),
    ])

    const activities = document.activities.filter(node => node.kind === 'tool')
    expect(activities).toHaveLength(1)
    const node = activities[0]!
    // 占位卡在 update 时已建立（id 稳定），start 补全 name
    expect(node.id).toBe('call-a')
    expect(node.title).toBe('Read')
    expect(node.status).toBe('running')
    expect(node.semanticKind).toBe('tool.read')
  })

  it('terminal states are idempotent and failed never masquerades as completed', () => {
    const failedOnce = reduce([
      envelope(1, { type: 'tool.started', tool: { name: 'Bash' } }, 'call-b'),
      envelope(2, { type: 'tool.failed', tool: { status: 'failed', error: 'exit code 1' } }, 'call-b'),
    ])
    const afterDoubleFail = reduce([
      envelope(1, { type: 'tool.started', tool: { name: 'Bash' } }, 'call-b'),
      envelope(2, { type: 'tool.failed', tool: { status: 'failed', error: 'exit code 1' } }, 'call-b'),
      // 迟到的 progress 不应把 failed 改写为 running/completed
      envelope(3, { type: 'tool.progress', tool: { status: 'progress' } }, 'call-b'),
    ])
    const afterLateCompleted = reduce([
      envelope(1, { type: 'tool.started', tool: { name: 'Bash' } }, 'call-b'),
      envelope(2, { type: 'tool.failed', tool: { status: 'failed', error: 'exit code 1' } }, 'call-b'),
      envelope(3, {
        type: 'tool.completed',
        tool: { status: 'completed', parts: [{ kind: 'text', text: 'late evidence' }] },
      }, 'call-b'),
    ])

    for (const document of [failedOnce, afterDoubleFail, afterLateCompleted]) {
      const node = document.activities.find(node => node.id === 'call-b')!
      expect(node.status).toBe('failed')
    }
    expect(toolInvocationSnapshot(afterLateCompleted, 'call-b')?.result?.parts).toEqual([
      { kind: 'text', text: 'late evidence' },
    ])
  })

  it('unknown tool still produces a visible card with provider name', () => {
    const document = reduce([
      envelope(1, { type: 'tool.started', tool: { name: 'totally_unknown_tool' } }, 'call-c'),
    ])
    const node = document.activities.find(node => node.id === 'call-c')!
    expect(node.title).toBe('totally_unknown_tool')
    expect(node.status).toBe('running')
  })
})

describe('C04 provider-neutral snapshot selector (toolInvocationSnapshot)', () => {
  const started = envelope(1, {
    type: 'tool.started',
    tool: {
      name: 'Read',
      canonicalName: 'read_file',
      title: '读取文件',
      semanticKind: 'tool.read',
      kind: 'read',
      action: 'read',
      capabilities: ['fs'],
      rawInput: { path: '/a.txt' },
      parentToolUseId: 'parent-1',
    },
  }, 'snap-1')

  const completed = envelope(2, {
    type: 'tool.completed',
    tool: {
      status: 'completed',
      parts: [{ kind: 'text', text: 'file content' }],
      rawOutput: 'file content',
      durationMs: 1200,
    },
  }, 'snap-1')

  it('narrows JsonValue/raw payload into a typed snapshot with all consumed fields', () => {
    const document = reduce([started, completed])
    const snapshot = toolInvocationSnapshot(document, 'snap-1')
    expect(snapshot).not.toBeNull()
    if (!snapshot) return
    expect(snapshot.name).toBe('Read')
    expect(snapshot.canonicalName).toBe('read_file')
    expect(snapshot.title).toBe('读取文件')
    expect(snapshot.semanticKind).toBe('tool.read')
    expect(snapshot.kind).toBe('read')
    expect(snapshot.action).toBe('read')
    expect(snapshot.capabilities).toEqual(['fs'])
    expect(snapshot.status).toBe('completed')
    expect(snapshot.parentToolCallId).toBe('parent-1')
    // result 契约：status/parts/rawOutput/error/durationMs 至少齐备
    expect(snapshot.result?.status).toBe('completed')
    expect(snapshot.result?.parts).toEqual([{ kind: 'text', text: 'file content' }])
    expect(snapshot.result?.rawOutput).toBe('file content')
    expect(snapshot.result?.error).toBeUndefined()
    expect(snapshot.result?.durationMs).toBe(1200)
  })

  it('keeps input as normalized field separate from audit-only rawInput', () => {
    const withNormalized = reduce([
      started,
      envelope(3, { type: 'tool.progress', tool: { input: { path: '/normalized.txt' } } }, 'snap-1'),
    ])
    const snapshot = toolInvocationSnapshot(withNormalized, 'snap-1')
    expect(snapshot?.input).toEqual({ path: '/normalized.txt' })
    // rawInput 仍可从原始事件取回（审计兼容），但不与 input 混淆
    expect(snapshot?.rawInput).toBeDefined()
  })

  it('accumulates start/progress fields when a terminal event only carries the result', () => {
    const document = reduce([
      envelope(1, {
        type: 'tool.started',
        tool: {
          name: 'read_file', providerName: 'ProviderRead', canonicalName: 'read_file', semanticKind: 'tool.read',
          input: { path: '/normalized.txt' }, locations: [{ path: '/normalized.txt', line: 4 }],
          action: 'read', capabilities: ['fs'],
        },
      }, 'snap-cumulative'),
      envelope(2, {
        type: 'tool.progress',
        tool: { status: 'running', progress: { completed: 2, total: 4, message: 'reading' } },
      }, 'snap-cumulative'),
      envelope(3, {
        type: 'tool.completed',
        tool: { status: 'completed', parts: [{ kind: 'text', text: 'done' }] },
      }, 'snap-cumulative'),
    ])

    const snapshot = toolInvocationSnapshot(document, 'snap-cumulative')
    expect(snapshot).toEqual(expect.objectContaining({
      canonicalName: 'read_file',
      name: 'ProviderRead',
      semanticKind: 'tool.read',
      input: { path: '/normalized.txt' },
      locations: [{ path: '/normalized.txt', line: 4 }],
      action: 'read',
      capabilities: ['fs'],
      progress: { completed: 2, total: 4, message: 'reading' },
      status: 'completed',
    }))
    expect(snapshot?.result?.parts).toEqual([{ kind: 'text', text: 'done' }])
  })

  it('missing optional fields stay undefined — no fabricated empty values', () => {
    const minimal = reduce([envelope(1, { type: 'tool.started', tool: {} }, 'snap-2')])
    const snapshot = toolInvocationSnapshot(minimal, 'snap-2')
    expect(snapshot).not.toBeNull()
    if (!snapshot) return
    expect(snapshot.canonicalName).toBeUndefined()
    expect(snapshot.locations).toBeUndefined()
    expect(snapshot.progress).toBeUndefined()
    expect(snapshot.result).toBeUndefined()
  })

  it('preserves scalar JSON input/progress instead of assuming provider objects', () => {
    const document = reduce([
      envelope(1, { type: 'tool.started', tool: { name: 'Shell', input: 'npm test' } }, 'snap-scalar'),
      envelope(2, { type: 'tool.progress', tool: { progress: 0.5 } }, 'snap-scalar'),
    ])

    expect(toolInvocationSnapshot(document, 'snap-scalar')).toEqual(expect.objectContaining({
      input: 'npm test',
      progress: 0.5,
    }))
  })

  it('narrows provider error details into the shared NormalizedError contract', () => {
    const document = reduce([envelope(1, {
      type: 'tool.failed',
      tool: { error: { message: 'permission denied', code: 'EACCES', retryable: true } },
    }, 'snap-error')])

    expect(toolInvocationSnapshot(document, 'snap-error')?.result?.error).toEqual(expect.objectContaining({
      userSummary: 'permission denied',
      technicalMessage: 'permission denied',
      code: 'EACCES',
      recoverability: 'retry',
    }))
  })

  it('returns null for unknown id instead of fabricating a placeholder', () => {
    const document = reduce([started])
    expect(toolInvocationSnapshot(document, 'no-such-id')).toBeNull()
  })
})
