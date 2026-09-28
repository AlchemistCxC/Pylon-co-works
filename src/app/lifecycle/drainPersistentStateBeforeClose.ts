export interface PersistentStateDrains {
  flushIdentity: () => Promise<void>
}

export interface PersistentDrainOptions {
  timeoutMs?: number
}

export class PersistenceDrainTimeoutError extends Error {
  readonly code = 'persistence_drain_timeout'
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`关闭前持久化在 ${timeoutMs}ms 内未完成`)
    this.name = 'PersistenceDrainTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * 关闭前的持久化 join。#439 起 canonical 自写轨退役（kernel 严格单写者），
 * 前端 pending 恒空，只剩 identity 写穿一条链；失败向窗口生命周期传播，
 * 由上层保持窗口并展示错误。
 */
export async function drainPersistentStateBeforeClose({
  flushIdentity,
}: PersistentStateDrains, { timeoutMs = 15_000 }: PersistentDrainOptions = {}): Promise<void> {
  const drain = Promise.allSettled([
    Promise.resolve().then(flushIdentity),
  ]).then(results => {
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, '关闭前多个持久化分区 drain 失败')
    }
  })
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = globalThis.setTimeout(
      () => reject(new PersistenceDrainTimeoutError(timeoutMs)),
      timeoutMs,
    )
  })
  try {
    await Promise.race([drain, timeout])
  } finally {
    if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle)
  }
}
