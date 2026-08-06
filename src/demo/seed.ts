/**
 * seed — 浏览器模式演示数据种入（非纯接线：store + localStorage，App seed effect 调用）。
 *
 * 幂等由调用方保证（App.tsx：IS_TAURI 守卫 + seededRef + sessions 非空跳过）。
 * 顺序关键：① setAgents 必须先（内部 loadSheetStateV2+replaceSheets 清 sheets）
 * ② sessions 持久化 → 下次启动 hydrateSessions 载入 → 幂等 ③ 每会话消息缓存 →
 * ChatView 恢复展示 + search 快照可查 ④ sheets（agent 先开聚焦）⑤ runtime 状态灯/模式
 * ⑥ setActiveSession 最后（SheetLayout 子 effect 先跑，写回 effect 随其持久化）。
 */
import { useIdentityStore } from '../identityStore.ts'
import { useWorkspaceStore } from '../workspaceStore.ts'
import { useRuntimeStore } from '../runtimeStore.ts'
import { persistSessions } from '../sessionPersistence.ts'
import { persistMessageSnapshot } from '../components/chat/messagePersistence.ts'
import { buildDemoAgents, buildDemoMessages, buildDemoPermissionRequest, buildDemoSessions } from './demoData.ts'
import type { AgentStatus } from '../components/settings/agentTypes.ts'

export interface DemoSeedOptions {
  /** ?demo-permission=1 时种一条待审权限请求（弹窗无关闭路径，仅 opt-in 展示） */
  withPermission?: boolean
}

export function seedDemo(setActiveSession: (id: string | null) => void, options: DemoSeedOptions = {}): void {
  const identity = useIdentityStore.getState()
  identity.setAgents(buildDemoAgents())
  const sessions = buildDemoSessions()
  useIdentityStore.setState({ sessions, sessionsHydrated: true })
  persistSessions(localStorage, sessions)
  for (const session of sessions) {
    persistMessageSnapshot(session.id, buildDemoMessages(session.id), localStorage)
  }

  const workspace = useWorkspaceStore.getState()
  const agentSheetId = workspace.openSheet({ kind: 'agent', title: 'Peri', agentId: 'peri' })
  workspace.openSheet({ kind: 'file', title: 'File', agentId: 'peri' })
  workspace.openSheet({ kind: 'gateway', title: 'Gateway' })
  workspace.openSheet({ kind: 'history', title: 'History' })
  workspace.openSheet({ kind: 'runtime', title: 'Runtime' })
  workspace.openSheet({ kind: 'search', title: 'Search' })
  if (agentSheetId) workspace.focusSheet(agentSheetId)
  workspace.setSheetAgentState('peri', { activeProfileId: 'riccati', activeSessionId: sessions[0].id })

  const runtime = useRuntimeStore.getState()
  const periStatus: AgentStatus = { agent: 'peri', agentId: 'peri', status: 'connected', transport: 'qq', cwd: 'G:/work/prism-desktop', lastConnectedAt: Date.now() }
  const hermesStatus: AgentStatus = { agent: 'hermes', agentId: 'hermes', status: 'error', transport: 'webhook', recentError: '心跳超时，等待重连', cwd: 'G:/work/hermes' }
  runtime.setAgentStatus('peri', periStatus)
  runtime.setAgentStatus('hermes', hermesStatus)
  runtime.setSessionMode(sessions[0].source, 'auto')
  if (options.withPermission) {
    runtime.setPermission({ type: 'receive', request: buildDemoPermissionRequest(), now: Date.now() })
  }
  setActiveSession(sessions[0].id)
}
