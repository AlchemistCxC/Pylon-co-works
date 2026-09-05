import { describe, expect, it } from 'vitest'
import { createStreamingDisplayScheduler } from '../streamingDisplayScheduler.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'
import { createWorkbenchDocument, type WorkbenchMessage } from '../../../domains/workbench/workbenchProjector.ts'

function snapshot(overrides: Partial<WorkbenchRuntimeSnapshot> = {}): WorkbenchRuntimeSnapshot {
  return {
    revision: 0, sessionId: 'session-a', ownerKey: 'owner-a', generation: 1,
    status: 'ready', messages: [], generating: false, generationStart: 0, tokenCount: 0, summary: null,
    tasks: [], availableModels: [], activeModel: '', availableModes: [], activeMode: '',
    canAttach: false, promptImage: false, error: null, ...overrides,
  }
}

describe('streaming display scheduler terminal coalescing', () => {
  it('never publishes summary with generating=true', async () => {
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value))
    scheduler.push(snapshot({ generating: true }))
    scheduler.push(snapshot({ generating: true, summary: { elapsedMs: 2, tokenCount: 1, completedFrame: '', reason: 'done' } }))
    await Promise.resolve()
    expect(published.at(-1)).toMatchObject({ generating: false, summary: { reason: 'done' } })
    scheduler.dispose()
  })
  it('coalesces same-tick terminal metadata updates into one publication', async () => {
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value))
    scheduler.push(snapshot({ generating: true, messages: [{ id: 'm1', role: 'assistant', sender: 'peri', content: '完成', time: '10:00', running: true }] }))
    scheduler.push(snapshot({ generating: false, messages: [{ id: 'm1', role: 'assistant', sender: 'peri', content: '完成', time: '10:00' }], summary: { elapsedMs: 20, tokenCount: 1, completedFrame: '', reason: 'done' } }))
    scheduler.push(snapshot({ generating: false, messages: [{ id: 'm1', role: 'assistant', sender: 'peri', content: '完成', time: '10:00' }], summary: { elapsedMs: 21, tokenCount: 1, completedFrame: '', reason: 'done' } }))

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

  it('preserves canonical part kinds during a partial reveal', () => {
    let clock = 0
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value), {
      now: () => clock,
      revealUnitsPerSecond: 1,
      maxRevealUnitsPerTick: 1,
    })
    const message = (content: string, parts: WorkbenchMessage['parts'], running: boolean): WorkbenchMessage => ({
      id: 'assistant-1', segmentId: 'segment-1', role: 'assistant', content, parts,
      identity: {}, source: { provider: 'peri', sourceId: 'test' }, sequence: 1, running, time: '',
    })
    const document = (content: string, parts: WorkbenchMessage['parts']): ReturnType<typeof createWorkbenchDocument> => ({
      ...createWorkbenchDocument('session-a'), revision: content.length,
      messages: [message(content, parts, true)],
    })
    scheduler.push(snapshot({ generating: true, document: document('a', [{ kind: 'markdown', text: 'a' }]) }))
    clock = 34
    scheduler.push(snapshot({ generating: true, document: document('a\ncode', [{ kind: 'markdown', text: 'a\n' }, { kind: 'code', text: 'code', language: 'ts' }]) }))
    expect(published[1]?.document?.messages[0]?.parts[0]).toMatchObject({ kind: 'markdown', text: 'a\n' })
    expect(published[1]?.document?.messages[0]?.parts[1]).toBeUndefined()
    scheduler.dispose()
  })

  it('does not retract a longer displayed stream for a shorter in-flight canonical prefix', () => {
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value))
    const message = (content: string) => ({
      id: 'assistant-1', role: 'assistant' as const, content, time: '', sender: 'peri', running: true,
    })
    scheduler.push(snapshot({ generating: true, messages: [message('abcdef')] }))
    scheduler.push(snapshot({ generating: true, messages: [message('abc')] }))
    expect(published.at(-1)?.messages[0]?.content).toBe('abcdef')
    scheduler.dispose()
  })
})
