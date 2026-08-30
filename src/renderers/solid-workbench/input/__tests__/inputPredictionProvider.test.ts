import { describe, expect, it, vi } from 'vitest'
import { createPredictionRateLimiter } from '../inputPredictionState.ts'
import { createPredictionScheduler } from '../inputPredictionProvider.ts'

describe('input prediction provider scheduler', () => {
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

