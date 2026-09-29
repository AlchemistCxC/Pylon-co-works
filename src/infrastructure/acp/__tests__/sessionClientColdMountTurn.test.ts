import { describe, expect, it } from 'vitest'
import { normalizeColdMountTurnSnapshot, normalizePersistedSessionLoadResult } from '../sessionClient.ts'

/**
 * #110 F4：冷挂载 turn 快照透传契约。
 *
 * 形状由后端契约测试 `cold_mount_turn_snapshot_exposes_settled_turn_and_cursor`
 * （`src-tauri/src/runtime.rs`）钉定；本文件锁住前端归一化器不再丢弃该字段。
 */

/** 后端 `cold_mount_turn_snapshot` 的真实 wire 形状（照抄 Rust 契约测试的断言值）。 */
const backendTurnSnapshot = {
  source: 'local:c1',
  periId: 'peri-c1',
  generation: 3,
  replayLoading: false,
  sequence: { lastIngressSeq: 0, spill: 0, drop: 0, overloaded: false },
  turn: {
    phase: 'terminal',
    terminal: { cause: 'firstTokenTimeout', detail: 'timeout detail' },
    key: { localSessionId: 'local:c1', remoteSessionId: 'peri-c1', generation: 3, turnId: 5 },
  },
  lastError: null,
}

/** 通过权威恢复链路（load_persisted_session 响应 → 归一化）观察 turn。 */
const normalizeLoad = (turn: unknown) => normalizePersistedSessionLoadResult({
  response: { sessionId: 'peri-c1' },
  replay: [],
  replayMetadata: {
    complete: true,
    truncated: false,
    droppedCount: 0,
    boundary: { kind: 'session-load-response', observedCount: 0, retainedStartOrdinal: null, retainedEndOrdinal: null },
  },
  canonicalRevision: 0,
  replayJournalStatus: 'local-authoritative',
  authority: 'local-journal',
  journalCoverage: 'local-observed',
  collection: { complete: true, truncated: false, droppedCount: 0 },
  diagnostics: [],
  ...(turn === undefined ? {} : { turn }),
})

describe('#110 F4 冷挂载 turn 快照透传', () => {
  it('权威恢复响应携带的 turn 快照原样透传（不再被归一化器丢弃）', () => {
    const result = normalizeLoad(backendTurnSnapshot)
    expect(result.turn).toBeDefined()
    expect(result.turn!.turn).toEqual({
      phase: 'terminal',
      terminal: { cause: 'firstTokenTimeout', detail: 'timeout detail' },
      key: { localSessionId: 'local:c1', remoteSessionId: 'peri-c1', generation: 3, turnId: 5 },
    })
    expect(result.turn!.periId).toBe('peri-c1')
    expect(result.turn!.generation).toBe(3)
    expect(result.turn!.replayLoading).toBe(false)
    expect(result.turn!.sequence).toEqual({ lastIngressSeq: 0, spill: 0, drop: 0, overloaded: false })
    expect(result.turn!.lastError).toBeNull()
  })

  it('后端未给 turn / 形状非法时不产 turn 键（缺失不伪造）', () => {
    expect(normalizeLoad(undefined).turn).toBeUndefined()
    for (const malformed of [null, 'turn', 7, [], true]) {
      expect(normalizeLoad(malformed).turn, `turn=${String(malformed)}`).toBeUndefined()
    }
  })

  it('会话无已知 turn 时后端显式给 null——透传为 null（区别于「字段缺失」）', () => {
    const result = normalizeLoad({ source: 'local:c1', periId: 'peri-c1', generation: 1, turn: null, sequence: { lastIngressSeq: 0 }, replayLoading: false, lastError: null })
    expect(result.turn).toBeDefined()
    expect(result.turn!.turn).toBeNull()
  })

  it('字段级类型守卫：非法子字段丢弃，合法子字段保留（畸形载荷不整体报废）', () => {
    const result = normalizeColdMountTurnSnapshot({
      source: 7,
      periId: 'peri-1',
      generation: -1,
      replayLoading: 'no',
      lastError: 42,
      sequence: 'not-an-object',
      turn: {
        phase: 'terminal',
        terminal: { cause: 9, detail: 'kept' },
        key: { turnId: 5, generation: 'x', localSessionId: '' },
      },
    })
    expect(result).toEqual({
      periId: 'peri-1',
      turn: {
        phase: 'terminal',
        terminal: { detail: 'kept' },
        key: { turnId: 5 },
      },
    })
  })

  it('归一化器键集不变：无 turn 的旧后端响应不新增键（避免下游深相等回归）', () => {
    expect(Object.keys(normalizeLoad(undefined))).not.toContain('turn')
  })
})

/** #442 Step1：load 响应顶层 turnBoundary 的归一化契约。 */
describe('#442 Step1 turnBoundary 逐字段守卫与透传', () => {
  /** 通过权威恢复链路观察 turnBoundary（与 turn 同一响应信封）。 */
  const normalizeWithBoundary = (turnBoundary: unknown) => normalizePersistedSessionLoadResult({
    response: { sessionId: 'peri-c1' },
    replay: [],
    replayMetadata: {
      complete: true,
      truncated: false,
      droppedCount: 0,
      boundary: { kind: 'session-load-response', observedCount: 0, retainedStartOrdinal: null, retainedEndOrdinal: null },
    },
    canonicalRevision: 0,
    replayJournalStatus: 'local-authoritative',
    authority: 'local-journal',
    journalCoverage: 'local-observed',
    collection: { complete: true, truncated: false, droppedCount: 0 },
    diagnostics: [],
    ...(turnBoundary === undefined ? {} : { turnBoundary }),
  })

  it('terminal（两端时间戳）与 open（仅起点）均原样透传', () => {
    expect(normalizeWithBoundary({ kind: 'terminal', startedAtMs: 100, endedAtMs: 250 }).turnBoundary)
      .toEqual({ kind: 'terminal', startedAtMs: 100, endedAtMs: 250 })
    expect(normalizeWithBoundary({ kind: 'open', startedAtMs: 300 }).turnBoundary)
      .toEqual({ kind: 'open', startedAtMs: 300 })
    expect(normalizeWithBoundary({ kind: 'unknown' }).turnBoundary).toEqual({ kind: 'unknown' })
  })

  it('缺失/畸形不留键：非对象、kind 越界一律整体丢弃（缺失不伪造）', () => {
    expect(normalizeWithBoundary(undefined).turnBoundary).toBeUndefined()
    expect(Object.keys(normalizeWithBoundary(undefined))).not.toContain('turnBoundary')
    for (const malformed of [null, 'terminal', 7, [], { kind: 'settled' }, { kind: 7 }]) {
      expect(normalizeWithBoundary(malformed).turnBoundary, `boundary=${JSON.stringify(malformed)}`).toBeUndefined()
    }
  })

  it('畸形时间戳键丢弃而 kind 保留（逐字段降级，不整体报废）', () => {
    expect(normalizeWithBoundary({ kind: 'terminal', startedAtMs: '100', endedAtMs: 250 }).turnBoundary)
      .toEqual({ kind: 'terminal', endedAtMs: 250 })
  })

  it('turn.startedAtMs / terminal.settledAtMs 透传（#442 Step1 判定臂后端化的事实输入）', () => {
    const snapshot = normalizeColdMountTurnSnapshot({
      source: 'local:c1',
      turn: {
        phase: 'terminal',
        startedAtMs: 100,
        terminal: { cause: 'completed', settledAtMs: 250 },
        key: { turnId: 5 },
      },
    })
    expect(snapshot!.turn).toEqual({
      phase: 'terminal',
      startedAtMs: 100,
      terminal: { cause: 'completed', settledAtMs: 250 },
      key: { turnId: 5 },
    })
    // 非法时间戳丢弃、不伪造。
    const malformed = normalizeColdMountTurnSnapshot({ turn: { phase: 'terminal', startedAtMs: 'x', terminal: { settledAtMs: -1 } } })
    expect(malformed!.turn).toEqual({ phase: 'terminal', terminal: {} })
  })
})
