import { describe, expect, it } from 'vitest'
import { createPredictionRateLimiter, findHistoryCompletion, mergeHistory, normalizePredictionText } from '../inputPredictionState.ts'

describe('input prediction state', () => {
  it('chooses the newest history message that extends the prefix', () => {
    expect(findHistoryCompletion('继续', ['继续检查', '继续做', '其他'])).toBe('继续做')
    expect(findHistoryCompletion('继续做', ['继续做'])).toBeNull()
    expect(findHistoryCompletion('多\n行', ['多\n行消息'])).toBeNull()
  })

  it('merges durable and local history in order and removes duplicates', () => {
    expect(mergeHistory(['旧消息', '重复'], ['重复', '新消息'])).toEqual(['旧消息', '重复', '新消息'])
  })

  it('limits speculative LLM requests to a cooldown window', () => {
    const limiter = createPredictionRateLimiter(1_000)
    expect(limiter.canRequest(10_000)).toBe(true)
    limiter.markRequested(10_000)
    expect(limiter.canRequest(10_999)).toBe(false)
    expect(limiter.canRequest(11_000)).toBe(true)
  })

  it('filters meta, multiline and oversized provider output', () => {
    expect(normalizePredictionText('继续修复')).toBe('继续修复')
    expect(normalizePredictionText('Let me continue')).toBeNull()
    expect(normalizePredictionText('第一句\n第二句')).toBeNull()
    expect(normalizePredictionText('x'.repeat(121))).toBeNull()
  })
})
