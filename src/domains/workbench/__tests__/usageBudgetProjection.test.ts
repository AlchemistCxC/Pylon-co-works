import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import { projectWorkbench, selectSessionSurface } from '../workbenchProjector.ts'

/**
 * C14 RED：session.usage / budget / config / commands 投影契约（DIC-C14-01）。
 *
 * - usage 区分 input/output/cacheRead/cacheWrite/context/cost/currency；缺失字段 unknown 不伪造 0；
 * - budget 携带 limit/used/remaining/exhausted，百分比是派生值不写 journal；
 * - config/commands 保留 provider 原始条目（raw 宽容），未知 option value 不丢。
 */

const envelope = (sequence: number, event: Parameters<typeof createWorkbenchEnvelope>[0]['event']) =>
  createWorkbenchEnvelope({
    sessionId: 'session-c14',
    sequence,
    recordedAt: `2026-08-23T10:00:0${sequence}.000Z`,
    source: { provider: 'peri', sourceId: `c14-${sequence}` },
    identity: {},
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })

describe('C14 usage/budget/config/commands projection', () => {
  it('narrows partial usage into structured fields without fabricating zeros', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'usage.updated',
        usage: { inputTokens: 120, outputTokens: 80, cacheReadTokens: 40, costUsd: 0.02, currency: 'USD' },
      }),
    ])
    const surface = selectSessionSurface(document)
    const usage = surface.usage as Record<string, unknown>
    expect(usage.inputTokens).toBe(120)
    expect(usage.outputTokens).toBe(80)
    expect(usage.cacheReadTokens).toBe(40)
    expect(usage.costUsd).toBe(0.02)
    // 缺失字段保持 undefined（unknown），不被伪造成 0
    expect(usage.cacheWriteTokens).toBeUndefined()
    expect(usage.contextTokens).toBeUndefined()
  })

  it('derives budget exhaustion state from limit and used without journal duplication', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'budget.warning', used: 900, limit: 1000,
        threshold: 'warning', percent: 90,
      }),
    ])
    const surface = selectSessionSurface(document)
    const budget = (surface.usage as { budget?: Record<string, unknown> }).budget
    expect(budget).toBeDefined()
    expect(budget!.limit).toBe(1000)
    expect(budget!.used).toBe(900)
    expect(budget!.exhausted).toBe(false)
  })

  it('merges partial budget updates and re-derives counters from the latest observed usage', () => {
    const { document } = projectWorkbench([
      envelope(1, { type: 'budget.warning', used: 80, limit: 100, budgetType: 'tokens', resetAt: '2026-09-01T00:00:00Z' }),
      envelope(2, { type: 'budget.warning', used: 100 }),
    ])

    expect(selectSessionSurface(document).usage?.budget).toMatchObject({
      used: 100, limit: 100, remaining: 0, percent: 100, exhausted: true,
      type: 'tokens', resetAt: '2026-09-01T00:00:00Z',
    })
  })
})
