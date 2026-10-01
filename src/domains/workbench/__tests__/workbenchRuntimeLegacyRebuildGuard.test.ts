import { describe, expect, it } from 'vitest'
import { createPreviewWorkbenchRuntime, type WorkbenchRuntimeSnapshot } from '../workbenchRuntime.ts'
import { createWorkbenchDocument, reduceWorkbenchEvent, type WorkbenchDocument } from '../workbenchProjector.ts'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'

/**
 * P48-①→#487 回归锁：legacy 重建路径（`update({messages})` 从快照字段重派生
 * document）已随 `WorkbenchRuntimeSnapshot.messages` 退役。document 的唯一
 * 变更通道是 applyDocument / replaceDocument（或携带 document 的 setSnapshot）；
 * `update()` 是纯字段补丁，绝不允许触碰 document——重建路径会丢掉
 * activities/interactions/extensions/parts，并把全部消息 sequence 归零、
 * 破坏活动锚定。
 */

function initial(document: WorkbenchDocument = createWorkbenchDocument('session-a')) {
  return {
    sessionId: 'session-a',
    status: 'ready' as const,
    generating: false,
    generationStart: 0,
    tokenCount: 0,
    summary: null,
    tasks: [],
    availableModels: [],
    activeModel: '',
    availableModes: [],
    activeMode: 'default',
    canAttach: false,
    promptImage: false,
    error: null,
    document,
  } satisfies Omit<WorkbenchRuntimeSnapshot, 'revision'> & { document: WorkbenchDocument }
}

/** A projector-produced document carrying one tool activity (the kind of data a rebuild would wipe). */
function canonicalDocument(): WorkbenchDocument {
  const envelope = createWorkbenchEnvelope({
    eventId: 'event-tool-1',
    sessionId: 'session-a',
    sequence: 1,
    recordedAt: '2026-09-05T00:00:00.000Z',
    source: { provider: 'acp', sourceId: 'event-tool-1' },
    identity: { toolCallId: 'tool-1' },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'Read' } },
  })
  return reduceWorkbenchEvent(createWorkbenchDocument('session-a'), envelope)
}

describe('update() document provenance guard', () => {
  it('update() 是纯字段补丁，任何补丁都不得替换权威 document', () => {
    const runtime = createPreviewWorkbenchRuntime(initial(canonicalDocument()))
    const authoritative = runtime.getSnapshot().document
    expect(authoritative?.activities.map(activity => activity.id)).toEqual(['tool-1'])

    runtime.update({ status: 'degraded', error: 'boom', tokenCount: 5, generating: true })
    const after = runtime.getSnapshot().document
    expect(after).toBe(authoritative)
    expect(after?.activities.map(activity => activity.id)).toEqual(['tool-1'])
    expect(runtime.getSnapshot()).toMatchObject({ status: 'degraded', error: 'boom', tokenCount: 5, generating: true })
  })

  it('update() 后 applyDocument 仍是唯一换文档路径', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    runtime.update({ tokenCount: 1 })
    expect(runtime.getSnapshot().document?.messages).toEqual([])
    expect(runtime.getSnapshot().document?.activities).toEqual([])

    runtime.applyDocument(canonicalDocument(), {})
    const after = runtime.getSnapshot().document
    expect(after?.activities.map(activity => activity.id)).toEqual(['tool-1'])
    expect(runtime.getSnapshot().tokenCount).toBe(1)
  })

  it('setSnapshot 未携带 document 时沿用上一份文档，不回退到空文档', () => {
    const runtime = createPreviewWorkbenchRuntime(initial(canonicalDocument()))
    const previous = runtime.getSnapshot().document
    const { document: _omitted, ...bare } = initial()
    runtime.setSnapshot({ ...bare, revision: 0, tokenCount: 1 })
    expect(runtime.getSnapshot().document).toBe(previous)
    expect(runtime.getSnapshot().document?.activities.map(activity => activity.id)).toEqual(['tool-1'])
    expect(runtime.getSnapshot().tokenCount).toBe(1)
  })

  it('构造器要求初始 document（预览面与生产同构，无 legacy 派生兜底）', () => {
    const runtime = createPreviewWorkbenchRuntime(initial(canonicalDocument()))
    expect(runtime.getSnapshot().document?.activities.map(activity => activity.id)).toEqual(['tool-1'])
    expect(Object.isFrozen(runtime.getSnapshot().document)).toBe(true)
  })
})
