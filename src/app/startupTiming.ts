// 启动相位打点（#269）：release 可用的观测性旁路。
// startupMark 只向进程内相位数组追加一条记录，不参与任何控制流；ready 时
// reportStartupTiming 幂等上报一次，无 Tauri 后端（浏览器模式）或上报失败均
// 静默——权威出口是后端合并出的那条 source="startup" runtime log（前端相位
// 原样透传，后端补记接收时刻）。

import { invoke, isTauri } from '@tauri-apps/api/core'

export interface StartupPhaseMark {
  phase: string
  /** 自页面 timeOrigin 的毫秒数（performance.now() 取整）。 */
  elapsedMs: number
  /** 相位时刻的 Unix epoch 毫秒（与后端相位同钟，便于跨端对齐）。 */
  epochMs: number
}

const phases: StartupPhaseMark[] = []
let reported = false

export function startupMark(phase: string): void {
  phases.push({
    phase,
    elapsedMs: Math.round(performance.now()),
    epochMs: Date.now(),
  })
}

export function startupPhaseMarks(): readonly StartupPhaseMark[] {
  return phases
}

/** ready 时一次性上报（幂等）：仅 Tauri 环境生效，任何失败静默。 */
export function reportStartupTiming(): void {
  if (reported || !isTauri()) return
  reported = true
  void invoke('report_startup_timing', { phases: [...phases] }).catch(() => {})
}
