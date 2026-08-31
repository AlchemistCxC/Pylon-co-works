import { describe, expect, it } from 'vitest'
import { createStreamingDisplayScheduler } from '../streamingDisplayScheduler.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'

function snapshot(overrides: Partial<WorkbenchRuntimeSnapshot> = {}): WorkbenchRuntimeSnapshot {
  return {
    revision: 0, sessionId: 'session-a', ownerKey: 'owner-a', generation: 1,
    status: 'ready', messages: [], streamingText: '', streamingThinking: '',
    generating: false, generationStart: 0, tokenCount: 0, summary: null,
    tasks: [], availableModels: [], activeModel: '', availableModes: [], activeMode: '',
    canAttach: false, promptImage: false, error: null, ...overrides,
  }
}

describe('streaming display scheduler terminal coalescing', () => {
  it('coalesces same-tick terminal metadata updates into one publication', async () => {
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value))
    scheduler.push(snapshot({ generating: true, streamingText: '完成' }))
    scheduler.push(snapshot({ generating: false, streamingText: '完成', summary: { elapsedMs: 20, tokenCount: 1, completedFrame: '', reason: 'done' } }))
    scheduler.push(snapshot({ generating: false, streamingText: '完成', summary: { elapsedMs: 21, tokenCount: 1, completedFrame: '', reason: 'done' } }))

    expect(published).toHaveLength(1)
    await Promise.resolve()
    expect(published).toHaveLength(2)
    expect(published[1]?.summary?.elapsedMs).toBe(21)
    scheduler.dispose()
  })

  it('keeps session switches synchronous', () => {
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value))
    scheduler.push(snapshot({ generating: true }))
    scheduler.push(snapshot({ sessionId: 'session-b', ownerKey: 'owner-b', generating: false }))
    expect(published).toHaveLength(2)
    expect(published[1]?.sessionId).toBe('session-b')
    scheduler.dispose()
  })
})
