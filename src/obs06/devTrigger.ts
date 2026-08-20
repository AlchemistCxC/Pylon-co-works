/**
 * OBS-06：DEV-only 删除错误取证控制台钩子（隔离生产路径）。
 *
 * 仅在 DEV 构建经 main.tsx 动态 import 挂载（生产 `import.meta.env.DEV` 恒 false，分支
 * tree-shake，零暴露）；内部按 IS_TAURI 守卫（浏览器 mock 模式 no-op）。
 *
 * 用法（DevTools Console，DEV 构建 + Tauri 运行时）：
 *   window.__pylonDeleteForensics.trace()              // 当前删除路径 invoke trace
 *   window.__pylonDeleteForensics.diagnose('s1x')      // 只读诊断：readiness + 残留三源
 *                                                      // + P4 判定（不触发删除）
 *   window.__pylonDeleteForensics.stopTrace()          // 停止采集（快照保留）
 *
 * 采集说明：安装时只读包裹 window.__TAURI_INTERNALS__.invoke（与 OBS-05 包裹可组合），
 * 记录删除路径命令（close_session / user_session_delete / evt_append 等）的请求与结算
 * 结果（B1.2 结构化 {code,message}）。真正的删除由用户操作触发，本工具只旁观记录；
 * 动态 import 异步时序可能错过极早 invoke（已知局限，交接文档登记）。
 */

import { IS_TAURI } from '../infrastructure/tauri/env'
import {
  buildDeleteForensicsArtifact,
  createDeleteTrace,
  installDeleteForensicsWrapper,
  type DeleteForensicsArtifact,
  type DeleteTraceSection,
} from './deleteErrorForensics'

export interface Obs06ConsoleApi {
  trace: () => DeleteTraceSection
  diagnose: (sessionId: string) => Promise<DeleteForensicsArtifact>
  stopTrace: () => void
}

export function installObs06DevTrigger(): void {
  if (typeof window === 'undefined') return
  if (!IS_TAURI) return
  const win = window as unknown as { __pylonDeleteForensics?: Obs06ConsoleApi }
  if (win.__pylonDeleteForensics) return // 防重入

  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
  // 包裹前快照 raw invoke：diagnose 的 readiness 探测走 raw（不污染删除路径 trace）
  const rawInvoke = internals?.invoke

  const trace = createDeleteTrace()
  const wrapped = installDeleteForensicsWrapper(trace)

  const api: Obs06ConsoleApi = {
    trace: () => trace.snapshot(),
    diagnose: async (sessionId: string): Promise<DeleteForensicsArtifact> => {
      const storage = typeof localStorage !== 'undefined' ? localStorage : undefined
      if (typeof rawInvoke !== 'function' || !storage) {
        throw new Error('OBS-06 diagnose 需要 Tauri invoke 与 localStorage')
      }
      return buildDeleteForensicsArtifact({
        phase: 'diagnose',
        sessionId,
        transport: { invoke: (cmd, args) => rawInvoke(cmd, args) },
        storage,
        trace: trace.snapshot(),
      })
    },
    stopTrace: () => trace.stop(),
  }
  win.__pylonDeleteForensics = api
  // wrapped 为 false（浏览器 mock / 无 internals）时 trace 恒空——属已知局限
  void wrapped
}
