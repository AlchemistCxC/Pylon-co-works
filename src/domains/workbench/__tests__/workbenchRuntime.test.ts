import { describe, expect, it, vi } from 'vitest'
import { createPreviewWorkbenchRuntime } from '../workbenchRuntime.ts'

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
})
