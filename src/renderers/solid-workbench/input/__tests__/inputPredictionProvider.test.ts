import { describe, expect, it, vi } from 'vitest'
import { createPredictionRateLimiter } from '../inputPredictionState.ts'
import { boundPredictionHistory, boundPredictionMessages, createHttpPredictionProvider, createPredictionScheduler } from '../inputPredictionProvider.ts'

describe('input prediction provider scheduler', () => {
  it('bounds message payloads at the HTTP boundary, preserving roles and newest context', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).messages).toEqual([
        { role: 'assistant', content: 'new' }, { role: 'user', content: 'go' },
      ])
      return new Response('{}')
    })
    const provider = createHttpPredictionProvider({ endpoint: '/predict', fetch, maxHistoryItems: 2, maxHistoryChars: 5 })
    await provider.predict({ sessionId: 'a', draft: '', history: [], signal: new AbortController().signal,
      messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: ' new ' }, { role: 'user', content: 'go' }],
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([0, 1, 2, 24])('keeps string and role-bearing context selection equivalent (limit %s)', maxHistoryItems => {
    const history = ['one', ' ', '超长'.repeat(20), ' two ', 'three']
    const options = { maxHistoryItems, maxHistoryChars: 8 }
    const messages = history.map(content => ({ role: 'assistant' as const, content }))
    expect(boundPredictionMessages(messages, options).map(item => item.content)).toEqual(boundPredictionHistory(history, options))
    expect(boundPredictionMessages(messages, { maxHistoryChars: 0 })).toEqual([])
    expect(messages.map(item => item.content)).toEqual(history)
  })

  it('arbitrates a shared cooldown when requests actually fire', async () => {
    vi.useFakeTimers()
    try {
      const provider = { predict: vi.fn(async () => 'hint') }
      const limiter = createPredictionRateLimiter(1000)
      const first = createPredictionScheduler(provider, { limiter, debounceMs: 10 })
      const second = createPredictionScheduler(provider, { limiter, debounceMs: 10 })
      first.schedule({ sessionId: 'a', draft: '', history: [] }, () => {})
      second.schedule({ sessionId: 'b', draft: '', history: [] }, () => {})
      await vi.advanceTimersByTimeAsync(10)
      expect(provider.predict).toHaveBeenCalledOnce()
      first.dispose()
      second.dispose()
    } finally { vi.useRealTimers() }
  })

  it('contains synchronous provider failures and accepts the next request', async () => {
    vi.useFakeTimers()
    try {
      const provider = { predict: vi.fn().mockImplementationOnce(() => { throw new Error('offline') }).mockResolvedValue('next') }
      const scheduler = createPredictionScheduler(provider, { limiter: createPredictionRateLimiter(0), debounceMs: 1 })
      const result = vi.fn()
      const request = { sessionId: 'a', draft: '', history: [] }
      scheduler.schedule(request, result)
      await vi.advanceTimersByTimeAsync(1)
      expect(result).not.toHaveBeenCalled()
      scheduler.schedule(request, result)
      await vi.advanceTimersByTimeAsync(1)
      expect(result).toHaveBeenCalledWith('next')
      scheduler.dispose()
    } finally { vi.useRealTimers() }
  })

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
