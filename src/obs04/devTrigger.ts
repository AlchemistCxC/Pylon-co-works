/**
 * OBS-04：DEV-only 三源导出控制台钩子（隔离生产路径）。
 *
 * 仅在 DEV 构建经 main.tsx 动态 import 挂载（生产构建 `import.meta.env.DEV` 恒 false，
 * 分支 tree-shake，零暴露）；且仅在 Tauri 运行时生效（evt_list / load_persisted_session
 * 依赖后端）。浏览器 mock 模式直接 no-op。
 *
 * 用法（DevTools Console）：
 *   await window.__pylonExportThreeSources()                // 默认：当前激活会话 → 导出并下载
 *   await window.__pylonExportThreeSources('sabc123')       // 指定会话
 *   window.__pylonExportThreeSources.listSessions()         // 列出本地会话 id/名称
 *   await window.__pylonExportThreeSources.collect('sabc123') // 只收集不下载（返回完整工件）
 */

import { IS_TAURI } from '../infrastructure/tauri/env'
import { exportThreeSourcesForSession, type ThreeSourceArtifact } from './threeSourceExport'
import { useIdentityStore } from '../identityStore'
import { useWorkspaceStore } from '../workspaceStore'

export interface Obs04ConsoleApi {
  __pylonExportThreeSources: (sessionId?: string) => Promise<ThreeSourceArtifact['summary']>
  listSessions: () => Array<{ id: string; name?: string; agentId?: string; periId?: string | null; lastActiveAt?: number }>
  collect: (sessionId?: string) => Promise<ThreeSourceArtifact>
}

function resolveSessionId(explicit?: string): string | null {
  if (explicit) return explicit
  const activeAgent = useIdentityStore.getState().activeAgent
  const activeByAgent = useWorkspaceStore.getState().sheetAgentStates[activeAgent]?.activeSessionId
  if (activeByAgent) return activeByAgent
  const sessions = useIdentityStore.getState().sessions
  if (sessions.length === 0) return null
  return [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0].id
}

export function installObs04DevTrigger(): void {
  if (typeof window === 'undefined') return
  if (!IS_TAURI) return
  const win = window as unknown as { __pylonExportThreeSources?: Obs04ConsoleApi }
  if (win.__pylonExportThreeSources) return // 防重入

  const api: Obs04ConsoleApi = {
    __pylonExportThreeSources: async (sessionId) => {
      const { downloadThreeSourceArtifact } = await import('./threeSourceExport')
      const target = resolveSessionId(sessionId)
      if (!target) throw new Error('no session to export: pass an explicit sessionId (see listSessions())')
      const artifact = await api.collect(target)
      downloadThreeSourceArtifact(artifact)
      return artifact.summary
    },
    listSessions: () => useIdentityStore.getState().sessions.map(session => ({
      id: session.id,
      name: session.name,
      agentId: session.agentId,
      periId: session.periId ?? null,
      lastActiveAt: session.lastActiveAt,
    })),
    collect: async (sessionId) => {
      const target = resolveSessionId(sessionId)
      if (!target) throw new Error('no session to collect: pass an explicit sessionId (see listSessions())')
      const { invoke } = await import('@tauri-apps/api/core')
      const transport = {
        invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
      }
      return exportThreeSourcesForSession({
        sessionId: target,
        transport,
        storage: localStorage,
      })
    },
  }
  win.__pylonExportThreeSources = api
}
