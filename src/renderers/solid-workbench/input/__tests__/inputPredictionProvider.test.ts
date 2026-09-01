import { describe, expect, it, vi } from 'vitest'
import { createPredictionRateLimiter } from '../inputPredictionState.ts'
import { boundPredictionHistory, createHttpPredictionProvider, createPredictionScheduler } from '../inputPredictionProvider.ts'

describe('input prediction provider scheduler', () => {
  it('bounds newest history entries for large durable transcripts', () => {
    expect(boundPredictionHistory(['one', 'two', 'three', 'four'], { maxHistoryItems: 2 })).toEqual(['three', 'four'])
    expect(boundPredictionHistory(['1234', '5678', '9'], { maxHistoryChars: 8 })).toEqual(['5678', '9'])
  })

  it('posts a bounded request and extracts a prediction response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({ sessionId: 's1', draft: '', history: ['new'] })
      return new Response(JSON.stringify({ data: { suggestion: '继续做' } }), { status: 200 })
    })
    const provider = createHttpPredictionProvider({ endpoint: 'http://localhost/predict', fetch, maxHistoryItems: 1 })
    await expect(provider.predict({ sessionId: 's1', generation: 2, draft: '', history: ['old', 'new'], signal: new AbortController().signal }))
      .resolves.toBe('继续做')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns null for aborted, failed, or malformed responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('nope', { status: 503 }))
    const provider = createHttpPredictionProvider({ endpoint: 'http://localhost/predict', fetch })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.predict({ sessionId: 's1', draft: '', history: [], signal: controller.signal })).resolves.toBeNull()
    await expect(provider.predict({ sessionId: 's1', draft: '', history: [], signal: new AbortController().signal })).resolves.toBeNull()

    const malformedFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }))
    const malformed = createHttpPredictionProvider({ endpoint: 'http://localhost/predict', fetch: malformedFetch })
    await expect(malformed.predict({ sessionId: 's1', draft: '', history: [], signal: new AbortController().signal })).resolves.toBeNull()
  })

  it('debounces requests and drops an aborted late result', async () => {
    vi.useFakeTimers()
    try {
      let resolve: ((value: string) => void) | undefined
      const provider = { predict: vi.fn(() => new Promise<string>(done => { resolve = done })) }
      const scheduler = createPredictionScheduler(provider, { debounceMs: 25, limiter: createPredictionRateLimiter(0) })
      const onResult = vi.fn()
      scheduler.schedule({ sessionId: 'a', generation: 1, draft: '', history: [] }, onResult)
      vi.advanceTimersByTime(25)
      await Promise.resolve()
      expect(provider.predict).toHaveBeenCalledTimes(1)
      scheduler.cancel()
      resolve?.('迟到结果')
      await Promise.resolve()
      expect(onResult).not.toHaveBeenCalled()
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('respects the cooldown before scheduling another provider call', () => {
    vi.useFakeTimers()
    try {
      const provider = { predict: vi.fn(async () => 'hint') }
      const scheduler = createPredictionScheduler(provider, { debounceMs: 1, limiter: createPredictionRateLimiter(10_000) })
      scheduler.schedule({ sessionId: 'a', draft: '', history: [] }, () => {})
      vi.advanceTimersByTime(1)
      scheduler.schedule({ sessionId: 'a', draft: '', history: [] }, () => {})
      vi.advanceTimersByTime(1)
      expect(provider.predict).toHaveBeenCalledTimes(1)
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
