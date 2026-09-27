import { describe, expect, it } from 'vitest'
import {
  deriveCanonicalTurnDuration,
  hasCanonicalTurnTerminal,
  latestTurnBoundary,
  type CanonicalTurnBoundaryEvent,
} from '../../domains/events/canonicalTurnDuration.ts'

const row = (sequence: number, eventType: 'user.message' | 'turn.completed' | 'turn.failed', at: string) => ({
  sequence,
  eventType,
  occurredAt: at,
  receivedAt: at,
})

/** #390：`latestTurnBoundary` 只看边界形态与序号，不读时间戳。 */
const boundary = (sequence: number, eventType: CanonicalTurnBoundaryEvent['eventType']) => ({ sequence, eventType })

describe('deriveCanonicalTurnDuration', () => {
  it('derives the latest completed turn from canonical event timestamps', () => {
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', '2026-09-03T00:00:10.000Z'),
      row(2, 'turn.completed', '2026-09-03T00:00:13.250Z'),
    ])).toEqual({
      elapsedMs: 3250,
      startedAt: Date.parse('2026-09-03T00:00:10.000Z'),
      completedAt: Date.parse('2026-09-03T00:00:13.250Z'),
      source: 'canonical-events',
    })
  })

  it('uses the terminal failure boundary and ignores an earlier turn', () => {
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', '2026-09-03T00:00:01.000Z'),
      row(2, 'turn.completed', '2026-09-03T00:00:02.000Z'),
      row(3, 'user.message', '2026-09-03T00:01:00.000Z'),
      row(4, 'turn.failed', '2026-09-03T00:01:04.500Z'),
    ])).toMatchObject({ elapsedMs: 4500, source: 'canonical-events' })
  })

  it('anchors a turn at the first user chunk rather than the last chunk', () => {
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', '2026-09-03T00:00:10.000Z'),
      row(2, 'user.message', '2026-09-03T00:00:10.500Z'),
      row(3, 'turn.completed', '2026-09-03T00:00:13.000Z'),
    ])?.elapsedMs).toBe(3000)
  })

  it('returns undefined when either boundary timestamp is missing', () => {
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', ''),
      row(2, 'turn.completed', '2026-09-03T00:00:02.000Z'),
    ])).toBeUndefined()
  })

  it('separates a completed turn from whether its duration is measurable', () => {
    expect(hasCanonicalTurnTerminal([
      { eventType: 'turn.completed' },
    ])).toBe(true)
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', ''),
      row(2, 'turn.completed', ''),
    ])).toBeUndefined()
  })
})

/**
 * #390 根因护栏：`hasCanonicalTurnTerminal` 是**回合无关**的（「历史上出现过终态」），
 * 不得用于判定「当前回合是否已收敛」——那会把上一轮的终态行当成本轮的证据，
 * 直接导致在途回合被压成上一轮的 displayOnly 摘要（切页/重读即触发）。
 */
describe('#390 latestTurnBoundary —— 回合作用域的终态判据', () => {
  it('只认最新回合边界：尾行是终态 ⇒ terminal，尾行是新锚点 ⇒ open', () => {
    expect(latestTurnBoundary([
      boundary(1, 'user.message'),
      boundary(2, 'turn.completed'),
    ])).toBe('terminal')

    // 上一轮已终态，但最新边界是**本轮**的 user 锚点 ⇒ 本轮在途。
    // （旧判据在这里返回「有终态证据」，正是塌陷的入口。）
    expect(latestTurnBoundary([
      boundary(1, 'user.message'),
      boundary(2, 'turn.completed'),
      boundary(3, 'user.message'),
    ])).toBe('open')

    // 对照：旧判据对同一份行返回 true，与「本轮已收敛」无关。
    expect(hasCanonicalTurnTerminal([
      boundary(1, 'user.message'),
      boundary(2, 'turn.completed'),
      boundary(3, 'user.message'),
    ])).toBe(true)
  })

  it('无回合边界事件 ⇒ unknown（不猜）', () => {
    expect(latestTurnBoundary([])).toBe('unknown')
    expect(latestTurnBoundary([boundary(1, 'assistant.text.delta')])).toBe('unknown')
  })

  it('turn.unit 与 turn.failed 都算终态边界（compact 读裁剪终端行时的替代证据）', () => {
    expect(latestTurnBoundary([boundary(1, 'user.message'), boundary(2, 'turn.unit')])).toBe('terminal')
    expect(latestTurnBoundary([boundary(1, 'user.message'), boundary(2, 'turn.failed')])).toBe('terminal')
  })

  it('多 chunk 的 user 锚点仍算 open（同一回合的多条 user 行不闭合回合）', () => {
    expect(latestTurnBoundary([
      boundary(1, 'user.message'),
      boundary(2, 'user.message'),
    ])).toBe('open')
  })

  it('同序号畸形输入取锚点：宁可判「未收敛」（终帧可自愈）也不误判「已收敛」（不可逆封存）', () => {
    expect(latestTurnBoundary([
      boundary(1, 'user.message'),
      boundary(1, 'turn.completed'),
    ])).toBe('open')
  })

  it('乱序输入按 sequence 定序，不按数组顺序', () => {
    expect(latestTurnBoundary([
      boundary(3, 'user.message'),
      boundary(2, 'turn.completed'),
    ])).toBe('open')
    expect(latestTurnBoundary([
      boundary(2, 'user.message'),
      boundary(3, 'turn.completed'),
    ])).toBe('terminal')
  })
})
