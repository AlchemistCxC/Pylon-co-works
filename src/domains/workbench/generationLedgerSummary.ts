/**
 * #99 冷挂载 turn 账本的终态 → 生成摘要 reason。
 *
 * 为什么需要这一层：终帧（`pylon:done`/`pylon:error`）只经 per-source IPC Channel
 * 一条路交付——Channel 注册丢失就被前端静默丢弃，没有第二次投递；而账本随
 * `load_persisted_session` 一起回来（`ColdMountTurnSnapshot.turn`），其设计意图正是
 * 「前端不再依赖一次性的 Tauri event」。所以账本是终帧之外唯一的终态证据。
 *
 * 这里只做**呈现映射**：账本说已收敛就是已收敛。cause 词表是后端
 * `acp/turn_ledger.rs::TurnTerminalCause` 的 camelCase 序列化形态——单元变体是字符串，
 * newtype 变体（`EmptyTurn`）是 `{ emptyTurn: {...} }` 对象。
 *
 * 认不出的 cause 返回 `undefined`（不回退猜测）：宁可维持现状，也不把失败报成成功。
 */

export type GenerationLedgerTerminalReason = 'done' | 'cancelled' | 'error'

/** 账本记录的结构子集（容忍畸形输入，不假设后端形状完好）。 */
export interface GenerationLedgerTurn {
  readonly phase?: unknown
  readonly terminal?: { readonly cause?: unknown } | null
}

/**
 * 入参是 `ColdMountTurnSnapshot`——即随 `load_persisted_session` 回来的那一层
 * （`sessionClient.ts` 同名的归一化结果），不是内层 `TurnRecord`：会话无已知 turn
 * 时后端给 `turn: null`，所以必须从外层往下读，不能假设记录一定存在。
 */
export interface GenerationLedgerSnapshot {
  readonly turn?: GenerationLedgerTurn | null
}

/** 后端 `TurnTerminalCause` 的失败侧词表（成功/取消另有分支）。 */
const LEDGER_FAILURE_CAUSES: ReadonlySet<string> = new Set([
  'refusal',
  'maxTurn',
  'firstTokenTimeout',
  'idleTimeout',
  'cancelSettleTimeout',
  'writerTimeout',
  'writerFailed',
  'connectionLost',
  'protocolError',
  'overloaded',
])

function causeTag(cause: unknown): string | undefined {
  if (typeof cause === 'string' && cause.trim()) return cause.trim()
  // newtype 变体的 serde 外部标签形态：单键对象，键名即变体名。
  if (cause !== null && typeof cause === 'object' && !Array.isArray(cause)) {
    const keys = Object.keys(cause)
    if (keys.length === 1) return keys[0]
  }
  return undefined
}

function emptyTurnInnerCause(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== 'object' || Array.isArray(cause)) return undefined
  const inner = (cause as { emptyTurn?: { cause?: unknown } }).emptyTurn
  return inner !== null && typeof inner === 'object' && typeof inner.cause === 'string'
    ? inner.cause
    : undefined
}

/**
 * 已收敛的账本终态 → 摘要 reason。
 *
 * 入参为 `ColdMountTurnSnapshot`（见上）。无 `turn`（会话从无 turn 事实）或无
 * `terminal`（回合仍在途）返回 `undefined`：不从 `phase` 反推——缺 `terminal`
 * 就是「本回合未收敛」。
 */
export function resolveGenerationLedgerTerminalReason(snapshot: unknown): GenerationLedgerTerminalReason | undefined {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined
  const turn = (snapshot as GenerationLedgerSnapshot).turn
  if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) return undefined
  const terminal = (turn as GenerationLedgerTurn).terminal
  if (terminal === null || typeof terminal !== 'object' || Array.isArray(terminal)) return undefined
  const cause = (terminal as { cause?: unknown }).cause
  const tag = causeTag(cause)
  if (tag === undefined) return undefined
  if (tag === 'completed') return 'done'
  if (tag === 'cancelled') return 'cancelled'
  // EmptyTurn 是**合法成功**（tool-only 回合，或取消本身解释了无文本）——不得呈现为失败。
  if (tag === 'emptyTurn') return emptyTurnInnerCause(cause) === 'cancelled' ? 'cancelled' : 'done'
  return LEDGER_FAILURE_CAUSES.has(tag) ? 'error' : undefined
}
