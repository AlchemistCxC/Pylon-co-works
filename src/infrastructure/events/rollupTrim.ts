/**
 * rollupTrim — #81 L3：应用关闭时的裁剪迁移入口。
 *
 * 前端 pending 清空（kernel 单写者）后即安全窗口；budgetMs 逐 turn 单事务预算，
 * 迁移可暂停 / 续跑（进度落 rollup_migration_state），超时不阻塞关窗——剩余单元
 * 下次关闭继续。`trim_rolledup` 保留策略关闭时后端只报告不删行。
 */
import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI } from '../tauri/env.ts'

export interface RollupTrimReport {
  readonly processedUnits: number
  readonly trimmedUnits: number
  readonly resumedUnits: number
  readonly mismatchUnits: number
  readonly remainingUnits: number
  readonly vacuumed: boolean
  readonly policyBlocked: boolean
}

/** 关闭前运行裁剪迁移；默认总预算 10s（超时即停，下次关闭续跑）。 */
export async function runRollupTrimBeforeClose(deadlineMs = 10_000): Promise<RollupTrimReport | undefined> {
  if (!IS_TAURI) return undefined
  // 硬超时兜底（审核 P1-3）：deadline 循环只在每次 invoke 返回后生效，后端若
  // 单次挂起会卡死关窗流程 ⇒ 整体 Promise.race，超时放弃本次（迁移可续跑，无损）。
  const hardStop = new Promise<undefined>(resolve => {
    const timer = setTimeout(() => resolve(undefined), deadlineMs)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref()
    }
  })
  try {
    return await Promise.race([runTrimLoop(deadlineMs), hardStop])
  } catch {
    // 关闭路径不因裁剪失败阻塞（迁移可续跑；错误不在关窗时呈现）
    return undefined
  }
}

async function runTrimLoop(deadlineMs: number): Promise<RollupTrimReport | undefined> {
  const started = Date.now()
  let last: RollupTrimReport | undefined
  while (Date.now() - started < deadlineMs) {
    last = await invoke<RollupTrimReport>('evt_rollup_trim', { budgetMs: 2_000 })
    if (last.policyBlocked || last.remainingUnits === 0) return last
  }
  return last
}
