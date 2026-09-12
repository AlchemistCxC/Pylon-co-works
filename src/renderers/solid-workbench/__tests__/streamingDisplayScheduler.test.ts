import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('streaming scheduler lifecycle and stable metadata', () => {
  const schedulers: ReturnType<typeof createStreamingDisplayScheduler>[] = []
  function setup() {
    vi.useFakeTimers()
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value), { now: () => Date.now() })
    schedulers.push(scheduler)
    return { scheduler, published }
  }
  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose()
    vi.useRealTimers()
  })
  const terminal = () => snapshot({ summary: { elapsedMs: 1, tokenCount: 1, completedFrame: '', reason: 'done' } })

  it('keeps metadata updates on the original message arrays and snapshot', () => {
    const { scheduler, published } = setup()
    const messages = Object.freeze([{ id: 'm1', role: 'assistant' as const, sender: 'test', content: 'text', time: '', running: true }])
    const document = { ...createWorkbenchDocument('session-a'), messages: Object.freeze([]) }
    scheduler.push(snapshot({ generating: true, messages, document }))
    const next = snapshot({ generating: true, messages, document, tokenCount: 9 })
    scheduler.push(next)
    vi.advanceTimersByTime(34)
    expect(published.at(-1)).toBe(next)
    expect(published.at(-1)?.messages).toBe(messages)
    expect(published.at(-1)?.document).toBe(document)
  })

  it.each(['push', 'flush'] as const)('retains %s while paused without publishing, then resumes once', method => {
    const { scheduler, published } = setup()
    scheduler.push(snapshot())
    scheduler.pause()
    const next = snapshot({ sessionId: 'session-b', ownerKey: 'owner-b', tokenCount: 9 })
    scheduler[method](next)
    vi.advanceTimersByTime(1000)
    expect(published).toHaveLength(1)
    scheduler.resume()
    expect(published).toHaveLength(2)
    expect(published.at(-1)).toBe(next)
  })

  it.each(['flush', 'switch', 'resume'] as const)('%s invalidates an already queued terminal publication', async action => {
    const { scheduler, published } = setup()
    scheduler.push(snapshot({ generating: true }))
    scheduler.push(terminal())
    if (action === 'flush') scheduler.flush()
    else if (action === 'switch') scheduler.push(snapshot({ sessionId: 'session-b', ownerKey: 'owner-b' }))
    else { scheduler.pause(); scheduler.resume() }
    expect(published).toHaveLength(2)
    await Promise.resolve()
    expect(published).toHaveLength(2)
  })

  it('does not let an invalidated terminal callback consume a later terminal batch', async () => {
    const { scheduler, published } = setup()
    scheduler.push(snapshot({ generating: true }))
    scheduler.push(terminal())
    scheduler.push(snapshot({ sessionId: 'session-b', ownerKey: 'owner-b', generating: true }))
    scheduler.push({ ...terminal(), sessionId: 'session-b', ownerKey: 'owner-b' })
    await Promise.resolve()
    expect(published).toHaveLength(3)
    expect(published.at(-1)?.sessionId).toBe('session-b')
    expect(published.at(-1)?.generating).toBe(false)
  })

  it('keeps burst pacing and flushes the complete Unicode terminal text', async () => {
    const { scheduler, published } = setup()
    const message = (content: string, running = true) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running })
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    for (let index = 1; index <= 100; index++) scheduler.push(snapshot({ generating: true, messages: [message('👩‍💻'.repeat(index))] }))
    expect(published).toHaveLength(1)
    vi.advanceTimersByTime(34)
    expect(published).toHaveLength(2)
    expect(published[1].messages[0].content).toBe('👩‍💻'.repeat(4))
    const complete = '👩‍💻'.repeat(100)
    scheduler.push({ ...terminal(), messages: [message(complete, false)] })
    await Promise.resolve()
    expect(published.at(-1)?.messages[0].content).toBe(complete)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose discards both timer work and queued terminal work', async () => {
    const { scheduler, published } = setup()
    scheduler.push(snapshot({ generating: true }))
    scheduler.push(terminal())
    scheduler.dispose()
    await Promise.resolve()
    vi.advanceTimersByTime(1000)
    expect(published).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves new work queued reentrantly by a publication listener', () => {
    vi.useFakeTimers()
    const published: string[] = []
    const message = (content: string) => snapshot({ generating: true, messages: [{
      id: 'm1', role: 'assistant', sender: 'test', content, time: '', running: true,
    }] })
    let injected = false
    const scheduler = createStreamingDisplayScheduler(value => {
      const content = value.messages[0].content
      published.push(content)
      if (content === 'ab' && !injected) {
        injected = true
        scheduler.push(message('abcdefghijklmnop'))
      }
    }, { now: () => Date.now() })
    schedulers.push(scheduler)
    scheduler.push(message('a'))
    scheduler.push(message('ab'))
    vi.advanceTimersByTime(1000)
    expect(published.at(-1)).toBe('abcdefghijklmnop')
    expect(vi.getTimerCount()).toBe(0)
  })
})

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
