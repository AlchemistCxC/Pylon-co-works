/**
 * OBS-05：DEV-only 冷启动快照控制台钩子（隔离生产路径）。
 *
 * 仅在 DEV 构建经 main.tsx 动态 import 挂载（生产 `import.meta.env.DEV` 恒 false，分支
 * tree-shake，零暴露）；内部按 IS_TAURI 守卫（浏览器 mock 模式 no-op）。
 *
 * 用法（DevTools Console）：
 *   window.__pylonColdStartSnapshot()          // 手动抓取当前四域快照（phase=manual）
 *   window.__pylonColdStartSnapshot('after-bootstrap') // 自定义阶段标注
 *   window.__pylonColdStartSnapshot.t0         // 安装时自动抓取的 T0（冷启动早期状态）
 *   window.__pylonColdStartSnapshot.trace()    // 当前 IPC 只读 trace
 *   window.__pylonColdStartSnapshot.stopTrace()// 停止 IPC 采集（快照保留）
 *
 * IPC 采集说明：安装时只读包裹 window.__TAURI_INTERNALS__.invoke，记录 (cmd, args) 后
 * 透传原调用（行为零变化）。动态 import 的异步时序可能错过极早的 bootstrap invoke——
 * 属已知局限，交接文档已登记；store 四域快照不受此影响。
 */

import { IS_TAURI } from '../infrastructure/tauri/env'
import { useIdentityStore } from '../identityStore'
import { useWorkspaceStore } from '../workspaceStore'
import { useRuntimeStore } from '../runtimeStore'
import {
  buildColdStartArtifact,
  createIpcTrace,
  installIpcTraceWrapper,
  type ColdStartArtifact,
  type IpcSection,
} from './coldStartSnapshot'

export interface Obs05ConsoleApi {
  __pylonColdStartSnapshot: (phase?: string) => ColdStartArtifact
  t0?: ColdStartArtifact
  trace: () => IpcSection
  stopTrace: () => void
}

export function installObs05DevTrigger(): void {
  if (typeof window === 'undefined') return
  if (!IS_TAURI) return
  const win = window as unknown as { __pylonColdStartSnapshot?: Obs05ConsoleApi }
  if (win.__pylonColdStartSnapshot) return // 防重入

  const trace = createIpcTrace()
  const wrapped = installIpcTraceWrapper(trace)

  const capture = (phase: string): ColdStartArtifact => buildColdStartArtifact({
    phase,
    workspace: {
      sheets: useWorkspaceStore.getState().workspaceSheets.sheets,
      activeSheetId: useWorkspaceStore.getState().workspaceSheets.activeSheetId,
      recentlyClosed: useWorkspaceStore.getState().workspaceSheets.recentlyClosed,
      sheetAgentStates: useWorkspaceStore.getState().sheetAgentStates,
    },
    identity: {
      activeAgent: useIdentityStore.getState().activeAgent,
      activeProfileId: useIdentityStore.getState().activeProfileId,
      profiles: useIdentityStore.getState().profiles,
      agents: useIdentityStore.getState().agents,
      sessions: useIdentityStore.getState().sessions,
    },
    runtime: {
      agentStatuses: useRuntimeStore.getState().agentStatuses,
      liveGenerating: useRuntimeStore.getState().liveGenerating,
      liveGeneratingSources: useRuntimeStore.getState().liveGeneratingSources,
      approvalMode: useRuntimeStore.getState().approvalMode,
      sessionModes: useRuntimeStore.getState().sessionModes,
      sessionConfig: useRuntimeStore.getState().sessionConfig,
      sessionLiveStats: useRuntimeStore.getState().sessionLiveStats,
    },
    ipcTrace: wrapped ? trace : null,
  })

  const api: Obs05ConsoleApi = {
    __pylonColdStartSnapshot: (phase = 'manual') => capture(phase),
    trace: () => trace.snapshot(),
    stopTrace: () => trace.stop(),
  }
  api.t0 = capture('bootstrap-t0')
  win.__pylonColdStartSnapshot = api
}
