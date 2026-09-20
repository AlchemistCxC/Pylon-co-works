/**
 * ② 粒度无关性：回合边界推导不得依赖 delta 的行粒度。
 *
 * `deriveCanonicalTurnDuration` / `hasCanonicalTurnTerminal` 只认
 * `user.message` / `turn.completed` / `turn.failed` / `turn.unit`，其余（含一切 delta 行）
 * 一律跳过。这条"跳过"不是实现细节，而是**契约**，因为它是三件事的依据：
 *
 * 1. 把逐 chunk delta 聚合成一条聚合行，在回合时长/终态上安全；
 * 2. L3 裁掉 delta 行后仍能显示处理耗时（compact 读可能只剩 unit 行）；
 * 3. 将来若有人把聚合行类型漏进这个白名单，时长会以聚合行的 `occurredAt` 重算
 *    （聚合行取 run **首条**的时间戳）或终态判定漂移——两者都不报错，只让页脚显示错的秒数。
 */
import { describe, expect, it } from 'vitest'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal } from '../../domains/events/canonicalTurnDuration.ts'
import { END, START, STORAGE_SHAPES, boundary } from './harness.ts'

describe('② 粒度无关性 · 回合边界推导', () => {
  it('四种存储形态产出同一个回合时长', () => {
    const expected = {
      elapsedMs: 12_500,
      startedAt: Date.parse(START),
      completedAt: Date.parse(END),
      source: 'canonical-events',
    }
    for (const [name, rows] of STORAGE_SHAPES) {
      expect(deriveCanonicalTurnDuration(rows), name).toEqual(expected)
    }
  })

  it('四种存储形态的终态判定一致', () => {
    for (const [name, rows] of STORAGE_SHAPES) {
      expect(hasCanonicalTurnTerminal(rows), name).toBe(true)
    }
  })

  it('聚合行不被误认终态或边界（只有聚合行时不得凭空得出回合已结束）', () => {
    expect(deriveCanonicalTurnDuration([
      boundary(1, 'user.message', START),
      boundary(4, 'assistant.text.delta.batch', START),
    ])).toBeUndefined()
    expect(hasCanonicalTurnTerminal([boundary(4, 'assistant.text.delta.batch', START)])).toBe(false)
    expect(hasCanonicalTurnTerminal([boundary(4, 'assistant.thinking.delta.batch', START)])).toBe(false)
  })

  it('起点以首条 user 行锚定（多 user chunk 时不得取末条）', () => {
    const withLaterUser = [
      boundary(1, 'user.message', START),
      boundary(2, 'user.message', END),
      boundary(6, 'assistant.text.delta.batch', START),
      boundary(7, 'turn.completed', END),
    ]
    expect(deriveCanonicalTurnDuration(withLaterUser)).toMatchObject({
      startedAt: Date.parse(START),
      elapsedMs: 12_500,
    })
  })

  it('#199：compact 读形态（仅 unit 行，user 锚点内嵌于 segments）与其它形态产出同一回合时长', () => {
    // evt_load_compact 的真实返回形态：terminal/user 行已被 unit 覆盖（或被 L3 裁剪），
    // 只剩 unit 行 + 未覆盖行；user.message 只作为内嵌 event 段存在。
    const compactReadRows = [
      {
        sequence: 8,
        eventType: 'turn.unit' as const,
        occurredAt: END,
        receivedAt: END,
        typedPayload: {
          segments: [
            { kind: 'event', event: { sequence: 1, eventType: 'user.message', occurredAt: START } },
            { kind: 'delta-run', eventType: 'assistant.text.delta', seqStart: 2, seqEnd: 6, text: '答案', occurredAt: START },
          ],
        },
      },
    ]
    expect(deriveCanonicalTurnDuration(compactReadRows)).toEqual({
      elapsedMs: 12_500,
      startedAt: Date.parse(START),
      completedAt: Date.parse(END),
      source: 'canonical-events',
    })
  })

  it('#199：unit 未内嵌 user 段（或形状异常）时仍不得凭空造时长', () => {
    const noUserInside = [
      {
        sequence: 8,
        eventType: 'turn.unit' as const,
        occurredAt: END,
        receivedAt: END,
        typedPayload: {
          segments: [
            { kind: 'delta-run', eventType: 'assistant.text.delta', seqStart: 2, seqEnd: 7, text: '答案', occurredAt: START },
          ],
        },
      },
    ]
    expect(deriveCanonicalTurnDuration(noUserInside)).toBeUndefined()
    expect(deriveCanonicalTurnDuration([
      { sequence: 8, eventType: 'turn.unit' as const, occurredAt: END, receivedAt: END, typedPayload: 'corrupt' },
    ])).toBeUndefined()
    expect(hasCanonicalTurnTerminal(noUserInside)).toBe(true)
  })
})
