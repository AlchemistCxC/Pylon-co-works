import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STREAMING_DISPLAY_OPTIONS, createStreamingDisplayScheduler } from '../streamingDisplayScheduler.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'
import { createWorkbenchDocument, type WorkbenchMessage } from '../../../domains/workbench/workbenchProjector.ts'

/** 一拍：一个调度器定时器间隔（+1ms 余量，保证恰好走一拍而不会走两拍）。
    刷新率是契约常量，测试不写死毫秒数。 */
const TICK_MS = 1000 / DEFAULT_STREAMING_DISPLAY_OPTIONS.maxUpdatesPerSecond + 1
/** 模拟真实流的到达节奏（与调度器刷新率无关，故意保持 ~33ms/次）。 */
const ARRIVAL_MS = 34

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
    vi.advanceTimersByTime(TICK_MS)
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

  it('reveals a small delta at the typing pace instead of at once', () => {
    const { scheduler, published } = setup()
    const message = (content: string, running = true) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running })
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(20))] }))
    vi.advanceTimersByTime(TICK_MS)
    const revealed = published.at(-1)!.messages[0].content.length
    expect(revealed).toBeGreaterThan(0)
    // A backlog below the lag window must stay on the typing pace, not be
    // published whole (the catch-up window must not collapse to one frame).
    expect(revealed).toBeLessThanOrEqual(Math.round(DEFAULT_STREAMING_DISPLAY_OPTIONS.revealUnitsPerSecond / DEFAULT_STREAMING_DISPLAY_OPTIONS.maxUpdatesPerSecond))
    expect(revealed).toBeLessThan(20)
    vi.advanceTimersByTime(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealLagMs)
    expect(published.at(-1)?.messages[0].content).toBe('x'.repeat(20))
    scheduler.dispose()
  })

  it('paces a burst and converges inside the reveal lag without ever painting one block', async () => {
    const { scheduler, published } = setup()
    const message = (content: string, running = true) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running })
    const grapheme = '👩‍💻'
    const complete = grapheme.repeat(100)
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    for (let index = 1; index <= 100; index++) scheduler.push(snapshot({ generating: true, messages: [message(grapheme.repeat(index))] }))
    expect(published).toHaveLength(1)

    vi.advanceTimersByTime(TICK_MS)
    const firstReveal = published.at(-1)!.messages[0].content
    // A burst is never published as one block...
    expect(firstReveal).not.toBe(complete)
    expect(complete.startsWith(firstReveal)).toBe(true)
    // ...and a reveal step never splits a grapheme cluster.
    expect(firstReveal.length % grapheme.length).toBe(0)

    // No terminal is involved: the backlog still has to converge inside the lag
    // bound, which is what stops "nothing, nothing, …, one whole block".
    vi.advanceTimersByTime(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealLagMs)
    expect(published.at(-1)?.messages[0].content).toBe(complete)
    expect(vi.getTimerCount()).toBe(0)

    // The terminal state lands now (summary, running=false) but its text must
    // not: a finished turn still converges under the same per-frame bound.
    const completeTerminal = grapheme.repeat(200)
    scheduler.push(snapshot({ generating: true, messages: [message(completeTerminal)] }))
    scheduler.push({ ...terminal(), messages: [message(completeTerminal, false)] })
    await Promise.resolve()
    const terminalPublication = published.at(-1)!
    expect(terminalPublication.generating).toBe(false)
    expect(terminalPublication.summary?.reason).toBe('done')
    expect(terminalPublication.messages[0].content).not.toBe(completeTerminal)
    vi.advanceTimersByTime(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealLagMs + 40)
    expect(published.at(-1)?.messages[0].content).toBe(completeTerminal)
    expect(vi.getTimerCount()).toBe(0)
    scheduler.dispose()
  })

  it('resumes under the same bounds instead of painting the background backlog', () => {
    const { scheduler, published } = setup()
    const message = (content: string, running = true) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running })
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    vi.advanceTimersByTime(TICK_MS)
    scheduler.pause()
    scheduler.push(snapshot({ generating: true, tokenCount: 6, messages: [message('x'.repeat(2400))] }))
    scheduler.push(snapshot({ generating: true, tokenCount: 9, messages: [message('x'.repeat(2400))] }))
    vi.advanceTimersByTime(5000)
    const before = published.length

    scheduler.resume(snapshot({ generating: true, tokenCount: 9, messages: [message('x'.repeat(2400))] }))
    expect(published).toHaveLength(before + 1)
    const resumed = published.at(-1)!
    expect(resumed.tokenCount).toBe(9)
    expect(resumed.messages[0].content.length).toBeLessThanOrEqual(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealUnitsPerTick)

    vi.advanceTimersByTime(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealLagMs + 1200)
    expect(published.at(-1)?.messages[0].content).toBe('x'.repeat(2400))
    expect(vi.getTimerCount()).toBe(0)
    scheduler.dispose()
  })

  it('never grows a streaming row by more than the per-frame bound, terminal included', async () => {
    const { scheduler, published } = setup()
    const cap = DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealUnitsPerTick
    const message = (content: string, running = true) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running })
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    // Arrival is far above both the typing pace and the per-frame bound, so a
    // backlog exists at every moment — including when the turn ends.
    const unitsPerArrival = 200
    const arrivals = 60
    for (let index = 1; index <= arrivals; index++) {
      vi.advanceTimersByTime(ARRIVAL_MS)
      scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(index * unitsPerArrival))] }))
    }
    const complete = 'x'.repeat(arrivals * unitsPerArrival)
    expect(published.at(-1)!.messages[0].content.length).toBeLessThan(complete.length)

    scheduler.push({ ...terminal(), messages: [message(complete, false)] })
    await Promise.resolve()
    const lengths = published.map(snapshot => snapshot.messages[0].content.length)
    const growth = lengths.map((length, index) => length - (index === 0 ? 0 : lengths[index - 1]))
    // The whole stream, the terminal publication included: no frame paints a block.
    expect(Math.max(...growth)).toBeLessThanOrEqual(cap)
    expect(published.at(-1)?.generating).toBe(false)
    expect(published.at(-1)?.summary?.reason).toBe('done')

    // The drain needs no further events — the scheduler keeps converging alone.
    vi.advanceTimersByTime(10_000)
    expect(published.at(-1)?.messages[0].content).toBe(complete)
    expect(vi.getTimerCount()).toBe(0)
    scheduler.dispose()
  })

  it('keeps a stream faster than the typing pace within the reveal lag', () => {
    const { scheduler, published } = setup()
    const message = (content: string, running = true) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running })
    const unitsPerArrival = 10
    const arrivalMs = ARRIVAL_MS
    const arrivals = 30
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(unitsPerArrival))] }))
    let worstLag = 0
    for (let index = 2; index <= arrivals; index++) {
      vi.advanceTimersByTime(arrivalMs)
      scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(index * unitsPerArrival))] }))
      worstLag = Math.max(worstLag, index * unitsPerArrival - published.at(-1)!.messages[0].content.length)
    }
    const arrivalPerSecond = unitsPerArrival * 1000 / arrivalMs
    const lagBound = Math.ceil(arrivalPerSecond * DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealLagMs / 1000)
    // ~294 units/s against a 120 units/s typing pace: the visible text has to
    // track the stream, not stop at the baseline and leave the rest for the end.
    expect(worstLag).toBeLessThanOrEqual(lagBound + unitsPerArrival * 2)
    expect(published.at(-1)!.messages[0].content.length).toBeGreaterThan(arrivals * unitsPerArrival - lagBound - unitsPerArrival * 2)
    scheduler.dispose()
  })

  it('publishes a mid-turn segment completion immediately without dumping the backlog', () => {
    const { scheduler, published } = setup()
    const message = (content: string, running = true) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running })
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    for (let index = 1; index <= 40; index++) scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(index * 10))] }))
    vi.advanceTimersByTime(TICK_MS)
    const before = published.at(-1)!.messages[0].content.length
    expect(before).toBeLessThan(400)

    // The segment closes while the turn is still generating (e.g. a tool runs):
    // the new structure must show up now, the unrevealed text must not be dumped.
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(400), false)] }))
    vi.advanceTimersByTime(TICK_MS)
    const last = published.at(-1)!
    expect(last.messages[0].running).toBe(false)
    expect(last.messages[0].content.length).toBeLessThan(400)
    expect(last.messages[0].content.length - before).toBeLessThanOrEqual(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealUnitsPerTick)

    // It still converges without waiting for the terminal flush.
    vi.advanceTimersByTime(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealLagMs)
    expect(published.at(-1)?.messages[0].content).toBe('x'.repeat(400))
    scheduler.dispose()
  })

  it('appends a finished row immediately while its text converges under the lag bound', () => {
    const { scheduler, published } = setup()
    const message = (content: string, running = true) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running })
    const late = (content: string) => ({ id: 'm2', role: 'assistant' as const, sender: 'test', content, time: '', running: false })
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(40))] }))
    vi.advanceTimersByTime(TICK_MS)
    const revealed = published.at(-1)!.messages[0].content.length

    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(40)), late('y'.repeat(400))] }))
    vi.advanceTimersByTime(TICK_MS)
    const appended = published.at(-1)!.messages[1]
    expect(appended?.id).toBe('m2')                                     // the row is visible now
    expect(appended!.content.length).toBeLessThan(400)                  // the text is not dumped
    expect(published.at(-1)!.messages[0].content.length).toBe(revealed) // and nothing retracts

    vi.advanceTimersByTime(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealLagMs)
    expect(published.at(-1)?.messages[1]?.content).toBe('y'.repeat(400))
    scheduler.dispose()
  })

  it('caps one delayed tick so a resumed callback cannot paint the whole backlog at once', () => {
    vi.useFakeTimers()
    let clock = 0
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value), { now: () => clock })
    schedulers.push(scheduler)
    const message = (content: string) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running: true })
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))

    // The window was hidden: one timer fires, but a long wall-clock gap passed.
    clock = 1000
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(4000))] }))
    vi.advanceTimersByTime(1)
    const revealed = published.at(-1)!.messages[0].content.length
    expect(revealed).toBeGreaterThan(0)
    expect(revealed).toBeLessThanOrEqual(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealUnitsPerTick)
    expect(revealed).toBeLessThan(4000)
    scheduler.dispose()
  })

  it('keeps identity resets and list replacement immediate and complete', () => {
    const { scheduler, published } = setup()
    const message = (content: string, running = true) => ({ id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running })
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(400))] }))
    vi.advanceTimersByTime(TICK_MS)
    expect(published.at(-1)!.messages[0].content.length).toBeLessThan(400)

    // A new generation is a reset, not a backlog: it must land whole, at once.
    const reset = snapshot({ generation: 2, generating: true, messages: [message('z'.repeat(400))] })
    scheduler.push(reset)
    expect(published.at(-1)).toBe(reset)

    // A re-keyed row cannot be interpolated either: whole replacement, at once.
    const replaced = snapshot({ generation: 2, generating: true, messages: [{ ...message('q'.repeat(400)), id: 'm2', role: 'reasoning' as const }] })
    scheduler.push(replaced)
    expect(published.at(-1)).toBe(replaced)
    scheduler.dispose()
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
