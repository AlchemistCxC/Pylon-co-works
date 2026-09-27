import { describe, expect, it } from 'vitest'
import {
  ASSIST_PREDICTION_CONSUMED_KEY,
  assistPredictionInstanceKey,
  assistPredictionText,
  consumeAssistPrediction,
  isAssistPredictionConsumed,
} from '../assistPrediction.ts'
import { createSessionUiStore } from '../../sessionUiStore.ts'

describe('#394 assist prediction consumption', () => {
  it('keys an instance by eventId, falling back to its text', () => {
    expect(assistPredictionInstanceKey({ eventId: 'wb-1', placeholder: '继续' })).toBe('wb-1')
    expect(assistPredictionInstanceKey({ placeholder: ' 继续 ' })).toBe('text:继续')
    expect(assistPredictionInstanceKey({ placeholder: '   ' })).toBeUndefined()
    expect(assistPredictionInstanceKey(undefined)).toBeUndefined()
  })

  it('treats a textless frame as no prediction at all', () => {
    // Peri 用 `prediction_ready` 的 set_title 动作发会话标题：空文本不是预测。
    expect(assistPredictionText({ placeholder: '', eventId: 'wb-1' })).toBeUndefined()
    expect(assistPredictionText({ placeholder: '  ' })).toBeUndefined()
    expect(assistPredictionText({ placeholder: ' 继续 ' })).toBe('继续')
    expect(assistPredictionText(undefined)).toBeUndefined()
  })

  it('consumes the current instance only (a new eventId reappears)', () => {
    const store = createSessionUiStore()
    const scope = store.capture('session-a')
    const first = { eventId: 'wb-1', placeholder: '继续' }

    expect(isAssistPredictionConsumed(scope, first)).toBe(false)
    expect(consumeAssistPrediction(scope, first)).toBe(true)
    expect(isAssistPredictionConsumed(scope, first)).toBe(true)

    // 新回合的预测带新身份 ⇒ 不命中旧标记，重新可呈现。
    expect(isAssistPredictionConsumed(scope, { eventId: 'wb-2', placeholder: '继续' })).toBe(false)
    // 另一个会话不受影响（标记 per-session）。
    expect(isAssistPredictionConsumed(store.capture('session-b'), first)).toBe(false)
    store.destroy()
  })

  it('reports nothing to consume when the prediction has no identity', () => {
    const store = createSessionUiStore()
    const scope = store.capture('session-a')
    expect(consumeAssistPrediction(scope, { placeholder: '   ' })).toBe(false)
    expect(scope.get(ASSIST_PREDICTION_CONSUMED_KEY, '')).toBe('')
    store.destroy()
  })
})
