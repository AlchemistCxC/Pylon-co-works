import { describe, expect, it } from 'vitest'
import { LEDGER_FAILURE_CAUSES, resolveGenerationLedgerTerminalReason, resolveKernelLiveness } from '../generationLedgerSummary.ts'

/**
 * #99 账本终态 → 摘要 reason 的呈现映射。
 *
 * 这张表的边界就是「不猜」：只映射后端 `TurnTerminalCause` 词表里认得出的 cause，
 * 认不出的一律 `undefined`（维持现状，而不是把失败报成成功、或把成功报成失败）。
 */
describe('resolveGenerationLedgerTerminalReason', () => {
  it('returns done for a completed turn', () => {
    expect(resolveGenerationLedgerTerminalReason({
      source: 'local:s1',
      turn: { phase: 'terminal', terminal: { cause: 'completed', settledAtMs: 10 } },
    })).toBe('done')
  })

  it('returns cancelled for an agent-cancelled turn', () => {
    expect(resolveGenerationLedgerTerminalReason({
      turn: { phase: 'terminal', terminal: { cause: 'cancelled', settledAtMs: 10 } },
    })).toBe('cancelled')
  })

  it('treats emptyTurn as a legal success unless the inner cause is a cancel', () => {
    // 后端语义：EmptyTurn = 成功但无文本（tool-only 回合是合法成功）。
    expect(resolveGenerationLedgerTerminalReason({
      turn: { phase: 'terminal', terminal: { cause: { emptyTurn: { cause: 'toolOnly' } } } },
    })).toBe('done')
    expect(resolveGenerationLedgerTerminalReason({
      turn: { phase: 'terminal', terminal: { cause: { emptyTurn: { cause: 'cancelled' } } } },
    })).toBe('cancelled')
  })

  it('maps the transport and protocol failure causes to error', () => {
    // 迭代生产表本身（不再手工抄一份会腐烂的副本）；集合与 Rust 词表的
    // 对齐由 scripts/acp-vocabulary.test.mts 看守。
    for (const cause of LEDGER_FAILURE_CAUSES) {
      expect(resolveGenerationLedgerTerminalReason({
        turn: { phase: 'terminal', terminal: { cause, settledAtMs: 10 } },
      }), cause).toBe('error')
    }
  })

  it('does not infer settlement from phase alone', () => {
    // 缺 terminal 就是「本回合未收敛」——phase 是过程量，不得反推终态。
    expect(resolveGenerationLedgerTerminalReason({ turn: { phase: 'terminal' } })).toBeUndefined()
    expect(resolveGenerationLedgerTerminalReason({ turn: { phase: 'streaming' } })).toBeUndefined()
    expect(resolveGenerationLedgerTerminalReason({ turn: null })).toBeUndefined()
    expect(resolveGenerationLedgerTerminalReason({})).toBeUndefined()
  })

  it('returns undefined rather than guessing on unrecognised or malformed input', () => {
    expect(resolveGenerationLedgerTerminalReason(null)).toBeUndefined()
    expect(resolveGenerationLedgerTerminalReason(undefined)).toBeUndefined()
    expect(resolveGenerationLedgerTerminalReason('terminal')).toBeUndefined()
    expect(resolveGenerationLedgerTerminalReason([])).toBeUndefined()
    // 词表外的 cause（后端新增变体、或畸形载荷）：不猜。
    expect(resolveGenerationLedgerTerminalReason({
      turn: { phase: 'terminal', terminal: { cause: 'someFutureCause' } },
    })).toBeUndefined()
    expect(resolveGenerationLedgerTerminalReason({
      turn: { phase: 'terminal', terminal: { cause: { two: 'keys' } } },
    })).toBeUndefined()
    expect(resolveGenerationLedgerTerminalReason({ turn: { terminal: {} } })).toBeUndefined()
  })

  it('reads the cause through the ColdMountTurnSnapshot wrapper (the shape refresh receives)', () => {
    // refresh 的入参是 outcome.turn = ColdMountTurnSnapshot（外层带 source/turn），
    // 不是内层 TurnRecord——契约错位会让整条兜底静默失效。
    const snapshot = {
      source: 'local:s1',
      periId: 'p1',
      generation: 1,
      turn: { key: { localSessionId: 'local:s1' }, phase: 'terminal', terminal: { cause: 'completed', settledAtMs: 10 } },
      sequence: {},
      replayLoading: false,
      lastError: null,
    }
    expect(resolveGenerationLedgerTerminalReason(snapshot)).toBe('done')
  })
})

/**
 * #217/ADR-0017：内核在途回合标记 → 活性事实。
 * 同样只做形状守卫：缺字段/畸形一律 undefined（会话层回退 clock 权威，不猜）。
 */
describe('resolveKernelLiveness (#217)', () => {
  it('passes the kernel in-flight fact through the ColdMountTurnSnapshot wrapper', () => {
    expect(resolveKernelLiveness({ turn: { phase: 'prompting' }, turnInFlight: true })).toBe(true)
    expect(resolveKernelLiveness({ turn: null, turnInFlight: false })).toBe(false)
  })

  it('returns undefined when the kernel did not state liveness (legacy kernel / malformed)', () => {
    // 旧内核：快照没有 turnInFlight 字段。
    expect(resolveKernelLiveness({ turn: { phase: 'terminal', terminal: { cause: 'completed' } } })).toBeUndefined()
    expect(resolveKernelLiveness({ turnInFlight: 'yes' })).toBeUndefined()
    expect(resolveKernelLiveness({ turnInFlight: null })).toBeUndefined()
    expect(resolveKernelLiveness(null)).toBeUndefined()
    expect(resolveKernelLiveness('in-flight')).toBeUndefined()
    expect(resolveKernelLiveness([])).toBeUndefined()
    expect(resolveKernelLiveness(undefined)).toBeUndefined()
  })
})
