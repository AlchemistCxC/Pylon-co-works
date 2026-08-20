import { describe, expect, it, vi } from 'vitest'
import { createPreviewWorkbenchRuntime, type WorkbenchRuntimeSnapshot } from '../workbenchRuntime.ts'
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
})
