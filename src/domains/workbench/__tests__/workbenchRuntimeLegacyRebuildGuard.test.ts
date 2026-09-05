import { describe, expect, it, vi } from 'vitest'
import { createPreviewWorkbenchRuntime, type WorkbenchRuntimeSnapshot } from '../workbenchRuntime.ts'
import { createWorkbenchDocument, reduceWorkbenchEvent, type WorkbenchDocument } from '../workbenchProjector.ts'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import type { Message } from '../../../components/chat/messageTypes.ts'

/**
 * P48-① 回归锁：`update()` 的 legacy 字段补丁只允许重建"由 legacy 快照字段
 * 派生"的 document（preview fixture 语义保持不变）。经
 * applyDocument/replaceDocument（或携带 document 的 setSnapshot）进入的
 * canonical projection 是权威，legacy patch 不得静默重建——那条路径会丢掉
 * activities/interactions/extensions/parts，并把全部消息 sequence 归零、
 * 破坏活动锚定。
 */

function initial(document?: WorkbenchDocument) {
  return {
    sessionId: 'session-a',
    status: 'ready' as const,
    messages: [],
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
    ...(document ? { document } : {}),
  } satisfies Omit<WorkbenchRuntimeSnapshot, 'revision'>
}

/** A projector-produced document carrying one tool activity (the kind of data a legacy rebuild would wipe). */
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

const legacyMessage: Message = { id: 'm1', role: 'assistant', sender: 'acp', content: 'hello', time: '10:00' }

describe('update() legacy rebuild provenance guard', () => {
  it('keeps rebuilding a legacy-derived document so preview fixtures are unchanged', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    runtime.update({ messages: [legacyMessage] })
    const first = runtime.getSnapshot().document
    expect(first?.messages.map(message => message.id)).toEqual(['m1'])
    expect(first?.activities).toEqual([])

    runtime.update({ messages: [legacyMessage, { ...legacyMessage, id: 'm2', content: 'again' }] })
    expect(runtime.getSnapshot().document?.messages).toHaveLength(2)
  })

  it('ignores a legacy patch that would silently replace an authoritative document', () => {
    const runtime = createPreviewWorkbenchRuntime(initial(canonicalDocument()))
    const authoritative = runtime.getSnapshot().document
    expect(authoritative?.activities.map(activity => activity.id)).toEqual(['tool-1'])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      runtime.update({ messages: [legacyMessage] })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }

    const after = runtime.getSnapshot().document
    expect(after).toBe(authoritative)
    expect(after?.activities.map(activity => activity.id)).toEqual(['tool-1'])
    expect(after?.messages.map(message => message.id)).toEqual([])
  })

  it('applyDocument makes the runtime authoritative again after legacy usage', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    runtime.update({ messages: [legacyMessage] })
    expect(runtime.getSnapshot().document?.messages).toHaveLength(1)

    runtime.applyDocument(canonicalDocument(), {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      runtime.update({ messages: [legacyMessage] })
    } finally {
      warn.mockRestore()
    }
    const after = runtime.getSnapshot().document
    expect(after?.activities.map(activity => activity.id)).toEqual(['tool-1'])
    expect(after?.messages.map(message => message.id)).toEqual([])
  })

  it('setSnapshot without a document returns the runtime to legacy derivation', () => {
    const runtime = createPreviewWorkbenchRuntime(initial(canonicalDocument()))
    runtime.setSnapshot({ ...initial(), revision: 0, tokenCount: 1 })
    runtime.update({ messages: [legacyMessage] })
    expect(runtime.getSnapshot().document?.messages.map(message => message.id)).toEqual(['m1'])
  })
})
