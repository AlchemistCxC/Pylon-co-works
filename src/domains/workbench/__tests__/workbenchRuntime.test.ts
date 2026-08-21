import { describe, expect, it, vi } from 'vitest'
import { createPreviewWorkbenchRuntime, type WorkbenchRuntimeSnapshot } from '../workbenchRuntime.ts'
import { createWorkbenchDocument } from '../workbenchProjector.ts'
import type { Message } from '../../../components/chat/messageTypes.ts'

function initial() {
  return {
    sessionId: 'session-a',
    status: 'ready' as const,
    messages: [],
    streamingText: '',
    streamingThinking: '',
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
  }
}

describe('createPreviewWorkbenchRuntime', () => {
  it('暴露只读 document view，并按 slice 局部通知', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const messages = vi.fn()
    const usage = vi.fn()
    runtime.subscribeSlice('messages', messages)
    runtime.subscribeSlice('usage', usage)

    expect(runtime.getSnapshot().document).toBeDefined()
    expect(Object.isFrozen(runtime.getSnapshot().document)).toBe(true)
    runtime.update({ streamingText: 'token' })
    expect(messages).not.toHaveBeenCalled()
    expect(usage).not.toHaveBeenCalled()
    runtime.update({ messages: [{ id: 'm1', role: 'assistant', sender: 'peri', content: 'hello', time: '10:00' }] })
    expect(messages).toHaveBeenCalledTimes(1)
    expect(usage).not.toHaveBeenCalled()
  })

  it('输出冻结 snapshot，只在内容变化时 bump revision', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const listener = vi.fn()
    runtime.subscribe(listener)
    const first = runtime.getSnapshot()

    runtime.update({ tokenCount: 0 })
    expect(runtime.getSnapshot()).toBe(first)
    expect(listener).not.toHaveBeenCalled()

    runtime.update({ tokenCount: 4, generating: true })
    expect(runtime.getSnapshot()).toMatchObject({ revision: 1, tokenCount: 4, generating: true })
    expect(Object.isFrozen(runtime.getSnapshot())).toBe(true)
    expect(Object.isFrozen(runtime.getSnapshot().messages)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('destroy 幂等并停止后续通知', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const listener = vi.fn()
    runtime.subscribe(listener)
    runtime.destroy()
    runtime.destroy()
    runtime.update({ tokenCount: 10 })

    expect(listener).not.toHaveBeenCalled()
    expect(runtime.getSnapshot().tokenCount).toBe(0)
  })

  it('Bug4：流式高频更新不再全量序列化整个快照，大历史下 streamingText 更新照常广播', () => {
    // 旧实现每次 update 都对整包 JSON.stringify（含全部历史消息）判重，消息越多越慢。
    // 修复后改逐字段引用比较：messages 引用未变时不序列化，streamingText/tokenCount 高频更新
    // 仍是 O(1)，且语义不变（变化才 bump revision、才通知）。
    const big: WorkbenchRuntimeSnapshot = {
      ...initial(),
      revision: 0,
      messages: Array.from({ length: 1000 }, (_, i): Message => ({
        id: `m-${i}`, role: (i % 2 ? 'assistant' : 'user') as Message['role'],
        content: '一段较长的历史回复内容'.repeat(5), running: false, time: '12:00:00', sender: 'peri',
      })),
      tasks: Array.from({ length: 200 }, (_, i) => ({
        id: `t-${i}`, status: 'completed', content: '任务内容'.repeat(10), title: 'tool',
      })),
    }

    // 打桩：记录 JSON.stringify 是否被以"含非空 messages 的整包"调用（即是否又回退全量序列化）。
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    const serializedWholeSnapshot = () => stringifySpy.mock.calls.some(([value]) => {
      const obj = value as Record<string, unknown> | null
      return !!obj && Array.isArray(obj.messages) && obj.messages.length > 0
    })

    const runtime = createPreviewWorkbenchRuntime(big)
    const listener = vi.fn()
    runtime.subscribe(listener)

    // 多次模拟流式 tick：只改 streamingText / tokenCount。
    for (let t = 1; t <= 50; t++) {
      runtime.update({ streamingText: `token-${t}`, tokenCount: t })
    }

    expect(listener).toHaveBeenCalledTimes(50)
    expect(runtime.getSnapshot().revision).toBe(50)
    // 全程不得对含 1000 条消息的整包做 JSON.stringify（避免 O(n) 拖慢流式）。
    expect(serializedWholeSnapshot()).toBe(false)
    stringifySpy.mockRestore()
  })

  it('live/replay 共用 apply/replace，并拒绝旧 owner generation 的迟到 document', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const oldDocument = { ...createWorkbenchDocument('session-a'), revision: 1 }
    const currentDocument = { ...createWorkbenchDocument('session-b'), revision: 2 }
    runtime.replaceDocument(currentDocument, { ownerKey: 'owner-b', generation: 3, sessionId: 'session-b' })
    const revision = runtime.getSnapshot().revision
    runtime.applyDocument(oldDocument, { ownerKey: 'owner-b', generation: 2 })
    expect(runtime.getSnapshot().sessionId).toBe('session-b')
    expect(runtime.getSnapshot().document?.sessionId).toBe('session-b')
    expect(runtime.getSnapshot().revision).toBe(revision)
    runtime.applyDocument({ ...currentDocument, revision: 4 }, { ownerKey: 'owner-b', generation: 3 })
    expect(runtime.getSnapshot().document?.revision).toBe(4)
    runtime.replaceDocument(oldDocument, { ownerKey: 'owner-a', generation: 1, sessionId: 'session-a' })
    expect(runtime.getSnapshot().ownerKey).toBe('owner-a')
    expect(runtime.getSnapshot().generation).toBe(1)
  })

  it('document selector 对 timeline/activity/interaction/session/diagnostics 保持局部通知', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const initialDocument = { ...createWorkbenchDocument('session-a'), session: { ...createWorkbenchDocument('session-a').session, status: 'ready' } }
    runtime.replaceDocument(initialDocument, { ownerKey: 'owner-a', generation: 1 })
    const listeners = {
      timeline: vi.fn(), activities: vi.fn(), interactions: vi.fn(), session: vi.fn(), diagnostics: vi.fn(),
    }
    for (const [slice, listener] of Object.entries(listeners)) runtime.subscribeSlice(slice as 'timeline', listener)
    const current = runtime.getSnapshot().document!
    runtime.applyDocument({ ...current, timeline: [...current.timeline, { id: 'evt-1', sequence: 1, eventId: 'evt-1', kind: 'assist' }] }, { ownerKey: 'owner-a', generation: 1 })
    expect(listeners.timeline).toHaveBeenCalledTimes(1)
    expect(listeners.activities).not.toHaveBeenCalled()
    expect(listeners.interactions).not.toHaveBeenCalled()
    expect(listeners.session).not.toHaveBeenCalled()
    expect(listeners.diagnostics).not.toHaveBeenCalled()
  })
})
