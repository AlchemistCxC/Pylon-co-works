/**
 * #375-a：`timeline.data` 的事件族收窄——载荷单一持有。
 *
 * 载荷的消费者只有 `toolInvocationSnapshot`（读 `activities[]`）；timeline 里那份整份
 * 语义事件没有任何生产读者（只有 session 族的 `type`/`status`/`options` 被读）。本文件
 * 钉住：tool / activity 两族的 `timeline.data` 只留标量面 + 被省略的键名清单，载荷仍完整
 * 归 `activities[]`；逃生口（`setTimelinePayloadNarrowing(false)`）能回到整份事件。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  reduceWorkbenchEvent,
  setTimelinePayloadNarrowing,
  toolInvocationSnapshot,
  type WorkbenchDocument,
} from '../workbenchProjector.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'

const base = {
  provider: 'peri',
  sourceId: 'wire-1',
  sessionId: 'session-1',
  recordedAt: '2026-08-21T00:00:00.000Z',
} as const

function envelope(sequence: number, event: WorkbenchSemanticEvent, toolCallId: string): WorkbenchEventEnvelope {
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

const bigParts = [{ kind: 'text' as const, text: 'x'.repeat(4096) }]

function toolDocument(): WorkbenchDocument {
  return reduce([
    envelope(1, {
      type: 'tool.started',
      tool: {
        name: 'Bash',
        title: '跑构建',
        status: 'running',
        input: { command: 'bun run build' },
        rawInput: { command: 'bun run build' },
        parts: bigParts,
      },
    }, 'call-a'),
  ])
}

afterEach(() => { setTimelinePayloadNarrowing(true) })

describe('#375-a timeline.data 收窄（tool / activity 族）', () => {
  it('tool 族的 timeline.data 只留标量，载荷键名如实列出', () => {
    const document = toolDocument()
    const entry = document.timeline.find(item => item.kind === 'tool')
    expect(entry).toBeDefined()
    const data = entry!.data as Record<string, unknown>
    expect(data.type).toBe('tool.started')
    // 一层内嵌对象的标量面保留（插件读的 name/title/status 就在这一层）
    const tool = data.tool as Record<string, unknown>
    expect(tool.name).toBe('Bash')
    expect(tool.title).toBe('跑构建')
    expect(tool.status).toBe('running')
    // 载荷载体（input / rawInput / parts）被省略，键名如实列出
    expect(tool.input).toBeUndefined()
    expect(tool.parts).toBeUndefined()
    expect(tool.rawInput).toBeUndefined()
    expect(tool.payloadKeys).toEqual(['input', 'rawInput', 'parts'])
  })

  it('载荷仍完整归 activities[]，且 toolInvocationSnapshot 照旧读得到', () => {
    const document = toolDocument()
    const node = document.activities.find(item => item.kind === 'tool')
    expect(node).toBeDefined()
    expect(node!.parts).toEqual(bigParts)
    expect(node!.input).toEqual({ command: 'bun run build' })
    const snapshot = toolInvocationSnapshot(document, 'call-a')
    expect(snapshot?.input).toEqual({ command: 'bun run build' })
    expect(snapshot?.result?.parts).toEqual(bigParts)
  })

  it('session 族不收窄：终态判定与协商守卫读的字段逐字保留', () => {
    const document = reduce([
      envelope(1, { type: 'session.started', options: [{ id: 'model', value: 'm' }] } as unknown as WorkbenchSemanticEvent, 'call-a'),
    ])
    const entry = document.timeline.find(item => item.kind === 'session')
    expect((entry!.data as { options?: unknown }).options).toEqual([{ id: 'model', value: 'm' }])
  })

  it('逃生口关掉收窄后 timeline.data 回到整份语义事件', () => {
    setTimelinePayloadNarrowing(false)
    try {
      const document = toolDocument()
      const data = document.timeline.find(item => item.kind === 'tool')!.data as Record<string, unknown>
      expect((data.tool as Record<string, unknown>).parts).toEqual(bigParts)
      expect(data.payloadKeys).toBeUndefined()
    } finally {
      setTimelinePayloadNarrowing(true)
    }
  })
})
