/**
 * TransactionResult — Application Transaction 统一返回判别联合（报告阶段 3）。
 *
 * Store 管状态，client 管传输，transaction 管用户动作；事务只返回可判定的结果，
 * 不弹 UI、不吞错误。
 */
export type TransactionResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'blocked' | 'validation' | 'transport' | 'conflict' | 'mismatch'; message: string; cause?: unknown }
