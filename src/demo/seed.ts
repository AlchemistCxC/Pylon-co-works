/**
 * seed — 浏览器模式演示数据种入（非纯接线：store + localStorage，App seed effect 调用）。
 *
 * 内部幂等：agents/状态灯/模式不持久化（agents 来自 list_agents 后端，runtime 是瞬态），
 * 每次启动都必须补；sessions/消息缓存/sheets 持久化（hydrateSessions/openSheet 落盘），
 * 仅首次（sessions 为空）种入——否则二次启动 agents 空 → 主页「没有可用 Agent」。
 * 顺序关键：① setAgents 必须先（内部 loadSheetStateV2+replaceSheets 清 sheets）
 * ② sessions 持久化 ③ 每会话消息缓存（ChatView 恢复 + search 快照可查）
 * ④ sheets（agent 先开聚焦）⑤ setActiveSession（SheetLayout 子 effect 先跑，
 * 写回 effect 随其持久化）⑥ 每次补 runtime 状态灯/模式/权限。
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
  // 每次：agents 非持久化（二次启动 sessions 已持久化、会话种入跳过时仍必须补）
  identity.setAgents(buildDemoAgents())

  // 仅首次（无会话）：种会话/消息缓存/sheets
  if (identity.sessions.length === 0) {
    const sessions = buildDemoSessions()
    useIdentityStore.setState({ sessions, sessionsHydrated: true })
    persistSessions(localStorage, sessions)
    for (const session of sessions) {
      persistMessageSnapshot(session.id, buildDemoMessages(session.id), localStorage)
    }
    const workspace = useWorkspaceStore.getState()
    const agentSheetId = workspace.openSheet({ kind: 'agent', title: 'Peri', agentId: 'peri' })
    // file sheet 绑演示会话 source（singletonKey=file:<source>），打开即见文件树/git/搜索
    workspace.openSheet({ kind: 'file', title: 'File', agentId: 'peri', singletonKey: `file:${sessions[0].source}` })
    workspace.openSheet({ kind: 'gateway', title: 'Gateway' })
    workspace.openSheet({ kind: 'history', title: 'History' })
    workspace.openSheet({ kind: 'runtime', title: 'Runtime' })
    workspace.openSheet({ kind: 'search', title: 'Search' })
    if (agentSheetId) workspace.focusSheet(agentSheetId)
    workspace.setSheetAgentState('peri', { activeProfileId: 'riccati', activeSessionId: sessions[0].id })
    setActiveSession(sessions[0].id)
  }

  // 每次：runtime 状态灯/模式非持久化
  const runtime = useRuntimeStore.getState()
  const periStatus: AgentStatus = { agent: 'peri', agentId: 'peri', status: 'connected', transport: 'qq', cwd: 'G:/work/prism-desktop', lastConnectedAt: Date.now() }
  const hermesStatus: AgentStatus = { agent: 'hermes', agentId: 'hermes', status: 'error', transport: 'webhook', recentError: '心跳超时，等待重连', cwd: 'G:/work/hermes' }
  runtime.setAgentStatus('peri', periStatus)
  runtime.setAgentStatus('hermes', hermesStatus)
  const firstSource = identity.sessions[0]?.source ?? buildDemoSessions()[0].source
  runtime.setSessionMode(firstSource, 'auto')
  if (options.withPermission) {
    runtime.setPermission({ type: 'receive', request: buildDemoPermissionRequest(), now: Date.now() })
  }
}
