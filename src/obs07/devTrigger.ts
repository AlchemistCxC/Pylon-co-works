/**
 * OBS-07：DEV-only stderr 样本采集控制台钩子（隔离生产路径）。
 *
 * 仅在 DEV 构建经 main.tsx 动态 import 挂载（生产 `import.meta.env.DEV` 恒 false，分支
 * tree-shake，零暴露）；内部按 IS_TAURI 守卫（浏览器 mock 模式 no-op）。
 *
 * 用法（DevTools Console，DEV 构建 + Tauri 运行时）：
 *   await window.__pylonStderrSamples()              // 采集当前 hub 内 stderr 真实样本（phase=manual）
 *   await window.__pylonStderrSamples('after-crash') // 自定义阶段标注
 *
 * 数据源 = list_runtime_logs 原始 wire（≤2000 条，correlation 完整）——不经前端
 * normalizeRuntimeLogEntry（取证需保留 wire 原始形态，直接核验 hub 内容；LOG-03 起
 * normalize 已保留 correlation，此路径仅为不与 UI 收窄耦合）。
 * 采集为只读：不修改 hub、不触发任何 stderr；对 invoke 的调用仅一次 list_runtime_logs。
 */

import { IS_TAURI } from '../infrastructure/tauri/env'
import { buildStderrSamplesArtifact, type StderrSamplesArtifact, type StderrWireEntry } from './stderrSamples'

export interface Obs07ConsoleApi {
  __pylonStderrSamples: (phase?: string) => Promise<StderrSamplesArtifact>
}

export function installObs07DevTrigger(): void {
  if (typeof window === 'undefined') return
  if (!IS_TAURI) return
  const win = window as unknown as { __pylonStderrSamples?: Obs07ConsoleApi['__pylonStderrSamples'] }
  if (win.__pylonStderrSamples) return // 防重入

  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') return

  const invoke = internals.invoke
  win.__pylonStderrSamples = async (phase = 'manual'): Promise<StderrSamplesArtifact> => {
    const raw = await invoke('list_runtime_logs', {})
    const entries = Array.isArray(raw) ? raw as StderrWireEntry[] : []
    return buildStderrSamplesArtifact({ phase, entries })
  }
}
